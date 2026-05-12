'use strict';
'require baseclass';
'require fs';
'require rpc';

// hwBusy: prevents concurrent HW write operations (mutex)
let hwBusy = false;

// Direct ubus call for iwinfo scan — avoids fs.exec subprocess timeout issues
const callIwInfoScan = rpc.declare({
    object: 'iwinfo',
    method: 'scan',
    params: ['device'],
    expect: { results: [] }
});

// --- helpers ---

function ok(data) {
    return { ok: true, status: 'OK', verified: true, data: data, error: null };
}

function mkErr(reason) {
    return { ok: false, status: 'ERROR', verified: false, data: null, error: reason };
}

function busy() {
    return { ok: false, status: 'BUSY', verified: false, data: null, error: 'busy' };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Parse "key=value" lines into a flat object (hostapd_cli, wpa_cli output)
function parseKv(text) {
    const obj = {};
    for (const line of text.trim().split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
            const k = line.substring(0, eq).trim();
            const v = line.substring(eq + 1).trim();
            obj[k] = v;
        }
    }
    return obj;
}

// Parse UCI show output (-X flag gives machine-readable format)
// Lines: config.section=type  or  config.section.key='value'
// Section type is stored as '.type' to avoid collision with option named 'type'
function parseUciOutput(text) {
    const result = {};
    for (const line of text.trim().split('\n')) {
        if (!line) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const path = line.substring(0, eq);
        let val = line.substring(eq + 1);
        // Multi-value list: 'v1' 'v2' ... contains "' '" between items
        if (val.includes("' '") || val.includes("' \"") || val.includes("\" '")) {
            const items = [];
            const re = /'([^']*)'|"([^"]*)"/g;
            let rm;
            while ((rm = re.exec(val)) !== null)
                items.push(rm[1] !== undefined ? rm[1] : rm[2]);
            val = items;
        } else if (val.startsWith("'") && val.endsWith("'")) {
            val = val.slice(1, -1);
        } else if (val.startsWith('"') && val.endsWith('"')) {
            val = val.slice(1, -1);
        }
        const parts = path.split('.');
        let node = result;
        for (let i = 0; i < parts.length - 1; i++) {
            if (node[parts[i]] === undefined || typeof node[parts[i]] !== 'object')
                node[parts[i]] = {};
            node = node[parts[i]];
        }
        const key = parts[parts.length - 1];
        // config.section=type line (2 parts): store section type as '.type'
        if (parts.length === 2) {
            if (typeof node[key] !== 'object') node[key] = {};
            node[key]['.type'] = val;
        } else {
            node[key] = val;
        }
    }
    return result;
}

