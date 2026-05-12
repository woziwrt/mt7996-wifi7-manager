'use strict';
'require baseclass';
'require wifimgr/layer1 as layer1';

// Layer 2: semantic layer. Calls Layer 1 only — never UCI/iw/hostapd directly.
// Owns all validation rules, raw-output parsing, and data structure definitions.

// layer1 is injected by LuCI's module loader via 'require wifimgr/layer1'

// --- HELPERS ---

function l2ok(data)  { return { ok: true,  data, error: null }; }
function l2err(msg)  { return { ok: false, data: null, error: msg }; }

function uciBool(v)  { return v === '1' || v === true; }
function uciInt(v)   { return (v !== undefined && v !== null && v !== '') ? parseInt(v) : null; }

// Always return an array — handles UCI string, array, or space-separated tokens
function toArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return String(v).trim().split(/\s+/).filter(Boolean);
}

// eht_oper_chwidth → MHz  (spec section 4.3)
const EW_TO_MHZ = { 0: 20, 1: 40, 2: 80, 3: 160, 9: 320 };
function ewToMhz(ew) { return EW_TO_MHZ[parseInt(ew)] ?? null; }

// MHz → IEEE channel number
function freqToChannel(freq) {
    if (!freq) return null;
    if (freq >= 2412 && freq <= 2472) return (freq - 2407) / 5;
    if (freq === 2484) return 14;
    if (freq >= 5160 && freq < 5950) return (freq - 5000) / 5;
    if (freq >= 5950 && freq <= 7125) return (freq - 5950) / 5;
    return null;
}

// Count set bits (for antenna mask from iw phy info)
function popcount(n) {
    let c = 0, v = (typeof n === 'string' && n.startsWith('0x'))
        ? parseInt(n, 16) : (parseInt(n) || 0);
    while (v) { c += v & 1; v >>>= 1; }
    return c;
}

// Parse per-band antenna counts from iw phy info raw text.
// Returns array [count_2g, count_5g, count_6g] indexed by radio (0/1/2).
// Uses antenna_mask + Frequency Range pairs in iw phy output.
function parseAntennaCountPerBand(raw) {
    const counts = [null, null, null];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const mm = lines[i].match(/antenna_mask:\s+(0x[\da-f]+)/i);
        if (!mm) continue;
        const count = popcount(mm[1]);
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const fm = lines[j].match(/Frequency Range:\s+(\d+)\s+MHz/);
            if (!fm) continue;
            const minFreq = parseInt(fm[1]);
            if (minFreq < 3000)       counts[0] = count; // 2.4 GHz → radio0
            else if (minFreq < 5900)  counts[1] = count; // 5 GHz   → radio1
            else                      counts[2] = count; // 6 GHz   → radio2
            break;
        }
    }
    return counts;
}

// Parse integer dBm from sysfs txpower_info raw or "3.00 dBm" strings.
// MT7988A format: "MU TX Power (Auto / Manual): 26 / 0 [0.5 dBm]" — values in 0.5 dBm units.
function parseTxpowerDbm(raw) {
    if (!raw) return null;
    let m = raw.match(/MU\s+TX\s+Power\s+\([^)]+\):\s*(\d+)/i);
    if (m) return Math.round(parseInt(m[1]) * 0.5);
    m = raw.match(/(?:Tx|TX)\s+Power[:\s]+(\d+(?:\.\d+)?)/i);
    if (m) return Math.round(parseFloat(m[1]));
    m = String(raw).match(/^(\d+(?:\.\d+)?)\s*dBm/);
    if (m) return Math.round(parseFloat(m[1]));
    return null;
}

// Encryption sets used in validation
const WPA3_ENC  = new Set(['sae', 'owe', 'sae-mixed', 'sae-ext', 'sae-ext-mixed']);
const ENC_6G_OK = new Set(['sae', 'owe', 'sae-ext']);

// sysfs_sku_disable result → sku_active bool
// sku_disable=0 means regulation is active (sku_active=true)
function toSkuActive(skuRes) {
    return skuRes.ok ? !skuRes.data : null;
}

// Build a sid→ifname map from ubus wireless status
function buildIfnameMap(ubusData) {
    const map = {};
    for (const radioInfo of Object.values(ubusData)) {
        for (const entry of (radioInfo.interfaces || [])) {
            if (entry.section && entry.ifname)
                map[entry.section] = entry.ifname;
        }
    }
    return map;
}

// Parse channel bandwidth string from iw dev: "20 MHz" → 20, "160 MHz" → 160, "320 MHz" → 320
function parseBwMhz(chanStr) {
    const m = chanStr && chanStr.match(/width:\s+(\d+)\s+MHz/);
    return m ? parseInt(m[1]) : null;
}

// Parse bitrate string from iw link raw ("tx bitrate: 3241.9 MBit/s ...")
function parseBitrate(raw, dir) {
    const re = dir === 'tx' ? /tx bitrate:\s+(.+)/i : /rx bitrate:\s+(.+)/i;
    const m = raw && raw.match(re);
    return m ? m[1].trim() : null;
}

// --- BLOCK 1: radio ---

