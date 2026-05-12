'use strict';
'require baseclass';
'require wifimgr/layer2 as layer2';

// Layer 3: wizard orchestration. Calls Layer 2 only.
// Wizards make all UCI changes then fire system_apply.
// The view handles progress UI by polling layer2.system_apply_poll() independently.

// --- DATA LOADERS ---

// Load all tab data in parallel. Returns a flat data object for the view.
async function load_all() {
    const [radiosRes, ifacesRes, mldsRes, clientsRes, uplinksRes, sysinfoRes, relaydRes] =
        await Promise.all([
            layer2.radio_get_all(),
            layer2.iface_get_all(),
            layer2.mld_get_all(),
            layer2.clients_get_all(),
            layer2.uplink_get_all(),
            layer2.system_get_info(),
            layer2.relayd_get()
        ]);
    return {
        radios:  radiosRes.ok  ? radiosRes.data  : [],
        ifaces:  ifacesRes.ok  ? ifacesRes.data  : [],
        mlds:    mldsRes.ok    ? mldsRes.data     : [],
        clients: clientsRes.ok ? clientsRes.data  : [],
        uplinks: uplinksRes.ok ? uplinksRes.data  : [],
        sysinfo: sysinfoRes.ok ? sysinfoRes.data  : null,
        relayd:  relaydRes.ok  ? relaydRes.data   : { active: false, uplink_net: null },
        _errors: [
            !radiosRes.ok  ? 'radio_get_all: '  + radiosRes.error : null,
            !ifacesRes.ok  ? 'iface_get_all: '  + ifacesRes.error : null,
            !mldsRes.ok    ? 'mld_get_all: '    + mldsRes.error   : null,
            !clientsRes.ok ? 'clients_get_all: '+ clientsRes.error: null,
        ].filter(Boolean)
    };
}

// Load diagnostics data (heavier, not polled at main interval).
async function load_diag() {
    const [sysinfoRes, logsRes, tp0, tp1, tp2] = await Promise.all([
        layer2.system_get_info(),
        layer2.system_get_logs(),
        layer2.system_get_txpower_info(0),
        layer2.system_get_txpower_info(1),
        layer2.system_get_txpower_info(2)
    ]);
    return {
        sysinfo: sysinfoRes.ok ? sysinfoRes.data : null,
        logs:    logsRes,
        txpower: [
            tp0 && tp0.ok ? tp0.data : null,
            tp1 && tp1.ok ? tp1.data : null,
            tp2 && tp2.ok ? tp2.data : null
        ]
    };
}

// Load channel list (for Radios tab ACS/channel selector).
async function load_channels() {
    const res = await layer2.radio_get_channels('radio0');
    return res.ok ? res.data : [];
}

// Scan available APs on a radio (for Uplink/STA wizard).
async function scan(radio_id) {
    const res = await layer2.uplink_scan(radio_id);
    return res.ok ? res.data : [];
}

// --- APPLY FLOW ---

// Start wifi restart (fire-and-forget for the view).
// The view polls system_apply_poll() independently for progress.
// Returns immediately so the view can start showing the progress bar.
function start_apply(type) {
    layer2.system_apply(type); // intentionally not awaited
}

// Poll current restart phase (called by view every 3s during progress).
async function poll_apply() {
    return layer2.system_apply_poll();
}

// --- WIZARDS ---

// Wizard: Add single-radio AP.
// Returns { ok, sid, restartRequired, errors, warnings }.
async function wizard_ap(radio_id, params) {
    const enc   = params.encryption || (radio_id === 'radio2' ? 'sae' : 'psk2');
    const write = Object.assign({ encryption: enc }, params);
    delete write.radio_id;

    const res = await layer2.iface_add(radio_id, 'ap', write);
    if (!res.ok) return { ok: false, sid: null, restartRequired: 'none', errors: res.errors || [] };

    return { ok: true, sid: res.sid, restartRequired: 'wifi', errors: [] };
}

// Wizard: MLO setup (multi-radio AP).
// radio_ids: array of radio IDs (min 2).
// Returns { ok, sid, restartRequired, errors }.
async function wizard_mlo(radio_ids, params) {
    const enc   = params.encryption || 'sae-mixed';
    const write = Object.assign({ encryption: enc }, params);

    const res = await layer2.mld_add(radio_ids, write);
    if (!res.ok) return { ok: false, sid: null, restartRequired: 'none', errors: res.errors || [] };

    return { ok: true, sid: res.sid, restartRequired: 'reboot', errors: [] };
}