// Parse iw dev output into structured object
function parseIwDev(text) {
    const result = {};
    let curPhy = null, curIface = null, curLink = null;

    for (const rawLine of text.split('\n')) {
        let m;

        // phy#N
        if ((m = rawLine.match(/^phy#(\d+)$/))) {
            curPhy = 'phy' + m[1];
            result[curPhy] = { interfaces: {} };
            curIface = null; curLink = null;
            continue;
        }

        if (!curPhy) continue;

        // \tInterface <name>
        if ((m = rawLine.match(/^\tInterface\s+(\S+)$/))) {
            curIface = m[1];
            result[curPhy].interfaces[curIface] = { mld_links: {} };
            curLink = null;
            continue;
        }

        if (!curIface) continue;
        const iface = result[curPhy].interfaces[curIface];

        // MLD link line (starts with spaces + dash)
        if ((m = rawLine.match(/^\s+- link ID\s+(\d+)\s+link addr\s+(\S+)$/))) {
            curLink = parseInt(m[1]);
            iface.mld_links[curLink] = { id: curLink, addr: m[2] };
            continue;
        }

        // Within a link block: channel or txpower (indented with 3+ tabs)
        if (curLink !== null && (m = rawLine.match(/^\t{3,}channel\s+(.+)$/))) {
            iface.mld_links[curLink].channel = m[1];
            continue;
        }
        if (curLink !== null && (m = rawLine.match(/^\t{3,}txpower\s+(.+)$/))) {
            iface.mld_links[curLink].txpower = m[1];
            continue;
        }

        // Back to 2-tab interface level → end link block
        if (rawLine.startsWith('\t\t') && !rawLine.startsWith('\t\t\t') && !rawLine.startsWith('\t\t ')) {
            curLink = null;
        }

        // Interface-level attributes (2 tabs)
        if ((m = rawLine.match(/^\t\tifindex\s+(\d+)$/)))           iface.ifindex = parseInt(m[1]);
        else if ((m = rawLine.match(/^\t\twdev\s+(\S+)$/)))         iface.wdev = m[1];
        else if ((m = rawLine.match(/^\t\taddr\s+(\S+)$/)))         iface.addr = m[1];
        else if ((m = rawLine.match(/^\t\tssid\s+(.+)$/)))          iface.ssid = m[1];
        else if ((m = rawLine.match(/^\t\ttype\s+(.+)$/)))          iface.type = m[1];
        else if ((m = rawLine.match(/^\t\tchannel\s+(.+)$/)))       iface.channel = m[1];
        else if ((m = rawLine.match(/^\t\ttxpower\s+(.+)$/)))       iface.txpower = m[1];
        else if ((m = rawLine.match(/^\t\tRadios:\s+(.+)$/)))       iface.radios = m[1].trim().split(/\s+/).map(Number);
    }
    return result;
}

// --- GROUP 1: UCI functions ---

async function uci_read(config) {
    try {
        // -X: use internal section names (cfg…) matching ubus wireless status keys.
        // Without -X, anonymous sections appear as @type[N] which don't match ubus.
        const res = await fs.exec('/sbin/uci', ['-X', 'show', config]);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(parseUciOutput(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function uci_write(config, section, values) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const parts = [];
        for (const [k, v] of Object.entries(values)) {
            if (v === null)
                parts.push(`{ /sbin/uci -q delete '${config}.${section}.${k}' 2>/dev/null || true; }`);
            else
                parts.push(`/sbin/uci set '${config}.${section}.${k}=${v}'`);
        }
        parts.push(`/sbin/uci commit '${config}'`);
        const res = await fs.exec('/bin/sh', ['-c', parts.join(' && ')]);
        if (res.code !== 0) { hwBusy = false; return mkErr('exec_failed'); }
        // Verify by reading back
        const verify = await fs.exec('/sbin/uci', ['show', `${config}.${section}`]);
        let allMatch = true;
        for (const [k, v] of Object.entries(values)) {
            const present = verify.stdout.includes(`${config}.${section}.${k}=`);
            if (v === null ? present : !present) { allMatch = false; break; }
        }
        hwBusy = false;
        if (!allMatch) return { ok: false, status: 'ERROR', verified: false, data: null, error: 'hw_mismatch' };
        return ok(null);
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function uci_add(config, type) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        // Must run as shell: rpcd uci add doesn't work for wifi-iface
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci add '${config}' '${type}' && /sbin/uci commit '${config}'`
        ]);
        if (res.code !== 0) { hwBusy = false; return mkErr('exec_failed'); }
        const sectionId = res.stdout.trim();
        // Verify the new section exists
        const verify = await fs.exec('/sbin/uci', ['show', `${config}.${sectionId}`]);
        if (verify.code !== 0 || !verify.stdout.includes(sectionId)) {
            hwBusy = false;
            return { ok: false, status: 'ERROR', verified: false, data: null, error: 'hw_mismatch' };
        }
        hwBusy = false;
        return { ok: true, status: 'OK', verified: true, data: { section: sectionId }, error: null };
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function relayd_setup(uplink_net, local_net) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const sid = 'relay_bridge';
        const res = await fs.exec('/bin/sh', ['-c', [
            `/sbin/uci set 'network.${sid}=interface'`,
            `/sbin/uci set 'network.${sid}.proto=relay'`,
            `/sbin/uci -q delete 'network.${sid}.network' 2>/dev/null || true`,
            `/sbin/uci add_list 'network.${sid}.network=${uplink_net}'`,
            `/sbin/uci add_list 'network.${sid}.network=${local_net}'`,
            `/sbin/uci set 'network.${sid}.forward_bcast=1'`,
            `/sbin/uci set 'network.${sid}.forward_dhcp=1'`,
            `/sbin/uci commit network`,
            `/sbin/uci set 'dhcp.lan.ignore=1'`,
            `/sbin/uci commit dhcp`,
            `/etc/init.d/dnsmasq restart`
        ].join(' && ')]);
        hwBusy = false;
        return res.code === 0 ? ok(null) : mkErr('exec_failed');
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function relayd_remove() {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const res = await fs.exec('/bin/sh', ['-c', [
            `/sbin/uci -q delete 'network.relay_bridge'`,
            `/sbin/uci -q delete 'network.relayd_up'`,
            `/sbin/uci commit network`,
            `/sbin/uci -q delete 'dhcp.lan.ignore'`,
            `/sbin/uci commit dhcp`,
            `/etc/init.d/dnsmasq restart`
        ].join('; ')]);
        hwBusy = false;
        return res.code === 0 ? ok(null) : mkErr('exec_failed');
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

// Ensure a named interface section exists in /etc/config/network with proto=dhcp.
// Called when adding a STA wifi-iface to guarantee netifd runs a DHCP client.
async function uci_ensure_network_iface(name) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const check = await fs.exec('/sbin/uci', ['-q', 'get', `network.${name}`]);
        if (check.code === 0) { hwBusy = false; return ok(null); }
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci set 'network.${name}=interface' && ` +
            `/sbin/uci set 'network.${name}.proto=dhcp' && ` +
            `/sbin/uci commit network`
        ]);
        hwBusy = false;
        return res.code === 0 ? ok(null) : mkErr('exec_failed');
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function fw_wan_add_network(name) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const zone = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci show firewall | grep -m1 "\\.name='wan'" | sed "s/\\.name.*//"`
        ]);
        const z = zone.stdout && zone.stdout.trim();
        if (!z) { hwBusy = false; return mkErr('fw_wan_zone_not_found'); }
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci add_list '${z}.network=${name}' && /sbin/uci commit firewall && /etc/init.d/firewall reload`
        ]);
        hwBusy = false;
        return res.code === 0 ? ok(null) : mkErr('exec_failed');
    } catch(e) { hwBusy = false; return mkErr('exec_failed'); }
}