async function radio_get_all() {
    const [uciRes, ubusRes, skuRes, phyRes, iwDevRes, noiseRes] = await Promise.all([
        layer1.uci_read('wireless'),
        layer1.ubus_wireless_status(),
        layer1.sysfs_sku_disable(),
        layer1.iw_phy_info(),
        layer1.iw_dev(),
        layer1.iw_survey_noise()
    ]);
    if (!uciRes.ok) return l2err('uci_read failed');

    const wData    = uciRes.data.wireless || {};
    const ubusData = ubusRes.ok ? ubusRes.data : {};
    const antCounts = phyRes.ok ? parseAntennaCountPerBand(phyRes.data.raw || '') : [null, null, null];
    const skuActive = toSkuActive(skuRes);
    const noiseByFreq = noiseRes.ok ? noiseRes.data : {};

    // Build ifname→txpower map from iw dev (most accurate source)
    const iwTxpower = {};
    if (iwDevRes.ok) {
        for (const phyData of Object.values(iwDevRes.data.interfaces || {})) {
            for (const [iname, idata] of Object.entries(phyData.interfaces || {})) {
                if (idata.txpower) {
                    const m = idata.txpower.match(/^(\d+(?:\.\d+)?)/);
                    if (m) iwTxpower[iname] = Math.round(parseFloat(m[1]));
                }
            }
        }
    }

    const radios = [];
    for (const [id, sec] of Object.entries(wData)) {
        if (sec['.type'] !== 'wifi-device') continue;

        const ri = uciInt(sec.radio) ?? parseInt(id.replace('radio', ''));

        // Find actual legacy AP ifname from ubus (auto-incremented suffix, not always ap0)
        let legacyIf = null;
        for (const entry of ((ubusData[id] && ubusData[id].interfaces) || [])) {
            if (!entry.ifname || !entry.section) continue;
            const sec2 = wData[entry.section];
            if (sec2 && !uciBool(sec2.mlo) && sec2.mode !== 'sta') { legacyIf = entry.ifname; break; }
        }
        if (!legacyIf) legacyIf = `phy0.${ri}-ap0`;

        const hRes = await layer1.hostapd_stat(legacyIf, null);
        const h    = hRes.ok ? hRes.data : {};

        // txpower_actual: iw dev (real HW value) → hostapd max_txpower fallback
        const txActual = iwTxpower[legacyIf] ?? (h.max_txpower ? parseInt(h.max_txpower) : null);

        radios.push({
            id,
            band:             sec.band   || null,
            channel:          sec.channel === 'auto' ? 'auto' : uciInt(sec.channel),
            htmode:           sec.htmode  || null,
            country:          sec.country || null,
            sku_idx:          sec.sku_idx !== undefined ? uciInt(sec.sku_idx) : null,
            disabled:         uciBool(sec.disabled),
            noscan:           uciBool(sec.noscan),
            background_radar: uciBool(sec.background_radar),
            txpower_uci:      sec.txpower !== undefined ? uciInt(sec.txpower) : null,
            txpower_mode:     sec.txpower_mode || (sec.txpower !== undefined ? 'manual' : 'regdb'),
            lpi_psd:          sec.lpi_psd          !== undefined ? uciBool(sec.lpi_psd)          : null,
            lpi_bcn_enhance:  sec.lpi_bcn_enhance  !== undefined ? uciBool(sec.lpi_bcn_enhance)  : null,
            lpi_sku_idx:      sec.lpi_sku_idx      !== undefined ? uciInt(sec.lpi_sku_idx)        : null,
            he_twt_responder: sec.he_twt_responder !== undefined ? uciBool(sec.he_twt_responder) : null,
            legacy_rates:     sec.legacy_rates     !== undefined ? uciBool(sec.legacy_rates)     : null,
            sr_enable:        sec.sr_enable        !== undefined ? uciBool(sec.sr_enable)        : null,
            etxbfen:          sec.etxbfen          !== undefined ? uciBool(sec.etxbfen)          : null,
            up:               ubusData[id] ? ubusData[id].up === true : false,
            freq:             h.freq          ? parseInt(h.freq)            : null,
            chan_util:        h.chan_util_avg !== undefined ? (parseInt(h.chan_util_avg) <= 100 ? parseInt(h.chan_util_avg) : null) : null,
            noise:            h.freq ? (noiseByFreq[parseInt(h.freq)] ?? null) : null,
            sku_active:       skuActive,
            txpower_actual:   txActual,
            antenna_count:    antCounts[ri] ?? null
        });
    }

    return l2ok(radios);
}

async function radio_get(id) {
    const res = await radio_get_all();
    if (!res.ok) return res;
    const r = res.data.find(r => r.id === id);
    return r ? l2ok(r) : l2err(`radio not found: ${id}`);
}

async function radio_set(id, params) {
    const errors = [], warnings = [];

    const write = Object.assign({}, params);
    delete write.txantenna;
    delete write.rxantenna;

    if (write.disabled === '1' || write.disabled === 1 || write.disabled === true)
        warnings.push('Disabling radio changes MLD topology; re-enable requires power cycle');

    // txpower_mode must not be set per-radio — use system_set_txpower_mode()
    delete write.txpower_mode;

    // country → reboot required; ensure sku_idx='0' written alongside UNLESS efuse_max mode
    // (efuse_max requires sku_idx absent — writing '0' would silently switch back to regdb)
    let restartRequired = 'wifi';
    if ('country' in write) {
        restartRequired = 'reboot';
        if (!('sku_idx' in write)) {
            const curRes = await layer1.uci_read('wireless');
            const curMode = curRes.ok ? ((curRes.data.wireless || {})[id] || {}).txpower_mode : null;
            if (curMode !== 'efuse_max') write.sku_idx = '0';
        }
    }

    if (errors.length) return { ok: false, restartRequired: 'none', errors, warnings };

    const wRes = await layer1.uci_write('wireless', id, write);
    if (!wRes.ok) return { ok: false, restartRequired: 'none', errors: ['uci_write failed'], warnings };

    return { ok: true, restartRequired, errors: [], warnings };
}

// System-wide TX power mode — writes txpower_mode + sku_idx to all 3 radios simultaneously.
// regdb:     sku_idx='0' (driver applies country SKU table), clears txpower
// efuse_max: sku_idx=null (driver skips SKU table → eFuse limits, ignores iw txpower), clears txpower
// manual:    sku_idx='0' (required — driver only respects iw txpower cap when SKU table active),
//            preserves per-radio txpower (set via radio cards)
async function system_set_txpower_mode(mode) {
    const errors = [];
    for (const rid of ['radio0', 'radio1', 'radio2']) {
        const write = { txpower_mode: mode };
        if (mode === 'efuse_max') {
            write.sku_idx = null;   // delete — driver uses eFuse max directly
            write.txpower = null;
            write.lpi_sku_idx = null;
        } else {
            write.sku_idx = '0';    // regdb or manual: SKU table must be active
            if (mode !== 'manual') {
                write.txpower = null;
                write.lpi_sku_idx = null;
            }
        }
        const res = await layer1.uci_write('wireless', rid, write);
        if (!res.ok) { errors.push('uci_write failed: ' + rid); break; }
    }
    if (errors.length) return { ok: false, restartRequired: 'none', errors };
    return { ok: true, restartRequired: 'reboot', errors: [] };
}

async function radio_get_channels(id) {
    const [chRes, dfsRes] = await Promise.all([
        layer1.iw_channels(),
        layer1.sysfs_dfs_status()
    ]);
    if (!chRes.ok) return l2err('iw_channels failed');
    const channels = parseIwChannels(chRes.data.raw || '');
    if (dfsRes.ok) annotateDfsState(channels, dfsRes.data);
    return l2ok(channels);
}

function parseIwChannels(raw) {
    const channels = [];
    for (const line of raw.split('\n')) {
        const m = line.match(/\*\s+(\d+)\s+MHz\s+\[(\d+)\]/);
        if (m) {
            channels.push({
                freq:        parseInt(m[1]),
                channel:     parseInt(m[2]),
                dfs:         line.includes('radar detection') || line.includes('DFS'),
                dfs_state:   line.includes('DFS-usable')   ? 'usable'   :
                             line.includes('DFS-unavail')  ? 'unavailable' :
                             line.includes('disabled')     ? 'disabled'    : 'available',
                max_txpower: null
            });
        }
        const txm = line.match(/Maximum TX power:\s+(\d+(?:\.\d+)?)\s+dBm/);
        if (txm && channels.length) channels[channels.length - 1].max_txpower = parseFloat(txm[1]);
    }
    return channels;
}