// Wizard: Connect as STA (uplink) on a single radio or MLO.
// params: { ssid, key, encryption, network?, mlo?, mld_assoc_phy?, mld_allowed_phy_bitmap? }.
// For MLO STA: mlo='1' + mld_assoc_phy required (0=2G, 1=5G, 2=6G). mld_allowed_phy_bitmap defaults to 7.
// Returns { ok, sid, restartRequired, errors }.
async function wizard_sta(radio_id, params) {
    const isMlo = params.mlo === '1' || params.mlo === true;
    const enc  = params.encryption || (isMlo ? 'sae-mixed' : 'psk2');

    if (isMlo) {
        // MLO STA: multi-radio, mld_assoc_band mandatory
        const mloParams = Object.assign({}, params, { encryption: enc, mlo: true });
        const res = await layer2.uplink_connect(radio_id, mloParams);
        if (!res.ok) return { ok: false, sid: null, restartRequired: 'none', errors: res.errors || [] };
        return { ok: true, sid: res.sid, restartRequired: 'wifi', errors: [] };
    }

    // Legacy STA: single-radio
    const write = Object.assign({ encryption: enc, network: params.network || 'wwan' }, params);
    const res = await layer2.iface_add(radio_id, 'sta', write);
    if (!res.ok) return { ok: false, sid: null, restartRequired: 'none', errors: res.errors || [] };
    return { ok: true, sid: res.sid, restartRequired: 'wifi', errors: [] };
}

// Wizard: relayd bridge (STA uplink on wwan, relay_bridge bridges wwan↔lan).
async function wizard_relayd(radio_id, params) {
    const enc   = params.encryption || 'none';
    const write = Object.assign({}, params, { encryption: enc, network: 'relayd_up' });
    delete write.wds;

    const staRes = await layer2.iface_add(radio_id, 'sta', write);
    if (!staRes.ok) return { ok: false, sid: null, restartRequired: 'none', errors: staRes.errors || [] };

    const relRes = await layer2.relayd_setup('relayd_up', 'lan');
    if (!relRes.ok) {
        await layer2.iface_remove(staRes.sid);
        return { ok: false, sid: null, restartRequired: 'none', errors: ['relayd_setup failed'] };
    }

    return { ok: true, sid: staRes.sid, restartRequired: 'wifi', errors: [] };
}

// Wizard: Repeater (STA uplink + local AP on separate radio).
// Returns { ok, sta_sid, ap_sid, restartRequired, errors }.
async function wizard_repeater(uplink_radio_id, ap_radio_id, uplink_params, ap_params) {
    // STA on uplink radio
    const staEnc   = uplink_params.encryption || 'psk2';
    const staWrite = Object.assign({ encryption: staEnc, network: 'wwan', repeater: '1' }, uplink_params);

    const staRes = await layer2.iface_add(uplink_radio_id, 'sta', staWrite);
    if (!staRes.ok) return { ok: false, sta_sid: null, ap_sid: null,
        restartRequired: 'none', errors: staRes.errors || [] };

    // AP on local radio
    const apEnc   = ap_params.encryption || (ap_radio_id === 'radio2' ? 'sae' : 'psk2');
    const apWrite = Object.assign({ encryption: apEnc, network: 'lan', repeater: '1' }, ap_params);

    const apRes = await layer2.iface_add(ap_radio_id, 'ap', apWrite);
    if (!apRes.ok) return { ok: false, sta_sid: staRes.sid, ap_sid: null,
        restartRequired: 'none', errors: apRes.errors || [] };

    // Add wwan to firewall wan zone so masquerade applies (L3 NAT for repeater clients)
    await layer1.fw_wan_add_network('wwan');

    return { ok: true, sta_sid: staRes.sid, ap_sid: apRes.sid,
        restartRequired: 'wifi', errors: [] };
}

// Wizard: Country / Regulatory change.
// Sets country on all 3 radios then restarts wifi. Does NOT touch sku_idx —
// that is managed exclusively by system_set_txpower_mode.
// Returns { ok, restartRequired, errors }.
async function wizard_country(country) {
    const errors = [];

    for (const rid of ['radio0', 'radio1', 'radio2']) {
        const res = await layer2.radio_set(rid, { country });
        if (!res.ok) { errors.push(...(res.errors || ['radio_set failed: ' + rid])); break; }
    }
    if (errors.length) return { ok: false, restartRequired: 'none', errors };

    return { ok: true, restartRequired: 'reboot', errors: [] };
}

// --- MODULE EXPORT ---

const Layer3 = {
    load_all, load_diag, load_channels, scan,
    start_apply, poll_apply,
    wizard_ap, wizard_mlo, wizard_sta, wizard_relayd, wizard_repeater, wizard_country
};

return baseclass.extend(Layer3);