async function fw_wan_remove_network(name) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const zone = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci show firewall | grep -m1 "\\.name='wan'" | sed "s/\\.name.*//"`
        ]);
        const z = zone.stdout && zone.stdout.trim();
        if (!z) { hwBusy = false; return ok(null); }
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci -q del_list '${z}.network=${name}'; /sbin/uci commit firewall && /etc/init.d/firewall reload`
        ]);
        hwBusy = false;
        return res.code === 0 ? ok(null) : mkErr('exec_failed');
    } catch(e) { hwBusy = false; return mkErr('exec_failed'); }
}

async function uci_reorder(config, section, position) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci reorder '${config}.${section}=${position}' && /sbin/uci commit '${config}'`
        ]);
        hwBusy = false;
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(null);
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function uci_delete(config, section) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci delete '${config}.${section}' && /sbin/uci commit '${config}'`
        ]);
        if (res.code !== 0) { hwBusy = false; return mkErr('exec_failed'); }
        // Verify deleted: uci show should return nothing / error
        const verify = await fs.exec('/sbin/uci', ['show', `${config}.${section}`]);
        if (verify.stdout && verify.stdout.trim() !== '') {
            hwBusy = false;
            return { ok: false, status: 'ERROR', verified: false, data: null, error: 'hw_mismatch' };
        }
        hwBusy = false;
        return ok(null);
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function uci_list_add(config, section, key, value) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci add_list '${config}.${section}.${key}=${value}' && /sbin/uci commit '${config}'`
        ]);
        if (res.code !== 0) { hwBusy = false; return mkErr('exec_failed'); }
        const verify = await fs.exec('/sbin/uci', ['show', `${config}.${section}.${key}`]);
        if (!verify.stdout.includes(value)) {
            hwBusy = false;
            return { ok: false, status: 'ERROR', verified: false, data: null, error: 'hw_mismatch' };
        }
        hwBusy = false;
        return ok(null);
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function uci_list_del(config, section, key, value) {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        const res = await fs.exec('/bin/sh', ['-c',
            `/sbin/uci del_list '${config}.${section}.${key}=${value}' && /sbin/uci commit '${config}'`
        ]);
        if (res.code !== 0) { hwBusy = false; return mkErr('exec_failed'); }
        const verify = await fs.exec('/sbin/uci', ['get', `${config}.${section}.${key}`]);
        if (verify.stdout.includes(value)) {
            hwBusy = false;
            return { ok: false, status: 'ERROR', verified: false, data: null, error: 'hw_mismatch' };
        }
        hwBusy = false;
        return ok(null);
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

// --- GROUP 2: ubus functions (read-only, no mutex) ---

async function ubus_wireless_status() {
    try {
        const res = await fs.exec('/bin/ubus', ['call', 'network.wireless', 'status']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(JSON.parse(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function ubus_hostapd_legacy_status(phy, radio_idx) {
    try {
        const ifname = `${phy}.${radio_idx}-ap0`;
        const res = await fs.exec('/bin/ubus', ['call', `hostapd.${ifname}`, 'get_status']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(JSON.parse(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function ubus_iwinfo_info(ifname) {
    try {
        const res = await fs.exec('/bin/ubus', ['call', 'iwinfo', 'info',
            JSON.stringify({ device: ifname })
        ]);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(JSON.parse(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function ubus_iwinfo_devices() {
    try {
        const res = await fs.exec('/bin/ubus', ['call', 'iwinfo', 'devices']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(JSON.parse(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function ubus_network_interface(name) {
    try {
        const res = await fs.exec('/bin/ubus', ['call', `network.interface.${name}`, 'status']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(JSON.parse(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// --- GROUP 3: hostapd_cli functions (read-only, no mutex) ---

async function hostapd_stat(ifname, link) {
    try {
        const args = ['-i', ifname];
        if (link !== null && link !== undefined)
            args.push('-l', String(link));
        args.push('stat');
        const res = await fs.exec('/usr/sbin/hostapd_cli', args);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(parseKv(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// Non-hanging alternative: ubusd returns "Not found" immediately if hostapd is down
async function hostapd_ubus_stat(ifname) {
    try {
        const res = await fs.exec('/bin/ubus', ['call', `hostapd.${ifname}`, 'get_status']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(JSON.parse(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function hostapd_all_sta(ifname) {
    try {
        const res = await fs.exec('/usr/sbin/hostapd_cli', ['-i', ifname, 'all_sta']);
        if (res.code !== 0) return mkErr('exec_failed');
        const stations = [];
        let cur = null;
        for (const line of res.stdout.split('\n')) {
            const trimmed = line.trim();
            if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(trimmed)) {
                if (cur) stations.push(cur);
                cur = { mac: trimmed };
            } else if (cur && trimmed.includes('=')) {
                const eq = trimmed.indexOf('=');
                cur[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
            }
        }
        if (cur) stations.push(cur);
        return ok(stations);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function hostapd_sta(ifname, link, mac) {
    try {
        const args = ['-i', ifname];
        if (link !== null && link !== undefined)
            args.push('-l', String(link));
        args.push('sta', mac);
        const res = await fs.exec('/usr/sbin/hostapd_cli', args);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(parseKv(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// --- GROUP 4: iw functions (read-only, no mutex) ---

async function iw_dev() {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['dev']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok({ raw: res.stdout, interfaces: parseIwDev(res.stdout) });
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// Returns noise floor (dBm) keyed by frequency (MHz) for all active channels.
// One interface is enough — survey dump reports all active freqs on the shared phy.
async function iw_survey_noise() {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['dev', 'phy0.0-ap0', 'survey', 'dump']);
        if (res.code !== 0) return mkErr('exec_failed');
        const result = {};
        let curFreq = null;
        for (const line of res.stdout.split('\n')) {
            const fm = line.match(/frequency:\s*(\d+)\s*MHz.*\[in use\]/);
            if (fm) { curFreq = parseInt(fm[1]); continue; }
            if (curFreq) {
                const nm = line.match(/noise:\s*([-\d]+)\s*dBm/);
                if (nm) { result[curFreq] = parseInt(nm[1]); curFreq = null; }
                else if (line.trim().startsWith('frequency:')) curFreq = null;
            }
        }
        return ok(result);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function iw_station_dump(ifname) {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['dev', ifname, 'station', 'dump']);
        if (res.code !== 0) return mkErr('exec_failed');
        const stations = [];
        let cur = null, curLink = null;
        for (const line of res.stdout.split('\n')) {
            let m;
            if ((m = line.match(/^Station\s+(\S+)\s+\(on\s+(\S+)\)/))) {
                if (cur) stations.push(cur);
                cur = { mac: m[1], iface: m[2], links: {} };
                curLink = null;
            } else if (cur && (m = line.match(/^\tLink\s+(\d+):$/))) {
                curLink = parseInt(m[1]);
                cur.links[curLink] = {};
            } else if (cur && curLink !== null && (m = line.match(/^\t\t(.+?):\s+(.*)$/))) {
                cur.links[curLink][m[1].trim()] = m[2].trim();
            } else if (cur && (m = line.match(/^\t(.+?):\s+(.+)$/))) {
                curLink = null;
                cur[m[1].trim()] = m[2].trim();
            }
        }
        if (cur) stations.push(cur);
        return ok(stations);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function iw_link(ifname) {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['dev', ifname, 'link']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok({ raw: res.stdout.trim() });
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function iwinfo_scan(radio_id) {
    try {
        // 5GHz and 6GHz AP interfaces return empty scan on MT7996 while in EHT mode.
        // Only 2.4GHz (phy0.0-ap0) scan works reliably — always use it.
        const results = await callIwInfoScan('phy0.0-ap0');
        return ok(Array.isArray(results) ? results : []);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function iw_phy_info() {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['phy0', 'info']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok({ raw: res.stdout.trim() });
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function iw_channels() {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['phy0', 'channels']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok({ raw: res.stdout.trim() });
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function iw_reg() {
    try {
        const res = await fs.exec('/usr/sbin/iw', ['reg', 'get']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok({ raw: res.stdout.trim() });
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// --- GROUP 5: wpa_cli functions (read-only, no mutex) ---

async function wpa_status(ifname) {
    try {
        const res = await fs.exec('/usr/sbin/wpa_cli', ['-i', ifname, 'status']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(parseKv(res.stdout));
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function wpa_scan_results(ifname) {
    try {
        const res = await fs.exec('/usr/sbin/wpa_cli', ['-i', ifname, 'scan_results']);
        if (res.code !== 0) return mkErr('exec_failed');
        const results = [];
        const lines = res.stdout.trim().split('\n');
        // First line is header: bssid / frequency / signal level / flags / ssid
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols.length >= 5) {
                results.push({
                    bssid:  cols[0],
                    freq:   parseInt(cols[1]),
                    signal: parseInt(cols[2]),
                    flags:  cols[3],
                    ssid:   cols[4]
                });
            }
        }
        return ok(results);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// --- GROUP 6: sysfs functions (read-only, no mutex) ---

async function sysfs_read(path) {
    try {
        const res = await fs.exec('/bin/cat', [path]);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout.trim());
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function sysfs_thermal() {
    try {
        const res = await fs.exec('/bin/sh', ['-c',
            'for d in /sys/class/thermal/thermal_zone*; do' +
            '  name=$(cat "$d/type" 2>/dev/null);' +
            '  temp=$(cat "$d/temp" 2>/dev/null);' +
            '  [ -n "$name" ] && echo "$name:$temp";' +
            'done'
        ]);
        if (res.code !== 0) return mkErr('exec_failed');
        const zones = {};
        for (const line of res.stdout.trim().split('\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) {
                const name = line.substring(0, colon);
                const temp = parseInt(line.substring(colon + 1));
                zones[name] = temp;
            }
        }
        return ok(zones);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// WiFi chip (mt7996) per-band temperatures via hwmon under phy0 PCIe device.
// Returns { band0: milliC, band1: milliC, band2: milliC } — null fields if unavailable.
async function sysfs_wifi_temp() {
    try {
        const res = await fs.exec('/bin/sh', ['-c',
            'PHY=/sys/devices/platform/soc/11300000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0/ieee80211/phy0;' +
            'for h in "$PHY"/hwmon*/; do' +
            '  name=$(cat "${h}name" 2>/dev/null);' +
            '  temp=$(cat "${h}temp1_input" 2>/dev/null);' +
            '  [ -n "$name" ] && echo "$name:$temp";' +
            'done'
        ]);
        if (res.code !== 0 || !res.stdout.trim()) return ok({ band0: null, band1: null, band2: null });
        const map = {};
        for (const line of res.stdout.trim().split('\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) map[line.substring(0, colon)] = parseInt(line.substring(colon + 1));
        }
        return ok({
            band0: map['mt7996_phy0.0'] ?? null,
            band1: map['mt7996_phy0.1'] ?? null,
            band2: map['mt7996_phy0.2'] ?? null,
        });
    } catch(e) {
        return ok({ band0: null, band1: null, band2: null });
    }
}

async function sysfs_fw_version() {
    try {
        const res = await fs.exec('/bin/cat',
            ['/sys/kernel/debug/ieee80211/phy0/mt76/fw_version']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout.trim());
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function sysfs_sku_disable() {
    try {
        const res = await fs.exec('/bin/cat',
            ['/sys/kernel/debug/ieee80211/phy0/mt76/sku_disable']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout.trim() === '1');
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function sysfs_txpower_info(band_idx) {
    try {
        const path = `/sys/kernel/debug/ieee80211/phy0/mt76/band${band_idx}/txpower_info`;
        const res = await fs.exec('/bin/cat', [path]);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout.trim());
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function sysfs_dfs_status() {
    try {
        const res = await fs.exec('/bin/cat',
            ['/sys/kernel/debug/ieee80211/phy0/dfs_status']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout.trim());
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// Per-link txpower: link N maps to band N on mt76 (single-phy device, ifname not used for path)
async function sysfs_link_txpower(ifname, link_idx) {
    try {
        const path = `/sys/kernel/debug/ieee80211/phy0/mt76/band${link_idx}/txpower_info`;
        const res = await fs.exec('/bin/cat', [path]);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok({ link_idx: link_idx, ifname: ifname, raw: res.stdout.trim() });
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// Read txpower_info for all bands (links 0-2)
async function sysfs_mt76_links_info(ifname) {
    try {
        const bands = [];
        for (let i = 0; i <= 2; i++) {
            const path = `/sys/kernel/debug/ieee80211/phy0/mt76/band${i}/txpower_info`;
            const res = await fs.exec('/bin/cat', [path]);
            bands.push({
                band: i,
                txpower_info: res.code === 0 ? res.stdout.trim() : null
            });
        }
        return ok(bands);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function sysfs_kernel_version() {
    try {
        const res = await fs.exec('/bin/cat', ['/proc/version']);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout.trim());
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// --- GROUP 7: system functions ---

async function system_wifi_restart() {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        // Run wifi reload detached — rpcd returns immediately, reload happens in background.
        // Avoids rpcd timeout and properly tears down MLD interfaces (ubus down/up did not).
        // nohup not available in OpenWrt busybox; subshell + & is sufficient (rpcd has no controlling tty)
        await fs.exec('/bin/sh', ['-c', '( /sbin/wifi reload >/tmp/wifi-reload.log 2>&1 ) &']);
        hwBusy = false;
        return { ok: true, status: 'PENDING_RELOAD', verified: false, data: null, error: null };
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function system_wifi_reload() {
    if (hwBusy) return busy();
    hwBusy = true;
    try {
        await fs.exec('/sbin/wifi', ['reload']);
        const deadline = Date.now() + 15000;
        let verified = false;
        while (Date.now() < deadline) {
            const iw = await fs.exec('/usr/sbin/iw', ['dev']);
            if (iw.code === 0 && iw.stdout.includes('type AP')) {
                verified = true; break;
            }
            await sleep(500);
        }
        hwBusy = false;
        if (!verified)
            return { ok: false, status: 'PENDING_RELOAD', verified: false, data: null, error: 'timeout' };
        return { ok: true, status: 'PENDING_RELOAD', verified: true, data: null, error: null };
    } catch(e) {
        hwBusy = false;
        return mkErr('exec_failed');
    }
}

async function system_reboot() {
    if (hwBusy) return busy();
    // Fire and forget — SSH session will be lost; no verification possible
    try {
        fs.exec('/sbin/reboot', []);
        return { ok: true, status: 'PENDING_REBOOT', verified: false, data: null, error: null };
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function system_logs() {
    try {
        const res = await fs.exec('/sbin/logread', []);
        if (res.code !== 0) return mkErr('exec_failed');
        return ok(res.stdout);
    } catch(e) {
        return mkErr('exec_failed');
    }
}

async function system_exec(cmd, args) {
    try {
        const res = await fs.exec(cmd, Array.isArray(args) ? args : []);
        return {
            ok:       res.code === 0,
            status:   res.code === 0 ? 'OK' : 'ERROR',
            verified: true,
            data:     { code: res.code, stdout: res.stdout, stderr: res.stderr },
            error:    res.code !== 0 ? 'exec_failed' : null
        };
    } catch(e) {
        return mkErr('exec_failed');
    }
}

// --- Module export ---

const Layer1 = {
    // GROUP 1: UCI
    uci_read,
    uci_write,
    uci_add,
    uci_ensure_network_iface,
    relayd_setup,
    relayd_remove,
    fw_wan_add_network,
    fw_wan_remove_network,
    uci_reorder,
    uci_delete,
    uci_list_add,
    uci_list_del,
    // GROUP 2: ubus
    ubus_wireless_status,
    ubus_hostapd_legacy_status,
    ubus_iwinfo_info,
    ubus_iwinfo_devices,
    ubus_network_interface,
    // GROUP 3: hostapd_cli
    hostapd_stat,
    hostapd_ubus_stat,
    hostapd_all_sta,
    hostapd_sta,
    // GROUP 4: iw
    iw_dev,
    iw_station_dump,
    iw_link,
    iwinfo_scan,
    iw_phy_info,
    iw_channels,
    iw_reg,
    // GROUP 5: wpa_cli
    wpa_status,
    wpa_scan_results,
    // GROUP 6: sysfs
    sysfs_read,
    iw_survey_noise,
    sysfs_thermal,
    sysfs_wifi_temp,
    sysfs_fw_version,
    sysfs_sku_disable,
    sysfs_txpower_info,
    sysfs_dfs_status,
    sysfs_link_txpower,
    sysfs_mt76_links_info,
    sysfs_kernel_version,
    // GROUP 7: system
    system_wifi_restart,
    system_wifi_reload,
    system_reboot,
    system_logs,
    system_exec
};

return baseclass.extend(Layer1);