// Overwrite dfs_state using authoritative per-channel data from sysfs dfs_status
function annotateDfsState(channels, raw) {
    for (const line of raw.split('\n')) {
        const m = line.match(/Channel\s*=\s*(\d+),\s*DFS_state\s*=\s*(\w+)/i);
        if (!m) continue;
        const ch = parseInt(m[1]);
        const state = m[2].toLowerCase();
        const entry = channels.find(c => c.channel === ch);
        if (entry) entry.dfs_state = state;
    }
}

// --- BLOCK 2: iface ---

async function iface_get_all() {
    const [uciRes, ubusRes] = await Promise.all([
        layer1.uci_read('wireless'),
        layer1.ubus_wireless_status()
    ]);
    if (!uciRes.ok) return l2err('uci_read failed');

    const wData   = uciRes.data.wireless || {};
    const ubusMap = ubusRes.ok ? buildIfnameMap(ubusRes.data) : {};
    const ifaces  = [];

    for (const [sid, sec] of Object.entries(wData)) {
        if (sec['.type'] !== 'wifi-iface') continue;

        const device = toArray(sec.device);
        const mode   = sec.mode || 'ap';
        const ifname = ubusMap[sid] || null;

        // Runtime status from hostapd or wpa_cli
        let status = 'DISABLED';
        if (ifname) {
            if (mode === 'ap') {
                const hRes = await layer1.hostapd_stat(ifname, null);
                if (hRes.ok && hRes.data.state) status = hRes.data.state;
            } else if (mode === 'sta') {
                const wpRes = await layer1.wpa_status(ifname);
                if (wpRes.ok && wpRes.data.wpa_state)
                    status = wpRes.data.wpa_state === 'COMPLETED' ? 'ENABLED' : wpRes.data.wpa_state;
            }
        }

        ifaces.push({
            sid,
            device,
            mode,
            mlo:        uciBool(sec.mlo),
            wds:        sec.wds === '1',
            repeater:   sec.repeater === '1',
            ifname,
            ssid:       sec.ssid       || null,
            encryption: sec.encryption || 'none',
            key:        sec.key        || null,
            network:    sec.network    || null,
            hidden:     uciBool(sec.hidden),
            isolate:    uciBool(sec.isolate),
            wmm:        sec.wmm !== undefined ? uciBool(sec.wmm) : true,
            maxassoc:   sec.maxassoc   !== undefined ? uciInt(sec.maxassoc) : null,
            status
        });
    }

    return l2ok(ifaces);
}

async function iface_get(sid) {
    const res = await iface_get_all();
    if (!res.ok) return res;
    const iface = res.data.find(i => i.sid === sid);
    return iface ? l2ok(iface) : l2err(`iface not found: ${sid}`);
}

async function iface_set(sid, params) {
    const errors = [], warnings = [];
    const write = Object.assign({}, params);

    const ifaceRes = await iface_get(sid);
    const cur = ifaceRes.ok ? ifaceRes.data : null;
    const device = cur ? cur.device : [];
    const has6G = device.includes('radio2');
    const enc = write.encryption || (cur ? cur.encryption : null);

    // Validation: 6G → sae/owe only
    if (has6G && enc && !ENC_6G_OK.has(enc))
        errors.push('6 GHz interface requires sae or owe encryption');

    // Validation: MLD with 6G → sae/owe only
    if (cur && cur.mlo && has6G && enc && !ENC_6G_OK.has(enc))
        errors.push('MLD with 6 GHz link requires sae or owe encryption');

    // Destructive warning: mlo toggle
    if ('mlo' in write)
        warnings.push('MLD MAC will change; connected clients will be disconnected');

    if (errors.length) return { ok: false, errors, warnings };

    // Silent fix: WPA3 requires ieee80211w=2
    if (enc && WPA3_ENC.has(enc) && !('ieee80211w' in write))
        write.ieee80211w = '2';

    const wRes = await layer1.uci_write('wireless', sid, write);
    if (!wRes.ok) return { ok: false, errors: ['uci_write failed'], warnings };
    return { ok: true, errors: [], warnings };
}

async function iface_add(radio_id, mode, params) {
    const errors = [];
    const write = Object.assign({}, params, { device: radio_id, mode });

    if (params.ssid && mode !== 'sta') {
        const uciRes = await layer1.uci_read('wireless');
        if (uciRes.ok) {
            for (const sec of Object.values(uciRes.data.wireless || {})) {
                if (sec['.type'] === 'wifi-iface' && sec.ssid === params.ssid)
                    return { ok: false, sid: null, errors: ['SSID "' + params.ssid + '" already exists'] };
            }
        }
    }

    const has6G = radio_id === 'radio2';
    const enc = write.encryption;
    if (has6G && enc && !ENC_6G_OK.has(enc))
        errors.push('6 GHz interface requires sae or owe encryption');
    if (errors.length) return { ok: false, sid: null, errors };

    // Silent fix: WPA3 requires ieee80211w=2; 6 GHz SAE requires sae_pwe=2 (H2E)
    if (enc && WPA3_ENC.has(enc) && !('ieee80211w' in write))
        write.ieee80211w = '2';
    if (enc && WPA3_ENC.has(enc) && has6G && !('sae_pwe' in write))
        write.sae_pwe = '2';
    if (has6G && !('mbo' in write))
        write.mbo = '1';
    if (has6G && !('assocresp_elements' in write))
        write.assocresp_elements = 'dd07000ce700000000';

    const addRes = await layer1.uci_add('wireless', 'wifi-iface');
    if (!addRes.ok) return { ok: false, sid: null, errors: ['uci_add failed'] };

    const sid = addRes.data.section;
    const wRes = await layer1.uci_write('wireless', sid, write);
    if (!wRes.ok) {
        await layer1.uci_delete('wireless', sid);
        return { ok: false, sid: null, errors: ['uci_write failed: ' + (wRes.error || 'unknown')] };
    }

    // For STA: ensure the target network interface exists in /etc/config/network
    // so netifd starts a DHCP client for the uplink.
    if (mode === 'sta') {
        const netName = write.network || 'wwan';
        await layer1.uci_ensure_network_iface(netName);
    }

    // On 6G, push any MLO section to end so wizard AP becomes non-tx BSS #1
    // (non-tx #2 is rejected by iOS; non-tx #1 works)
    if (has6G) {
        const uciR = await layer1.uci_read('wireless');
        if (uciR.ok) {
            for (const [secId, sec] of Object.entries(uciR.data.wireless || {})) {
                const devList = Array.isArray(sec.device) ? sec.device : [sec.device];
                if (sec['.type'] === 'wifi-iface' && sec.mlo === '1' && devList.includes('radio2'))
                    await layer1.uci_reorder('wireless', secId, 99);
            }
        }
    }

    return { ok: true, sid, errors: [] };
}

async function iface_remove(sid) {
    const ifaceRes = await iface_get(sid);
    const warning = (ifaceRes.ok && ifaceRes.data.mlo)
        ? 'Removing MLD interface disconnects all clients on all linked bands' : null;

    const delRes = await layer1.uci_delete('wireless', sid);
    return { ok: delRes.ok, warning };
}

async function iface_get_runtime(ifname) {
    const devRes = await layer1.iw_dev();
    if (!devRes.ok) return l2err('iw_dev failed');

    let ifData = null;
    for (const [, phyData] of Object.entries(devRes.data)) {
        if (phyData.interfaces && phyData.interfaces[ifname]) {
            ifData = phyData.interfaces[ifname];
            break;
        }
    }
    if (!ifData) return l2err(`interface not found: ${ifname}`);

    const isMld = Object.keys(ifData.mld_links || {}).length > 0;

    if (ifData.type === 'AP') {
        const hRes = await layer1.hostapd_stat(ifname, null);
        return hRes.ok ? l2ok({ type: isMld ? 'mld_ap' : 'legacy_ap', state: hRes.data }) : l2err('hostapd_stat failed');
    } else {
        const wpRes = await layer1.wpa_status(ifname);
        return wpRes.ok ? l2ok({ type: isMld ? 'mld_sta' : 'legacy_sta', state: wpRes.data }) : l2err('wpa_status failed');
    }
}

// --- BLOCK 3: mld ---

async function mld_get_all() {
    const [uciRes, ubusRes, iwDevRes] = await Promise.all([
        layer1.uci_read('wireless'),
        layer1.ubus_wireless_status(),
        layer1.iw_dev()
    ]);
    if (!uciRes.ok) return l2err('uci_read failed');

    const wData   = uciRes.data.wireless || {};
    const ubusMap = ubusRes.ok ? buildIfnameMap(ubusRes.data) : {};

    // Build per-interface per-link txpower and bw_mhz maps from iw dev MLD link data
    const iwLinkTxp = {};
    const iwLinkBw  = {};
    if (iwDevRes.ok) {
        for (const phyData of Object.values(iwDevRes.data.interfaces || {})) {
            for (const [iname, idata] of Object.entries(phyData.interfaces || {})) {
                const lks = idata.mld_links || {};
                for (const [li, lkData] of Object.entries(lks)) {
                    const idx = parseInt(li);
                    if (lkData.txpower) {
                        const m = lkData.txpower.match(/^(\d+(?:\.\d+)?)/);
                        if (m) {
                            if (!iwLinkTxp[iname]) iwLinkTxp[iname] = {};
                            iwLinkTxp[iname][idx] = Math.round(parseFloat(m[1]));
                        }
                    }
                    if (lkData.channel) {
                        const bw = parseBwMhz(lkData.channel);
                        if (bw !== null) {
                            if (!iwLinkBw[iname]) iwLinkBw[iname] = {};
                            iwLinkBw[iname][idx] = bw;
                        }
                    }
                }
            }
        }
    }

    const mlds    = [];

    for (const [sid, sec] of Object.entries(wData)) {
        if (sec['.type'] !== 'wifi-iface' || !uciBool(sec.mlo)) continue;

        const ifname  = sec.ifname || ubusMap[sid] || null;
        const radios  = toArray(sec.device);
        const isSta   = sec.mode === 'sta';

        // MLD-level stat (AP only — STA uses wpa_supplicant, not hostapd)
        let statData = {};
        if (ifname && !isSta) {
            const hRes = await layer1.hostapd_stat(ifname, null);
            if (hRes.ok) statData = hRes.data;
        }

        let links = [];
        if (isSta && ifname) {
            // MLO STA: link data from "iw dev <ifname> link" (wpa_supplicant path)
            const linkRes = await layer1.iw_link(ifname);
            if (linkRes.ok) {
                links = parseStaMldLinks(linkRes.data.raw).map(function(lk) {
                    const li = lk.link_id;
                    if (iwLinkTxp[ifname] && iwLinkTxp[ifname][li] != null) lk.txpower = iwLinkTxp[ifname][li];
                    if (iwLinkBw[ifname]  && iwLinkBw[ifname][li]  != null) lk.bw_mhz  = iwLinkBw[ifname][li];
                    lk.channel    = freqToChannel(lk.freq);
                    lk.dfs_active = false;
                    lk.chan_util  = null;
                    return lk;
                });
                // Fallback: single-link connection (no MLD Link ID lines but "Connected to" present)
                if (links.length === 0 && /Connected to/i.test(linkRes.data.raw)) {
                    const fm  = linkRes.data.raw.match(/freq:\s+(\d+)/);
                    const sm  = linkRes.data.raw.match(/signal:\s+([-\d.]+)/);
                    const bwm = linkRes.data.raw.match(/width:\s+(\d+)\s+MHz/);
                    const freq = fm ? parseInt(fm[1]) : null;
                    links = [{ link_id: 0, bssid: null, freq,
                               channel: freqToChannel(freq), bw_mhz: bwm ? parseInt(bwm[1]) : null,
                               txpower: null, signal: sm ? parseFloat(sm[1]) : null,
                               dfs_active: false, chan_util: null }];
                }
            }
        } else {
            const numLinks = statData.num_links ? parseInt(statData.num_links) : radios.length;
            for (let li = 0; li < numLinks; li++) {
                const lRes = await (ifname ? layer1.hostapd_stat(ifname, li) : Promise.resolve({ ok: false }));

                const ld  = lRes.ok ? lRes.data : {};
                // Prefer actual HW txpower from iw dev MLD link; fall back to hostapd max_txpower
                let txp = (iwLinkTxp[ifname] && iwLinkTxp[ifname][li] != null) ? iwLinkTxp[ifname][li] : null;
                if (txp === null && ld.max_txpower) txp = parseInt(ld.max_txpower);

                // bw_mhz: iw dev link string is authoritative; hostapd eht_oper_chwidth as fallback
                let bwMhz = (iwLinkBw[ifname] && iwLinkBw[ifname][li] != null) ? iwLinkBw[ifname][li] : null;
                if (bwMhz === null && ld.eht_oper_chwidth !== undefined) bwMhz = ewToMhz(ld.eht_oper_chwidth);

                links.push({
                    link_id:    li,
                    freq:       ld.freq             ? parseInt(ld.freq)              : null,
                    channel:    ld.channel          ? parseInt(ld.channel)           : null,
                    bw_mhz:     bwMhz,
                    txpower:    txp,
                    chan_util:  ld.chan_util_avg     !== undefined ? parseInt(ld.chan_util_avg)   : null,
                    dfs_active: ld.dfs_active       ? uciBool(ld.dfs_active)        : false,
                    bssid:      ld['bssid[0]'] || ld.bssid || null
                });
            }
        }

        mlds.push({
            sid,
            ifname,
            mode:               sec.mode               || 'ap',
            ssid:               sec.ssid               || null,
            encryption:         sec.encryption         || 'none',
            key:                sec.key                || null,
            network:            sec.network            || null,
            isolate:            uciBool(sec.isolate),
            mld_addr:           statData['mld_addr[0]'] || sec.mld_addr || null,
            mld_allowed_links:  sec.mld_allowed_phy_bitmap !== undefined ? uciInt(sec.mld_allowed_phy_bitmap) :
                                sec.mld_allowed_links      !== undefined ? uciInt(sec.mld_allowed_links)      : null,
            eml_disable:        uciBool(sec.eml_disable),
            radios,
            links,
            ap_mld_type:        statData.ap_mld_type   || null,
            num_links:          statData.num_links ? parseInt(statData.num_links) : links.length
        });
    }

    return l2ok(mlds);
}

async function mld_get(sid) {
    const res = await mld_get_all();
    if (!res.ok) return res;
    const mld = res.data.find(m => m.sid === sid);
    return mld ? l2ok(mld) : l2err(`mld not found: ${sid}`);
}

async function mld_set(sid, params) {
    const errors = [];
    const write = Object.assign({}, params);

    const cur = await mld_get(sid);
    const radios = cur.ok ? cur.data.radios : [];
    const isSta  = cur.ok ? cur.data.mode === 'sta' : false;
    const enc = write.encryption || (cur.ok ? cur.data.encryption : null);

    // 6G enc restriction applies to AP only (beacon); STA connects to whatever the AP offers
    if (!isSta && radios.includes('radio2') && enc && !ENC_6G_OK.has(enc))
        errors.push('MLD with 6 GHz link requires sae or owe encryption');
    if (errors.length) return { ok: false, errors };

    // Silent fix: WPA3 requires ieee80211w=2
    if (enc && WPA3_ENC.has(enc) && !('ieee80211w' in write))
        write.ieee80211w = '2';

    const wRes = await layer1.uci_write('wireless', sid, write);
    if (!wRes.ok) return { ok: false, errors: ['uci_write failed'] };
    return { ok: true, errors: [] };
}

async function mld_add(radio_ids, params) {
    const errors = [];

    if (!Array.isArray(radio_ids) || radio_ids.length < 2) {
        errors.push('MLD requires at least 2 radios');
        return { ok: false, sid: null, errors };
    }

    if (params.ssid) {
        const uciRes = await layer1.uci_read('wireless');
        if (uciRes.ok) {
            for (const sec of Object.values(uciRes.data.wireless || {})) {
                if (sec['.type'] === 'wifi-iface' && sec.ssid === params.ssid)
                    return { ok: false, sid: null, errors: ['SSID "' + params.ssid + '" already exists'] };
            }
        }
    }

    const enc = params.encryption;
    if (radio_ids.includes('radio2') && enc && !ENC_6G_OK.has(enc)) {
        errors.push('MLD with 6 GHz link requires sae or owe encryption');
        return { ok: false, sid: null, errors };
    }

    const addRes = await layer1.uci_add('wireless', 'wifi-iface');
    if (!addRes.ok) return { ok: false, sid: null, errors: ['uci_add failed'] };
    const sid = addRes.data.section;

    const write = Object.assign({}, params, { mlo: '1', mode: 'ap' });
    delete write.device;
    if (enc && WPA3_ENC.has(enc) && !('ieee80211w' in write))
        write.ieee80211w = '2';
    if (enc && WPA3_ENC.has(enc) && radio_ids.includes('radio2') && !('sae_pwe' in write))
        write.sae_pwe = '2';

    const wRes = await layer1.uci_write('wireless', sid, write);
    if (!wRes.ok) return { ok: false, sid: null, errors: ['uci_write failed'] };

    for (const rid of radio_ids) {
        const lRes = await layer1.uci_list_add('wireless', sid, 'device', rid);
        if (!lRes.ok) return { ok: false, sid: null, errors: [`uci_list_add failed for ${rid}`] };
    }

    return { ok: true, sid, errors: [] };
}

async function mld_remove(sid) {
    const delRes = await layer1.uci_delete('wireless', sid);
    return {
        ok: delRes.ok,
        warning: 'Removing MLD interface disconnects all clients on all linked bands'
    };
}

// --- BLOCK 4: clients ---

async function clients_get_all() {
    const devRes = await layer1.iw_dev();
    if (!devRes.ok) return l2err('iw_dev failed');

    const clients = [];
    const seen    = new Set();

    for (const phyData of Object.values(devRes.data.interfaces || {})) {
        for (const [ifname, ifData] of Object.entries(phyData.interfaces || {})) {
            if (ifData.type !== 'AP') continue;

            const [dumpRes, allStaRes] = await Promise.all([
                layer1.iw_station_dump(ifname),
                layer1.hostapd_all_sta(ifname)
            ]);
            if (!dumpRes.ok || !dumpRes.data.length) continue;

            // Index hostapd flags by MAC
            const staFlags = {};
            if (allStaRes.ok) {
                for (const sta of allStaRes.data)
                    staFlags[sta.mac.toLowerCase()] = sta;
            }

            for (const sta of dumpRes.data) {
                const mac = sta.mac.toLowerCase();
                if (seen.has(mac)) continue;
                seen.add(mac);

                // Per-link signal is in "signal: -47 [-51, -47] dBm" format
                // Aggregate without brackets is always 0 for MLD — discard it
                let signal = null;
                const sigStr = sta['signal'] || '';
                const perLinkM = sigStr.match(/(-?\d+)\s*\[/);
                const plainM   = sigStr.match(/^(-?\d+)/);
                if (perLinkM)     signal = parseInt(perLinkM[1]);
                else if (plainM)  signal = parseInt(plainM[1]);

                // Per-link entries from iw_station_dump links object
                const links = Object.entries(sta.links || {}).map(([lid, ldata]) => ({
                    link_id:    parseInt(lid),
                    mac:        ldata['address'] || null,
                    signal:     ldata['signal'] ? parseInt(ldata['signal']) : null,
                    tx_bitrate: ldata['tx bitrate'] || null,
                    rx_bitrate: ldata['rx bitrate'] || null
                }));

                clients.push({
                    mac:            sta.mac,
                    ifname:         sta.iface || ifname,
                    is_mld:         links.length > 0,
                    flags:          extractClientFlags(staFlags[mac]),
                    signal,
                    tx_bitrate:     sta['tx bitrate']     || null,
                    rx_bitrate:     sta['rx bitrate']     || null,
                    connected_time: sta['connected time'] ? parseInt(sta['connected time']) : null,
                    links
                });
            }
        }
    }

    return l2ok(clients);
}

function extractClientFlags(staData) {
    if (!staData) return [];
    const flags = [];
    if (staData.eht_capab || staData.eht_capab_info || staData.eht_supported === '1') flags.push('EHT');
    if (staData.he_capab  || staData.he_supported  === '1')                           flags.push('HE');
    if (staData.vht_capab)                                                             flags.push('VHT');
    return flags;
}

async function clients_get_by_iface(ifname) {
    const res = await clients_get_all();
    if (!res.ok) return res;
    return l2ok(res.data.filter(c => c.ifname === ifname));
}

async function clients_deauth(ifname, mac) {
    const res = await layer1.system_exec(
        '/usr/sbin/hostapd_cli', ['-i', ifname, 'deauthenticate', mac]
    );
    const ok = res.ok && (res.data.stdout || '').trim() === 'OK';
    return { ok, data: null, error: ok ? null : 'exec_failed' };
}

// --- BLOCK 5: uplink (STA) ---

async function uplink_get_all() {
    const [uciRes, devRes] = await Promise.all([
        layer1.uci_read('wireless'),
        layer1.iw_dev()
    ]);
    if (!uciRes.ok) return l2err('uci_read failed');

    const wData  = uciRes.data.wireless || {};
    // Build map of runtime STA interfaces from iw_dev
    const staIfaces = buildStaIfaceMap(devRes.ok ? devRes.data : {});
    const uplinks = [];

    for (const [sid, sec] of Object.entries(wData)) {
        if (sec['.type'] !== 'wifi-iface' || sec.mode !== 'sta') continue;

        const is_mlo   = uciBool(sec.mlo);
        const radioIds = toArray(sec.device);

        // Find runtime ifname: MLO STA → sta-mld*, legacy STA → phy0.N-sta0
        const ifname = is_mlo
            ? (staIfaces.mlo || null)
            : (staIfaces.legacy[radioIds[0]] || null);

        if (!ifname) continue; // STA not up

        const [wpRes, linkRes, dumpRes, netRes] = await Promise.all([
            layer1.wpa_status(ifname),
            layer1.iw_link(ifname),
            layer1.iw_station_dump(ifname),
            layer1.ubus_network_interface(sec.network || 'wwan')
        ]);

        const wp      = wpRes.ok   ? wpRes.data  : {};
        const linkRaw = linkRes.ok ? linkRes.data.raw : '';

        // Signal: per-link value preferred over aggregate
        let signal = null;
        if (dumpRes.ok && dumpRes.data.length) {
            const s = dumpRes.data[0]['signal'] || '';
            const m = s.match(/(-?\d+)\s*\[/);
            if (m) signal = parseInt(m[1]);
            else { const m2 = s.match(/^(-?\d+)/); if (m2) signal = parseInt(m2[1]); }
        }

        // IP address: wpa_status first, then ubus network interface
        let ip = wp.ip_address || null;
        if (!ip && netRes.ok) {
            const addrs = netRes.data.ipv4_address || [];
            if (addrs.length) ip = addrs[0].address || null;
        }

        // Per-link data for MLO STA: base from iw link (freq/bssid), enriched from station dump (signal/bitrate/bw)
        let links = is_mlo ? parseStaMldLinks(linkRaw) : [];
        if (is_mlo && dumpRes.ok && dumpRes.data.length) {
            const staLinks = dumpRes.data[0].links || {};
            links = links.map(lk => {
                const sd = staLinks[lk.link_id];
                if (!sd) return lk;
                const sigStr = sd['signal'] || '';
                const sigM   = sigStr.match(/(-?\d+)\s*\[/) || sigStr.match(/^(-?\d+)/);
                const txStr  = sd['tx bitrate'] || '';
                const rxStr  = sd['rx bitrate'] || '';
                const bwM    = txStr.match(/(\d+)MHz/) || rxStr.match(/(\d+)MHz/);
                return Object.assign({}, lk, {
                    signal:     sigM ? parseInt(sigM[1]) : null,
                    tx_bitrate: txStr || null,
                    rx_bitrate: rxStr || null,
                    bw_mhz:     lk.bw_mhz || (bwM ? parseInt(bwM[1]) : null)
                });
            });
        }

        uplinks.push({
            sid,
            ifname,
            radio_ids:      radioIds,
            is_mlo,
            ssid:           wp.ssid       || sec.ssid  || null,
            bssid:          wp.bssid      || null,
            ap_mld_addr:    is_mlo ? (wp.ap_mld_addr || null) : null,
            wpa_state:      wp.wpa_state  || 'DISCONNECTED',
            wifi_generation: wp.wifi_generation ? parseInt(wp.wifi_generation) : null,
            signal,
            tx_bitrate:     parseBitrate(linkRaw, 'tx'),
            rx_bitrate:     parseBitrate(linkRaw, 'rx'),
            ip_address:     ip,
            channel_width:  wp.channel_width ? parseInt(wp.channel_width) : null,
            links
        });
    }

    return l2ok(uplinks);
}

// Build { mlo: 'sta-mld0', legacy: { radio0: 'phy0.0-sta0', ... } } from iw_dev data
function buildStaIfaceMap(iwData) {
    const map = { mlo: null, legacy: {} };
    for (const phyData of Object.values((iwData && iwData.interfaces) || {})) {
        for (const [iname, idata] of Object.entries(phyData.interfaces || {})) {
            const t = (idata.type || '').toLowerCase();
            if (t !== 'managed') continue;
            if (Object.keys(idata.mld_links || {}).length > 0 || iname.startsWith('sta-mld')) {
                map.mlo = iname;
            } else {
                // phy0.N-sta0 → map to radioN
                const m = iname.match(/phy0\.(\d+)-sta/);
                if (m) map.legacy[`radio${m[1]}`] = iname;
            }
        }
    }
    return map;
}

// Parse per-link BSSID/freq from "iw dev sta-mld0 link" raw output
function parseStaMldLinks(raw) {
    const links = [];
    const lines = raw ? raw.split('\n') : [];
    for (let i = 0; i < lines.length; i++) {
        const lm = lines[i].match(/Link\s+(\d+)\s+BSSID\s+(\S+)/i);
        if (!lm) continue;
        const link = { link_id: parseInt(lm[1]), bssid: lm[2], freq: null, channel: null, bw_mhz: null, txpower: null };
        for (let j = i + 1; j < lines.length && j < i + 6; j++) {
            if (lines[j].match(/Link\s+\d+\s+BSSID/i)) break;
            const fm = lines[j].match(/freq:\s+(\d+)/);
            if (fm) link.freq = parseInt(fm[1]);
            const bwm = lines[j].match(/width:\s+(\d+)\s+MHz/);
            if (bwm) link.bw_mhz = parseInt(bwm[1]);
            const txm = lines[j].match(/tx power:\s+(\d+(?:\.\d+)?)/i);
            if (txm) link.txpower = Math.round(parseFloat(txm[1]));
        }
        links.push(link);
    }
    return links;
}

async function uplink_scan(radio_id) {
    const scanRes = await layer1.iwinfo_scan(radio_id);
    if (!scanRes.ok) return l2err('iwinfo_scan failed');
    if (scanRes.data.length === 0) return l2ok([]);

    return l2ok(scanRes.data
        .filter(bss => bss.ssid)
        .map(bss => ({
            ssid:       bss.ssid,
            bssid:      bss.bssid,
            signal:     bss.signal ?? null,
            quality:    bss.quality ?? 0,
            quality_max: bss.quality_max ?? 70,
            channel:    bss.channel ?? null,
            mhz:        bss.mhz ?? null,
            band:       bss.band ?? null,
            mode:       bss.mode ?? null,
            encryption: classifyScanEnc(bss.encryption),
            ht_op:      bss.ht_operation  ?? null,
            vht_op:     bss.vht_operation ?? null,
            he_op:      bss.he_operation  ?? null,
            eht_op:     bss.eht_operation ?? null,
        }))
        .sort((a, b) => (b.quality - a.quality) || (a.channel - b.channel))
    );
}

function classifyScanEnc(enc) {
    if (!enc || !enc.enabled) return 'none';
    if (Array.isArray(enc.wep)) return 'wep';
    const auths = Array.isArray(enc.authentication) ? enc.authentication : [];
    const hasSae = auths.includes('sae');
    const hasPsk = auths.includes('psk');
    if (hasSae && hasPsk) return 'sae-mixed';
    if (hasSae) return 'sae';
    if (hasPsk) {
        const wpa = Array.isArray(enc.wpa) ? enc.wpa : [];
        return wpa.includes(2) ? 'psk2' : 'psk';
    }
    return 'none';
}

async function uplink_connect(radio_id, params) {
    const errors = [];
    const { ssid, key, encryption, mlo, l2_method, mld_assoc_phy, mld_allowed_phy_bitmap, bssid } = params;

    if (!ssid) { errors.push('ssid is required'); return { ok: false, sid: null, errors }; }

    const write = {
        mode:       'sta',
        ssid,
        encryption: encryption || 'psk2',
        network:    l2_method  || 'wwan'
    };
    if (key)   write.key   = key;
    if (bssid) write.bssid = bssid;
    if (mlo)   write.mlo   = '1';

    if (mlo) {
        // MLO STA: mld_assoc_phy (0=2G,1=5G,2=6G) + mld_allowed_phy_bitmap mandatory (MP4.3+)
        if (mld_assoc_phy === undefined || mld_assoc_phy === null) {
            errors.push('mld_assoc_phy is required for MLO STA (0=2G, 1=5G, 2=6G)');
            return { ok: false, sid: null, errors };
        }
        const bitmap = mld_allowed_phy_bitmap !== undefined ? mld_allowed_phy_bitmap : 7;
        if ((bitmap & (1 << parseInt(mld_assoc_phy))) === 0) {
            errors.push('mld_assoc_phy must be included in mld_allowed_phy_bitmap');
            return { ok: false, sid: null, errors };
        }
        write.mld_assoc_phy         = String(mld_assoc_phy);
        write.mld_allowed_phy_bitmap = String(bitmap);

        if (write.encryption && WPA3_ENC.has(write.encryption) && !('ieee80211w' in write))
            write.ieee80211w = '2';

        const addRes = await layer1.uci_add('wireless', 'wifi-iface');
        if (!addRes.ok) return { ok: false, sid: null, errors: ['uci_add failed'] };
        const sid = addRes.data.section;

        const wRes = await layer1.uci_write('wireless', sid, write);
        if (!wRes.ok) return { ok: false, sid: null, errors: ['uci_write failed'] };

        // Add all 3 radios for MLO STA
        for (const rid of ['radio0', 'radio1', 'radio2']) {
            const lRes = await layer1.uci_list_add('wireless', sid, 'device', rid);
            if (!lRes.ok) return { ok: false, sid: null, errors: [`uci_list_add failed for ${rid}`] };
        }

        return { ok: true, sid, errors: [] };
    } else {
        write.device = radio_id;
        if (write.encryption && WPA3_ENC.has(write.encryption) && !('ieee80211w' in write))
            write.ieee80211w = '2';

        const addRes = await layer1.uci_add('wireless', 'wifi-iface');
        if (!addRes.ok) return { ok: false, sid: null, errors: ['uci_add failed'] };
        const sid = addRes.data.section;

        const wRes = await layer1.uci_write('wireless', sid, write);
        if (!wRes.ok) return { ok: false, sid: null, errors: ['uci_write failed'] };

        return { ok: true, sid, errors: [] };
    }
}

async function uplink_disconnect(sid) {
    const delRes = await layer1.uci_delete('wireless', sid);
    return { ok: delRes.ok };
}

async function uplink_get_status(ifname) {
    const [wpRes, linkRes, dumpRes] = await Promise.all([
        layer1.wpa_status(ifname),
        layer1.iw_link(ifname),
        layer1.iw_station_dump(ifname)
    ]);

    const wp      = wpRes.ok   ? wpRes.data  : {};
    const linkRaw = linkRes.ok ? linkRes.data.raw : '';

    let signal = null;
    if (dumpRes.ok && dumpRes.data.length) {
        const s = dumpRes.data[0]['signal'] || '';
        const m = s.match(/(-?\d+)\s*\[/) || s.match(/^(-?\d+)/);
        if (m) signal = parseInt(m[1]);
    }

    return l2ok({
        wpa_state:       wp.wpa_state    || 'DISCONNECTED',
        ssid:            wp.ssid         || null,
        bssid:           wp.bssid        || null,
        ap_mld_addr:     wp.ap_mld_addr  || null,
        wifi_generation: wp.wifi_generation ? parseInt(wp.wifi_generation) : null,
        signal,
        tx_bitrate:      parseBitrate(linkRaw, 'tx'),
        rx_bitrate:      parseBitrate(linkRaw, 'rx'),
        ip_address:      wp.ip_address   || null,
        channel_width:   wp.channel_width ? parseInt(wp.channel_width) : null
    });
}

// --- BLOCK 6: system ---

async function system_get_info() {
    const [fwRes, kernRes, skuRes, thermalRes, wifiTempRes, regRes] = await Promise.all([
        layer1.sysfs_fw_version(),
        layer1.sysfs_kernel_version(),
        layer1.sysfs_sku_disable(),
        layer1.sysfs_thermal(),
        layer1.sysfs_wifi_temp(),
        layer1.iw_reg()
    ]);

    let country = null;
    if (regRes.ok) {
        const m = (regRes.data.raw || '').match(/country\s+([A-Z]{2}):/i);
        if (m) country = m[1];
    }

    return l2ok({
        fw_version:  fwRes.ok      ? fwRes.data      : null,
        kernel:      kernRes.ok    ? kernRes.data     : null,
        sku_active:  toSkuActive(skuRes),
        thermal:     thermalRes.ok ? thermalRes.data  : null,
        wifi_temp:   wifiTempRes.ok ? wifiTempRes.data : null,
        country
    });
}

// Tracks when system_apply was called (for elapsed_s in poll)
let _applyStartTime = null;

async function system_apply(type) {
    _applyStartTime = Date.now();
    const deadline  = Date.now() + 180000; // 3 minutes

    if (type === 'reboot') {
        const res = await layer1.system_reboot();
        return { ok: res.ok, timeout: false };
    }

    await layer1.system_wifi_restart();

    while (Date.now() < deadline) {
        const poll = await system_apply_poll();
        if (poll.ok && poll.data.ready) return { ok: true, timeout: false };
        await new Promise(r => setTimeout(r, 3000));
    }

    return { ok: false, timeout: true };
}

// Returns true when every non-disabled AP iface reports ENABLED and every non-disabled radio is up.
// STA ifaces are not checked (connection depends on upstream availability).
// iwRaw: raw string from iw_dev() — used to skip AP ifaces not visible in kernel
// (e.g. radio conflicts where a STA or MLO takes the radio, legacy AP can't come up)
async function system_all_up(iwRaw) {
    const [uciRes, ubusRes] = await Promise.all([
        layer1.uci_read('wireless'),
        layer1.ubus_wireless_status()
    ]);
    if (!uciRes.ok) return false;

    const wData    = uciRes.data.wireless || {};
    const ubusData = ubusRes.ok ? ubusRes.data : {};
    const ifnameMap = buildIfnameMap(ubusData);

    // Build set of AP ifnames currently visible in iw dev
    const activeAPs = new Set();
    if (iwRaw) {
        const lines = iwRaw.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const im = lines[i].match(/^\s+Interface\s+(\S+)/);
            if (!im) continue;
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                if (/^\s*phy#/.test(lines[j])) break;
                if (lines[j].includes('type AP') || lines[j].includes('MLD with links')) {
                    activeAPs.add(im[1]);
                    break;
                }
            }
        }
    }

    // All non-disabled radios must be up
    for (const [id, sec] of Object.entries(wData)) {
        if (sec['.type'] !== 'wifi-device') continue;
        if (uciBool(sec.disabled)) continue;
        if (!ubusData[id] || ubusData[id].up !== true) return false;
    }

    // All non-disabled AP ifaces visible in iw dev must be ENABLED
    for (const [sid, sec] of Object.entries(wData)) {
        if (sec['.type'] !== 'wifi-iface') continue;
        if (uciBool(sec.disabled)) continue;
        if (sec.mode === 'sta') continue;

        const ifname = sec.ifname || ifnameMap[sid];
        // Anonymous sections (e.g. @wifi-iface[N]) use internal UCI names in ubus but
        // @-notation in uci -X output — the two don't match, so ifname can't be resolved
        // until netifd assigns one at runtime. Skip rather than blocking the poll forever.
        if (!ifname) continue;

        // Skip ifaces absent from iw dev — radio conflict, they can never come up
        if (activeAPs.size > 0 && !activeAPs.has(ifname)) continue;

        const hRes = await layer1.hostapd_ubus_stat(ifname);
        if (!hRes.ok || hRes.data.status !== 'ENABLED') return false;
    }

    return true;
}

async function system_apply_poll() {
    const elapsed_s = _applyStartTime
        ? Math.round((Date.now() - _applyStartTime) / 1000) : 0;

    const iwRes = await layer1.iw_dev();
    if (!iwRes.ok) return l2ok({ phase: 'resetting', elapsed_s, ready: false, all_up: false });

    const raw      = iwRes.data.raw || '';
    const hasAnyAP = raw.includes('type AP');
    const hasMld   = raw.includes('MLD with links');

    // Phase: UI feedback only — tracks visible progress
    let phase = 'resetting';
    if (hasAnyAP) {
        if (hasMld) {
            const hRes = await layer1.ubus_hostapd_legacy_status('phy0', 0);
            phase = (hRes.ok && hRes.data.status === 'ENABLED') ? 'ready' : 'mld_setup';
        } else {
            phase = 'starting';
        }
    }

    // all_up: definitive — every visible AP iface must be ENABLED
    const all_up = hasAnyAP ? await system_all_up(raw) : false;

    return l2ok({ phase: all_up ? 'ready' : phase, elapsed_s, ready: all_up, all_up });
}

async function system_get_logs() {
    const res = await layer1.system_logs();
    return res.ok ? res.data : null;
}

async function system_get_txpower_info(band) {
    const res = await layer1.sysfs_txpower_info(band);
    return res.ok ? res.data : null;
}

async function relayd_setup(uplink_net, local_net) {
    return layer1.relayd_setup(uplink_net, local_net);
}

async function relayd_remove() {
    return layer1.relayd_remove();
}

async function repeater_fw_remove() {
    return layer1.fw_wan_remove_network('wwan');
}

async function relayd_get() {
    const res = await layer1.uci_read('network');
    if (!res.ok) return l2ok({ active: false, uplink_net: null });
    const nData = res.data.network || {};
    for (const sec of Object.values(nData)) {
        if (sec['.type'] === 'interface' && sec.proto === 'relay') {
            const nets = toArray(sec.network);
            return l2ok({ active: true, uplink_net: nets[0] || null });
        }
    }
    return l2ok({ active: false, uplink_net: null });
}

// --- MODULE EXPORT ---

const Layer2 = {
    // radio
    radio_get_all, radio_get, radio_set, radio_get_channels, system_set_txpower_mode,
    // iface
    iface_get_all, iface_get, iface_set, iface_add, iface_remove, iface_get_runtime,
    // mld
    mld_get_all, mld_get, mld_set, mld_add, mld_remove,
    // clients
    clients_get_all, clients_get_by_iface, clients_deauth,
    // uplink
    uplink_get_all, uplink_scan, uplink_connect, uplink_disconnect, uplink_get_status,
    // system
    system_get_info, system_apply, system_apply_poll, system_all_up, system_get_logs, system_get_txpower_info,
    // relayd
    relayd_setup, relayd_remove, relayd_get, repeater_fw_remove
};

return baseclass.extend(Layer2);
