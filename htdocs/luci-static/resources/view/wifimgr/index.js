'use strict';
'require view';
'require poll';
'require wifimgr/layer2 as layer2';
'require wifimgr/layer3 as layer3';

// ── BAND METADATA ────────────────────────────────────────────────────────────

var BANDS = {
    radio0: { label: '2.4 GHz', bg: '#0d2137', fg: '#5b9bd5' },
    radio1: { label: '5 GHz',   bg: '#0d2a1a', fg: '#4caf7d' },
    radio2: { label: '6 GHz',   bg: '#2a1800', fg: '#f5a623' }
};

var ENC_LABEL = {
    'none':      'Open',
    'psk':       'WPA',
    'psk2':      'WPA2',
    'psk-mixed': 'WPA/WPA2',
    'sae':       'WPA3',
    'sae-mixed': 'WPA2/WPA3',
    'owe':       'OWE (open secure)'
};

// ── MODE ──────────────────────────────────────────────────────────────────────

function getMode()  { return localStorage.getItem('wifimgr_mode') || 'basic'; }
function isAdv()    { return true; }
function setMode(m) { localStorage.setItem('wifimgr_mode', m); }

// ── COLLAPSIBLE STATE ─────────────────────────────────────────────────────────

function colGet(key, def) {
    var v = localStorage.getItem('wmc_' + key);
    return v === null ? (def !== false) : v === '1';
}
function colSet(key, v) { localStorage.setItem('wmc_' + key, v ? '1' : '0'); }

// ── MODULE-LEVEL STATE ────────────────────────────────────────────────────────

var _data           = null;
var _diag           = null;
var _diagTs         = 0;
var _tab            = 'networks';
var _tabContainers  = {};
var _tabNavBtns     = {};
var _onApplied      = null;
var _netExpandState = {}; // sid → {expanded, editMode} — survives poll re-renders
var _lastFormTouch  = 0;  // timestamp of last form interaction — blocks poll re-render

// ── STATIC TAB LIST ───────────────────────────────────────────────────────────
// Networks | Radios | Clients | Diagnostics (always visible)

var TAB_DEFS = [
    { id: 'networks',    label: 'Networks' },
    { id: 'radios',      label: 'Radios' },
    { id: 'clients',     label: 'Clients' },
    { id: 'diagnostics', label: 'Diagnostics' }
];

// ── DOM HELPERS ───────────────────────────────────────────────────────────────

function node(tag, attrs) {
    var el = E(tag, attrs || {});
    for (var i = 2; i < arguments.length; i++) {
        var c = arguments[i];
        if (c == null) continue;
        if (Array.isArray(c)) { c.forEach(function(x) { if (x != null) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); }
        else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

function sp(text, style) { return node('span', style ? { style: style } : {}, text); }
function div(style) {
    var el = node('div', style ? { style: style } : {});
    for (var i = 1; i < arguments.length; i++) {
        var c = arguments[i];
        if (c == null) continue;
        if (Array.isArray(c)) { c.forEach(function(x) { if (x != null) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); }); }
        else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

function bandPill(radio_id) {
    var b = BANDS[radio_id] || { label: radio_id, bg: '#222', fg: '#aaa' };
    return node('span', {
        style: 'display:inline-block;padding:1px 8px;border-radius:3px;font-size:11px;font-weight:bold;' +
               'background:' + b.bg + ';color:' + b.fg + ';margin-right:4px;white-space:nowrap'
    }, BANDS[radio_id] ? b.label : radio_id);
}

function statusBadge(state) {
    var s = (state || '').toUpperCase();
    var label = s === 'ENABLED' ? 'Active' : s === 'UP' ? 'Up' : s === 'DISABLED' ? 'Disabled' : s === 'DOWN' ? 'Down' : (state || 'Unknown');
    var color = (s === 'ENABLED' || s === 'UP') ? '#1d9e75' : (s === 'DISABLED') ? '#555' : '#e24b4a';
    return node('span', {
        style: 'display:inline-block;padding:1px 8px;border-radius:3px;font-size:11px;' +
               'background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44'
    }, label);
}

function encLabel(enc) { return ENC_LABEL[enc] || enc || 'Open'; }

function signalBars(dbm) {
    if (dbm == null) return sp('—', 'color:#555');
    var bars  = dbm >= -50 ? 4 : dbm >= -65 ? 3 : dbm >= -75 ? 2 : 1;
    var color = bars === 4 ? '#1d9e75' : bars === 3 ? '#5b9bd5' : bars === 2 ? '#f5a623' : '#e24b4a';
    var wrap  = node('span', { style: 'display:inline-flex;align-items:flex-end;gap:2px;height:14px;vertical-align:middle;margin-right:5px' });
    for (var i = 1; i <= 4; i++) {
        wrap.appendChild(node('span', {
            style: 'display:inline-block;width:3px;background:' + (i <= bars ? color : '#2a2a4a') +
                   ';height:' + (i * 3 + 2) + 'px;border-radius:1px'
        }));
    }
    return node('span', {}, wrap, sp(dbm + ' dBm', 'color:' + color + ';font-size:12px'));
}

function genBadge(htmode) {
    var h = (htmode || '').toUpperCase();
    var mode, bg, fg;
    if      (h.indexOf('EHT') >= 0) { mode = 'WiFi 7'; bg = '#1a0a3a'; fg = '#afa9ec'; }
    else if (h.indexOf('HE')  >= 0) { mode = 'WiFi 6'; bg = '#0a1a3a'; fg = '#85b7eb'; }
    else if (h.indexOf('VHT') >= 0) { mode = 'WiFi 5'; bg = '#0a2a1a'; fg = '#4caf7d'; }
    else if (h.indexOf('HT')  >= 0) { mode = 'WiFi 4'; bg = '#1a2030'; fg = '#888';    }
    else return null;
    return sp(mode, 'font-size:11px;padding:1px 6px;background:' + bg + ';color:' + fg + ';border-radius:3px;flex-shrink:0');
}

// WiFi generation badge auto-detected from iw bitrate string (e.g. "2401.9 MBit/s 160MHz EHT-MCS 11...")
function modeBadge(bitrateStr, isMld) {
    if (!bitrateStr) return null;
    var s = String(bitrateStr).toUpperCase();
    var mode, bg, fg;
    if      (s.indexOf('EHT') >= 0)  { mode = isMld ? 'WiFi 7' : 'EHT'; bg = '#1a0a3a'; fg = '#afa9ec'; }
    else if (s.indexOf(' HE')  >= 0) { mode = 'WiFi 6'; bg = '#0a1a3a'; fg = '#85b7eb'; }
    else if (s.indexOf('VHT')  >= 0) { mode = 'WiFi 5'; bg = '#0a2a1a'; fg = '#4caf7d'; }
    else if (s.indexOf('MCS')  >= 0) { mode = 'WiFi 4'; bg = '#1a2030'; fg = '#888';    }
    else                             { mode = 'Legacy'; bg = '#1a1a1a'; fg = '#555';    }
    return sp(mode, 'font-size:11px;padding:1px 6px;background:' + bg + ';color:' + fg + ';border-radius:3px;flex-shrink:0');
}

// Map client link_id → radio id using AP MLD link freq data
function clientLinkBand(ifname, link_id, data) {
    var mld = (data.mlds || []).find(function(m) { return m.ifname === ifname; });
    if (!mld) return null;
    var apLink = (mld.links || []).find(function(l) { return l.link_id === link_id; });
    if (!apLink || !apLink.freq) return null;
    return apLink.freq < 3000 ? 'radio0' : apLink.freq < 5900 ? 'radio1' : 'radio2';
}

// Parse iw bitrate string → {speed:'2402 Mbit/s', detail:'EHT MCS11 NSS2'}
function parseBitrate(s) {
    if (!s) return null;
    var m = s.match(/^([\d.]+)\s*MBit\/s/i);
    if (!m) return { speed: s, detail: null };
    var speed = Math.round(parseFloat(m[1])) + ' Mbit/s';
    var detail = '';
    var ehtM = s.match(/EHT-MCS\s*(\d+)/i), ehtN = s.match(/EHT-NSS\s*(\d+)/i);
    var heM  = s.match(/HE-MCS\s*(\d+)/i),  heN  = s.match(/HE-NSS\s*(\d+)/i);
    var vhtM = s.match(/VHT-MCS\s*(\d+)/i), vhtN = s.match(/VHT-NSS\s*(\d+)/i);
    if      (ehtM) detail = 'EHT MCS' + ehtM[1] + (ehtN ? ' NSS' + ehtN[1] : '');
    else if (heM)  detail = 'HE MCS'  + heM[1]  + (heN  ? ' NSS' + heN[1]  : '');
    else if (vhtM) detail = 'VHT MCS' + vhtM[1] + (vhtN ? ' NSS' + vhtN[1] : '');
    else { var htM = s.match(/MCS\s*(\d+)/); if (htM) detail = 'MCS' + htM[1] + (s.indexOf('short GI') >= 0 ? ' SGI' : ''); }
    return { speed: speed, detail: detail || null };
}

// Best signal for display: per-link signals for MLO (top-level iw signal is 0 for MLO)
function bestClientSignal(c) {
    if (c.links && c.links.length) {
        var sigs = c.links.map(function(l) { return l.signal; }).filter(function(s) { return typeof s === 'number' && s < 0; });
        if (sigs.length) return Math.max.apply(null, sigs);
    }
    return (c.signal === 0) ? null : c.signal;
}

// Best RX speed for header (highest link RX rate)
function bestClientSpeed(c) {
    var best = 0, bestStr = null;
    var cands = [];
    if (c.links && c.links.length) c.links.forEach(function(lk) { if (lk.rx_bitrate) cands.push(lk.rx_bitrate); });
    if (!cands.length && c.rx_bitrate) cands.push(c.rx_bitrate);
    cands.forEach(function(s) {
        var p = parseBitrate(s);
        if (!p) return;
        var n = parseInt(p.speed);
        if (!isNaN(n) && n > best) { best = n; bestStr = p.speed; }
    });
    return bestStr;
}

function wpaLabel(state) {
    if (!state || state === 'DISCONNECTED') return 'Disconnected';
    if (state === 'COMPLETED') return 'Connected';
    if (state === 'SCANNING')  return 'Scanning...';
    if (state === 'ASSOCIATING' || state === 'AUTHENTICATING') return 'Connecting...';
    return state;
}

function card() {
    var el = node('div', { style: 'background:#16213e;border:1px solid #2a2a4a;border-radius:6px;padding:12px 16px;margin-bottom:10px' });
    for (var i = 0; i < arguments.length; i++) { var c = arguments[i]; if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
}

function rowEl(left, right) {
    var el = node('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px' });
    if (left)  el.appendChild(typeof left  === 'string' ? sp(left,  'color:#888;font-size:12px') : left);
    if (right) el.appendChild(typeof right === 'string' ? sp(right, 'color:#ddd;font-size:13px') : right);
    return el;
}

function lbl(text) { return sp(text, 'color:#888;font-size:12px'); }
function val(text) { return sp(String(text == null ? '—' : text), 'color:#ddd;font-size:13px'); }
function muted(text) { return sp(text, 'color:#555;font-size:12px'); }
function strong(text) { return node('strong', { style: 'color:#ddd' }, text); }

function btn(text, color, onclick) {
    var el = node('button', {
        style: 'padding:5px 14px;background:' + (color || '#185fa5') + ';color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px'
    }, text);
    el.onclick = onclick;
    return el;
}
function btnDanger(text, onclick)    { return btn(text, '#6b1c1c', onclick); }
function btnSecondary(text, onclick) { return btn(text, '#1e2a3a', onclick); }

function inputField(value, placeholder, type) {
    return node('input', {
        type: type || 'text', value: value || '', placeholder: placeholder || '',
        style: 'background:#0d1b2a;color:#ddd;border:1px solid #334;border-radius:4px;padding:5px 9px;width:100%;box-sizing:border-box;font-size:13px'
    });
}

function pwdWrap(input) {
    input.type = 'password';
    var visible = false;
    var toggle = node('button', {
        type: 'button',
        style: 'background:none;border:1px solid #2a3a4a;border-radius:3px;color:#888;cursor:pointer;font-size:12px;padding:2px 7px;margin-left:6px;flex-shrink:0;white-space:nowrap'
    }, 'Show');
    toggle.onclick = function() {
        visible = !visible;
        input.type = visible ? 'text' : 'password';
        toggle.textContent = visible ? 'Hide' : 'Show';
    };
    input.style.flex = '1';
    input.style.minWidth = '0';
    return node('div', { style: 'display:flex;align-items:center;width:100%' }, input, toggle);
}

function selectEl(opts, cur) {
    var el = node('select', { style: 'background:#0d1b2a;color:#ddd;border:1px solid #334;border-radius:4px;padding:5px 8px;font-size:13px' });
    opts.forEach(function(o) {
        var op = node('option', { value: o[0] }, o[1]);
        if (o[0] === cur) op.setAttribute('selected', 'selected');
        el.appendChild(op);
    });
    return el;
}

// Network name dropdown with preset options + optional custom text entry.
// AP mode: lan/guest/iot  |  STA/uplink mode: wwan/lan
// Returns a div element with ._getValue() method for reading current value.
function networkSel(currentVal, forSTA) {
    var OPTS = forSTA
        ? [['wwan','wwan (uplink)'],['lan','lan'],['guest','guest'],['custom','custom…']]
        : [['lan','lan'],['guest','guest'],['iot','iot'],['custom','custom…']];
    var val  = currentVal || (forSTA ? 'wwan' : 'lan');
    var inList = OPTS.some(function(o) { return o[0] === val; });
    var sel     = selectEl(OPTS, inList ? val : 'custom');
    var customIn = inputField(inList ? '' : val, 'enter network name');
    customIn.style.display   = (sel.value === 'custom') ? '' : 'none';
    customIn.style.marginTop = '4px';
    sel.addEventListener('change', function() {
        customIn.style.display = sel.value === 'custom' ? '' : 'none';
    });
    var wrap = node('div', {}, sel, customIn);
    wrap._getValue = function() { return sel.value === 'custom' ? customIn.value.trim() : sel.value; };
    return wrap;
}

function formRow(lbl_text, inp) {
    var el = node('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' });
    el.appendChild(node('label', { style: 'color:#888;font-size:12px;min-width:110px;flex-shrink:0' }, lbl_text));
    el.appendChild(node('div', { style: 'flex:1' }, inp));
    return el;
}

function inlineErr(msg) { return node('div', { style: 'color:#e24b4a;font-size:12px;margin-top:5px' }, msg); }

function successBadge(msg) {
    var el = node('span', { style: 'color:#1d9e75;font-size:12px;padding:2px 8px;background:#1d9e7520;border-radius:3px' }, msg || 'Saved');
    setTimeout(function() { el.style.opacity = '0'; el.style.transition = 'opacity 0.8s'; }, 1800);
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 2700);
    return el;
}

function collapsible(key, headerEl, bodyFn, defaultOpen) {
    var open = colGet(key, defaultOpen);
    var chevron = sp(open ? '▲' : '▼', 'font-size:10px;color:#555;margin-left:6px');
    var body = node('div', { style: 'margin-top:10px' });
    if (open) body.appendChild(bodyFn());

    var hdr = node('div', { style: 'display:flex;align-items:center;cursor:pointer;user-select:none' },
        typeof headerEl === 'string' ? sp(headerEl, 'color:#ccc;font-weight:bold;font-size:13px') : headerEl,
        chevron);
    hdr.onclick = function() {
        open = !open; colSet(key, open);
        chevron.textContent = open ? '▲' : '▼';
        while (body.firstChild) body.removeChild(body.firstChild);
        if (open) body.appendChild(bodyFn());
    };

    var wrap = node('div', {}, hdr, body);
    return wrap;
}

function checkbox(checked) {
    var el = node('input', { type: 'checkbox' });
    if (checked) el.setAttribute('checked', 'checked');
    return el;
}

function formatDuration(secs) {
    if (!secs) return '';
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's';
}

// ── APPLY FLOW ────────────────────────────────────────────────────────────────

function humanError(msg) {
    if (!msg) return 'An error occurred.';
    if (msg.includes('6 GHz') || msg.includes('sae') || msg.includes('owe'))
        return 'This network requires WPA3 encryption.';
    if (msg.includes('sku_idx'))
        return 'Country and regulatory index must be changed together.';
    if (msg.includes('2 radios') || msg.includes('MLD'))
        return 'WiFi 7 setup requires at least 2 radios.';
    if (msg.includes('ssid'))
        return 'Network name is required.';
    if (msg.includes('uci_write') || msg.includes('uci_add'))
        return 'Failed to save settings.';
    return msg;
}

function applyFlow(container, fn, onDone, lockFn) {
    while (container.firstChild) container.removeChild(container.firstChild);

    var pbarOuter = node('div', { style: 'height:4px;background:#1a2a3a;border-radius:2px;margin-top:8px' });
    var pbar      = node('div', { style: 'height:4px;width:0%;background:#5b9bd5;border-radius:2px;transition:width 0.5s' });
    var pbarLbl   = node('div', { style: 'color:#888;font-size:12px;margin-top:5px' }, 'Applying changes...');
    var progress  = node('div', { style: 'display:none' }, pbarOuter, pbar, pbarLbl);
    pbarOuter.appendChild(pbar);

    var spinner = node('div', { style: 'color:#888;font-size:12px;padding:4px 0' }, 'Please wait...');
    container.appendChild(spinner);
    container.appendChild(progress);

    var PHASE_PCT = { resetting: 20, starting: 50, mld_setup: 75, ready: 100 };
    var PHASE_LBL = { resetting: 'Stopping WiFi...', mld_setup: 'Enabling WiFi 7...', ready: 'Done' };
    function phaseLabel(phase, elapsed_s) {
        if (phase === 'starting') return elapsed_s > 15
            ? 'DFS scan in progress (~60 s)...'
            : 'Starting interfaces...';
        return PHASE_LBL[phase] || 'Applying changes...';
    }

    fn().then(function(result) {
        spinner.style.display = 'none';
        if (!result.ok) {
            var msg = result.errors && result.errors.length ? result.errors.join('; ') : 'Failed';
            container.appendChild(inlineErr(msg));
            return;
        }

        var rr = result.restartRequired;

        if (rr === 'none') {
            container.appendChild(successBadge('Saved'));
            if (onDone) onDone();
            return;
        }

        progress.style.display = 'block';
        pbar.style.width = '10%';

        if (rr === 'reboot') {
            pbarLbl.textContent = 'Initiating reboot...';
            layer3.start_apply('reboot');
            setTimeout(function() { pbar.style.width = '100%'; pbarLbl.textContent = 'Rebooting — reconnect in ~60s'; }, 1500);
            return;
        }

        layer3.start_apply('wifi');
        if (lockFn) lockFn(false);

        var timer = setInterval(function() {
            layer3.poll_apply().then(function(pr) {
                if (!pr.ok || !pr.data) return;
                var d   = pr.data;
                var pct = PHASE_PCT[d.phase] || 10;
                pbar.style.width = pct + '%';
                pbarLbl.textContent = phaseLabel(d.phase, d.elapsed_s);
                if (d.ready) {
                    clearInterval(timer);
                    if (lockFn) lockFn(true);
                    setTimeout(function() {
                        progress.style.display = 'none';
                        container.appendChild(successBadge('Done'));
                        if (onDone) onDone();
                    }, 600);
                }
            });
        }, 3000);

        setTimeout(function() {
            clearInterval(timer);
            if (lockFn) lockFn(true);
            progress.style.display = 'none';
            container.appendChild(inlineErr('WiFi restart is taking longer than expected (DFS?) — check Networks tab. If nothing appeared, reboot.'));
        }, 240000);

    }).catch(function(e) {
        spinner.style.display = 'none';
        container.appendChild(inlineErr('Error: ' + String(e)));
    });
}

// ── MODAL ─────────────────────────────────────────────────────────────────────

function openModal(title, build) {
    var overlay = node('div', {
        style: 'position:fixed;top:0;left:0;right:0;bottom:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center'
    });
    var canClose = true;
    function close() { if (canClose && overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    function setCloseable(v) {
        canClose = v;
        xBtn.style.color  = v ? '#555' : '#2a3a4a';
        xBtn.style.cursor = v ? 'pointer' : 'default';
    }

    var modal = node('div', {
        style: 'background:#111e30;border:1px solid #2a3a50;border-radius:8px;padding:20px 24px;' +
               'min-width:340px;max-width:520px;width:90vw;max-height:85vh;overflow-y:auto'
    });

    var hdr = node('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px' },
        node('div', { style: 'color:#ddd;font-weight:bold;font-size:14px' }, title));
    var xBtn = btn('✕', '#1a2a3a', close);
    xBtn.style.cssText = 'background:none;border:none;color:#555;font-size:16px;cursor:pointer;padding:0 4px';
    hdr.appendChild(xBtn);
    modal.appendChild(hdr);

    var body = node('div', {});
    build(body, close, setCloseable);
    modal.appendChild(body);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return close;
}

// ── WIZARDS ───────────────────────────────────────────────────────────────────

function wizardAP(onDone) {
    openModal('Add Access Point', function(body, close, setCloseable) {
        var ssidIn = inputField('', 'Network name (SSID)');
        var passIn = inputField('', 'Password', 'password');
        var ENC_OPTS = {
            radio0: [['sae-mixed','WPA2/WPA3'],['sae','WPA3'],['psk2','WPA2'],['none','Open']],
            radio1: [['sae-mixed','WPA2/WPA3'],['sae','WPA3'],['psk2','WPA2'],['none','Open']],
            radio2: [['sae','WPA3'],['owe','OWE (open secure)']]
        };
        var encSel = selectEl(ENC_OPTS.radio1, 'sae-mixed');
        var applyDiv = node('div', {});
        var errDiv   = node('div', {});

        body.appendChild(formRow('SSID', ssidIn));
        body.appendChild(formRow('Password', pwdWrap(passIn)));
        body.appendChild(formRow('Security', encSel));
        body.appendChild(errDiv);

        // Advanced collapsible
        var radioSel  = selectEl([['radio0','2.4 GHz'],['radio1','5 GHz'],['radio2','6 GHz']], 'radio1');
        var CHAN_OPTS  = {
            radio0: [['auto','auto'],['1','1'],['6','6'],['11','11']],
            radio1: [['auto','auto'],['36','36'],['40','40'],['44','44'],['48','48'],['52','52 (DFS)'],['56','56 (DFS)'],['60','60 (DFS)'],['64','64 (DFS)'],['100','100 (DFS)'],['104','104 (DFS)'],['108','108 (DFS)'],['112','112 (DFS)'],['116','116 (DFS)'],['120','120 (DFS)'],['124','124 (DFS)'],['128','128 (DFS)'],['132','132 (DFS)'],['136','136 (DFS)'],['140','140 (DFS)'],['144','144 (DFS)'],['149','149'],['153','153'],['157','157'],['161','161'],['165','165']],
            radio2: [['auto','auto'],['1','1'],['5','5'],['9','9'],['33','33'],['37','37'],['69','69']]
        };
        var WIDTH_OPTS = {
            radio0: [['auto','auto'],['20','20 MHz'],['40','40 MHz']],
            radio1: [['auto','auto'],['20','20 MHz'],['40','40 MHz'],['80','80 MHz'],['160','160 MHz']],
            radio2: [['auto','auto'],['20','20 MHz'],['40','40 MHz'],['80','80 MHz'],['160','160 MHz'],['320','320 MHz']]
        };
        var chanSel  = selectEl(CHAN_OPTS.radio1, 'auto');
        var widthSel = selectEl(WIDTH_OPTS.radio1, 'auto');
        var ifaceSel = networkSel('lan');
        var isoIn    = checkbox(false);
        var hidIn    = checkbox(false);
        var wdsCbAP  = checkbox(false);
        var maxIn    = inputField('', 'unlimited');

        var dfsNote = node('div', { style: 'color:#f5a623;font-size:11px;margin-top:3px;display:none' },
            'DFS channels (52+) require ~60 s CAC scan — network appears after restart');

        radioSel.onchange = function() {
            var opts = CHAN_OPTS[radioSel.value] || CHAN_OPTS.radio1;
            while (chanSel.firstChild) chanSel.removeChild(chanSel.firstChild);
            opts.forEach(function(o) { chanSel.appendChild(node('option', { value: o[0] }, o[1])); });
            var wOpts = WIDTH_OPTS[radioSel.value] || WIDTH_OPTS.radio1;
            while (widthSel.firstChild) widthSel.removeChild(widthSel.firstChild);
            wOpts.forEach(function(o) { widthSel.appendChild(node('option', { value: o[0] }, o[1])); });
            var eOpts = ENC_OPTS[radioSel.value] || ENC_OPTS.radio0;
            while (encSel.firstChild) encSel.removeChild(encSel.firstChild);
            eOpts.forEach(function(o) { encSel.appendChild(node('option', { value: o[0] }, o[1])); });
            dfsNote.style.display = radioSel.value === 'radio1' ? '' : 'none';
        };
        var advBody = node('div', { style: 'margin-top:4px' });
        advBody.appendChild(formRow('Radio', radioSel));
        advBody.appendChild(dfsNote);
        advBody.appendChild(formRow('Channel', chanSel));
        advBody.appendChild(formRow('Width', widthSel));
        advBody.appendChild(formRow('Network', ifaceSel));
        advBody.appendChild(formRow('Isolate clients', isoIn));
        advBody.appendChild(sp('Blocks direct traffic between connected clients — useful for guest networks.', 'color:#555;font-size:11px;display:block;margin:-4px 0 4px'));
        advBody.appendChild(formRow('Hidden SSID', hidIn));
        advBody.appendChild(formRow('WDS bridge', wdsCbAP));
        advBody.appendChild(formRow('Max clients', maxIn));
        body.appendChild(collapsible('wiz_ap_adv', 'Advanced parameters', function() { return advBody; }, false));

        var goBtn = btn('Add Network', null, function() {
            var ssid = ssidIn.value.trim();
            if (!ssid) { while(errDiv.firstChild) errDiv.removeChild(errDiv.firstChild); errDiv.appendChild(inlineErr('SSID is required')); return; }
            var rid = radioSel.value;
            var p = { ssid: ssid, encryption: encSel.value };
            if (passIn.value)   p.key     = passIn.value;
            if (isoIn.checked)   p.isolate = '1';
            if (hidIn.checked)   p.hidden  = '1';
            if (wdsCbAP.checked) p.wds     = '1';
            if (parseInt(maxIn.value) > 0) p.maxassoc = maxIn.value;
            p.network = ifaceSel._getValue();

            applyFlow(applyDiv, function() {
                var rp = {};
                if (chanSel.value  !== 'auto') rp.channel = chanSel.value;
                if (widthSel.value !== 'auto') rp.htmode  = 'EHT' + widthSel.value;
                var radioPromise = Object.keys(rp).length
                    ? layer2.radio_set(rid, rp)
                    : Promise.resolve({ ok: true, errors: [] });
                return radioPromise.then(function(rR) {
                    if (!rR.ok) return { ok: false, errors: rR.errors || ['Radio settings failed'], restartRequired: 'none' };
                    return layer3.wizard_ap(rid, p);
                });
            }, function() { close(); if (onDone) onDone(); }, setCloseable);
        });

        body.appendChild(node('div', { style: 'margin-top:12px' }, goBtn));
        body.appendChild(applyDiv);
    });
}

function wizardMLO(onDone) {
    openModal('Add WiFi 7 Network', function(body, close, setCloseable) {
        var ssidIn   = inputField('', 'Network name (SSID)');
        var passIn   = inputField('', 'Password (min 8 chars)', 'password');
        var applyDiv = node('div', {});

        body.appendChild(node('div', { style: 'color:#f5a623;font-size:12px;margin-bottom:12px;padding:8px;background:#2a180044;border-radius:4px;border-left:3px solid #f5a623' },
            'WPA3 will be used automatically. Select at least 2 bands.'));
        body.appendChild(formRow('SSID', ssidIn));
        body.appendChild(formRow('Password', pwdWrap(passIn)));

        // Link toggle buttons
        var linkActive = { radio0: true, radio1: true, radio2: true };
        var linkBtns = {};
        var linkRow = node('div', { style: 'display:flex;gap:6px' });
        [['radio0','2.4 GHz'],['radio1','5 GHz'],['radio2','6 GHz']].forEach(function(pair) {
            var rid = pair[0], label = pair[1];
            var b2 = BANDS[rid];
            var el = node('button', {
                style: 'padding:4px 12px;font-size:12px;border-radius:4px;cursor:pointer;border:1px solid ' + b2.fg + ';background:' + b2.bg + ';color:' + b2.fg
            }, label);
            el.onclick = function() {
                linkActive[rid] = !linkActive[rid];
                el.style.border   = '1px solid ' + (linkActive[rid] ? b2.fg : '#2a3a50');
                el.style.background = linkActive[rid] ? b2.bg : 'none';
                el.style.color    = linkActive[rid] ? b2.fg : '#555';
            };
            linkBtns[rid] = el;
            linkRow.appendChild(el);
        });
        body.appendChild(formRow('Links', linkRow));

        // Advanced collapsible — per-link channel/width/TX, L3, interface, isolate
        var advBody = node('div', { style: 'margin-top:4px' });

        // Per-link channel/width/TX controls
        var CHAN_MLO = {
            radio0: [['auto','auto'],['1','1'],['6','6'],['11','11']],
            radio1: [['auto','auto'],['36','36'],['48','48'],['100','100'],['149','149']],
            radio2: [['auto','auto'],['1','1'],['37','37'],['69','69']]
        };
        var linkControls = {};
        [['radio0','2.4 GHz'],['radio1','5 GHz'],['radio2','6 GHz']].forEach(function(pair) {
            var rid = pair[0], label = pair[1];
            var cSel = selectEl(CHAN_MLO[rid], 'auto');
            var wSel = selectEl([['auto','auto'],['20','20 MHz'],['40','40 MHz'],['80','80 MHz'],['160','160 MHz']], 'auto');
            advBody.appendChild(node('div', { style: 'color:#aaa;font-size:12px;margin:8px 0 4px;font-weight:bold' }, label));
            advBody.appendChild(formRow('Channel', cSel));
            advBody.appendChild(formRow('Width', wSel));
            linkControls[rid] = { chanSel: cSel, widthSel: wSel };
        });

        var ifaceSel    = networkSel('lan');
        var isoIn       = checkbox(false);
        var emlDisableIn = checkbox(false);
        advBody.appendChild(formRow('Network', ifaceSel));
        advBody.appendChild(formRow('Isolate clients', isoIn));
        advBody.appendChild(sp('Blocks direct traffic between connected clients — useful for guest networks.', 'color:#555;font-size:11px;display:block;margin:-4px 0 4px'));
        advBody.appendChild(formRow('Disable EML', emlDisableIn));
        body.appendChild(collapsible('wiz_mlo_adv', 'Advanced parameters', function() { return advBody; }, false));

        var goBtn = btn('Create WiFi 7 Network', null, function() {
            var ssid = ssidIn.value.trim();
            if (!ssid) { body.appendChild(inlineErr('SSID is required')); return; }
            var rids = ['radio0','radio1','radio2'].filter(function(r) { return linkActive[r]; });
            if (rids.length < 2) { body.appendChild(inlineErr('Select at least 2 bands')); return; }
            var p = { ssid: ssid, encryption: 'sae', network: ifaceSel._getValue() };
            if (passIn.value) p.key = passIn.value;
            if (isoIn.checked) p.isolate = '1';
            if (emlDisableIn.checked) p.eml_disable = '1';

            applyFlow(applyDiv, function() {
                return rids.reduce(function(chain, rid) {
                    return chain.then(function(prev) {
                        if (!prev.ok) return prev;
                        var lc = linkControls[rid];
                        var rp = {};
                        if (lc.chanSel.value !== 'auto')  rp.channel = lc.chanSel.value;
                        if (lc.widthSel.value !== 'auto') rp.htmode  = 'EHT' + lc.widthSel.value;
                        return Object.keys(rp).length ? layer2.radio_set(rid, rp) : Promise.resolve({ ok: true, errors: [] });
                    });
                }, Promise.resolve({ ok: true, errors: [] })).then(function(last) {
                    if (!last.ok) return { ok: false, errors: last.errors || ['Radio set failed'], restartRequired: 'none' };
                    return layer3.wizard_mlo(rids, p);
                });
            }, function() { close(); if (onDone) onDone(); }, setCloseable);
        });

        body.appendChild(node('div', { style: 'margin-top:12px' }, goBtn));
        body.appendChild(applyDiv);
    });
}

function wizardStation(onDone) {
    openModal('Add Station', function(body, close, setCloseable) {
        var ssidIn   = inputField('', 'Upstream SSID');
        var passIn   = inputField('', 'Password', 'password');
        var mloCb    = checkbox(false);
        var bandSel  = selectEl([['radio0','2.4 GHz'],['radio1','5 GHz']], 'radio1');
        var assocSel = selectEl([['1','5 GHz'],['0','2.4 GHz']], '1');
        var applyDiv = node('div', {});

        var mloRow   = formRow('MLO', mloCb);
        var mloHint  = sp('WiFi 7 multi-band connection — requires an active MLO AP on the other router.', 'color:#555;font-size:11px;display:block;margin:-4px 0 4px');
        var mloConflictNote = node('div', { style: 'color:#e53935;font-size:11px;margin-top:3px;display:none' },
            'Cannot add MLO STA — a local MLO AP is active on the same radios. Remove it first (Networks tab).');
        var assocRow = formRow('Assoc band', assocSel);
        assocRow.style.display = 'none';
        var bandRow  = formRow('Band', bandSel);

        var scanErrDiv = node('div', {});
        var scanBtn = btnSecondary('Scan', function() {
            var radio = mloCb.checked ? 'radio1' : bandSel.value;
            scanBtn.disabled = true;
            scanBtn.textContent = 'Scanning…';
            while (scanErrDiv.firstChild) scanErrDiv.removeChild(scanErrDiv.firstChild);
            layer2.uplink_scan(radio).then(function(res) {
                scanBtn.disabled = false;
                scanBtn.textContent = 'Scan';
                if (!res.ok || !res.data.length) {
                    scanErrDiv.appendChild(inlineErr('No networks found — try again'));
                    return;
                }
                openModal('Available Networks', function(scanBody, scanClose) {
                    var refreshTimer = null;
                    var autoOn = true;
                    var tbl = node('table', { style: 'width:100%;border-collapse:collapse' });
                    var hdr = node('tr', {});
                    ['Signal','Band','SSID','Ch','Encryption'].forEach(function(h) {
                        hdr.appendChild(node('th', { style: 'text-align:left;padding:4px 8px;opacity:.6;font-size:11px' }, h));
                    });
                    tbl.appendChild(hdr);

                    function renderRows(data) {
                        while (tbl.rows.length > 1) tbl.deleteRow(1);
                        data.forEach(function(bss) {
                            var b = (bss.mhz >= 5925) ? 6 : (bss.mhz >= 5000) ? 5 : 2;
                            var bandLabel = b === 6 ? '6 GHz' : b === 5 ? '5 GHz' : '2.4 GHz';
                            var bandRadio = b === 6 ? 'radio2' : b === 5 ? 'radio1' : 'radio0';
                            var sigPct = bss.quality_max ? Math.round(100 * bss.quality / bss.quality_max) : 0;
                            var sigColor = sigPct >= 66 ? '#4caf50' : sigPct >= 33 ? '#f5a623' : '#e53935';
                            var row = node('tr', { style: 'cursor:pointer;border-top:1px solid rgba(255,255,255,.08)' });
                            row.appendChild(node('td', { style: 'padding:6px 8px' },
                                node('span', { style: 'color:' + sigColor }, sigPct + '%')));
                            row.appendChild(node('td', { style: 'padding:6px 8px' }, bandPill(bandLabel)));
                            row.appendChild(node('td', { style: 'padding:6px 8px;font-weight:500' }, bss.ssid || ''));
                            row.appendChild(node('td', { style: 'padding:6px 8px;opacity:.6' }, String(bss.channel || '')));
                            row.appendChild(node('td', { style: 'padding:6px 8px;opacity:.6;font-size:11px' }, bss.encryption || 'open'));
                            row.addEventListener('mouseenter', function() { row.style.background = 'rgba(255,255,255,.06)'; });
                            row.addEventListener('mouseleave', function() { row.style.background = ''; });
                            row.addEventListener('click', function() {
                                ssidIn.value = bss.ssid || '';
                                if (!mloCb.checked) {
                                    bandSel.value = bandRadio;
                                    bandSel.dispatchEvent(new Event('change'));
                                }
                                var encMap = { 'sae': 'sae', 'sae-mixed': 'sae-mixed', 'psk2': 'psk2', 'psk': 'psk2', 'none': 'none', 'owe': 'owe' };
                                var encVal = encMap[bss.encryption] || 'auto';
                                if (encSel.querySelector('option[value="' + encVal + '"]'))
                                    encSel.value = encVal;
                                passIn.focus();
                                clearInterval(refreshTimer);
                                scanClose();
                            });
                            tbl.appendChild(row);
                        });
                    }
                    renderRows(res.data);

                    var stopBtn = node('button', {}, '■ Stop');
                    stopBtn.style.cssText = 'background:none;border:none;color:#666;cursor:pointer;font-size:11px;padding:0;margin-left:6px';
                    stopBtn.onclick = function() {
                        autoOn = !autoOn;
                        if (autoOn) {
                            refreshTimer = setInterval(doRefresh, 8000);
                            stopBtn.textContent = '■ Stop';
                        } else {
                            clearInterval(refreshTimer);
                            stopBtn.textContent = '▶ Resume';
                        }
                    };
                    function doRefresh() {
                        if (!tbl.isConnected) { clearInterval(refreshTimer); return; }
                        layer2.uplink_scan('radio0').then(function(newRes) {
                            if (!tbl.isConnected) { clearInterval(refreshTimer); return; }
                            if (newRes.ok && newRes.data.length) renderRows(newRes.data);
                        });
                    }
                    refreshTimer = setInterval(doRefresh, 8000);

                    scanBody.appendChild(node('div', { style: 'display:flex;align-items:center;margin-bottom:6px' },
                        muted('Auto-refresh every 8s ·'), stopBtn));
                    scanBody.appendChild(tbl);
                });
            }).catch(function() {
                scanBtn.disabled = false;
                scanBtn.textContent = 'Scan';
                scanErrDiv.appendChild(inlineErr('Scan failed — try again'));
            });
        });

        var ssidRow = node('div', { style: 'display:flex;gap:8px;align-items:center' },
            node('div', { style: 'flex:1' }, ssidIn), scanBtn);

        body.appendChild(formRow('SSID', ssidRow));
        body.appendChild(scanErrDiv);
        body.appendChild(formRow('Password', pwdWrap(passIn)));
        body.appendChild(mloRow);
        body.appendChild(mloHint);
        body.appendChild(mloConflictNote);
        body.appendChild(assocRow);
        body.appendChild(bandRow);

        mloCb.addEventListener('change', function() {
            var mlo = mloCb.checked;
            assocRow.style.display = mlo ? '' : 'none';
            bandRow.style.display  = mlo ? 'none' : '';
            var hasLocalMloAp = mlo && (_data.mlds || []).some(function(m) { return m.mode === 'ap'; });
            mloConflictNote.style.display = hasLocalMloAp ? 'block' : 'none';
            goBtn.disabled = hasLocalMloAp;
        });

        var ipSel    = selectEl([['dhcp','DHCP'],['static','Static']], 'dhcp');
        var ifaceSel = networkSel('wwan', true);
        var bssidIn  = inputField('', 'AA:BB:CC:DD:EE:FF');
        var STA_ENC_OPTS = {
            radio0: [['auto','auto'],['sae-mixed','WPA2/WPA3'],['sae','WPA3'],['psk2','WPA2'],['none','Open']],
            radio1: [['auto','auto'],['sae-mixed','WPA2/WPA3'],['sae','WPA3'],['psk2','WPA2'],['none','Open']]
        };
        var encSel   = selectEl(STA_ENC_OPTS.radio1, 'auto');
        var wdsCb    = checkbox(false);

        function updateStaEnc() {
            var band = mloCb.checked ? 'radio1' : bandSel.value;
            var opts = STA_ENC_OPTS[band] || STA_ENC_OPTS.radio1;
            while (encSel.firstChild) encSel.removeChild(encSel.firstChild);
            opts.forEach(function(o) { encSel.appendChild(node('option', { value: o[0] }, o[1])); });
        }
        bandSel.addEventListener('change', function() { updateStaEnc(); updateBandNote(); });
        mloCb.addEventListener('change', updateStaEnc);

        var advBody = node('div', { style: 'margin-top:4px' });
        advBody.appendChild(formRow('IP mode', ipSel));
        advBody.appendChild(formRow('Network', ifaceSel));
        advBody.appendChild(formRow('BSSID lock', bssidIn));
        advBody.appendChild(formRow('Encryption', encSel));
        advBody.appendChild(formRow('WDS mode', wdsCb));
        body.appendChild(collapsible('wiz_sta_adv', 'Advanced parameters', function() { return advBody; }, false));

        var goBtn = btn('Add Station', null, function() {
            var ssid = ssidIn.value.trim();
            if (!ssid) { body.appendChild(inlineErr('SSID is required')); return; }
            var isMlo = mloCb.checked;
            var p = { ssid: ssid, network: ifaceSel._getValue() };
            if (passIn.value)            p.key        = passIn.value;
            if (bssidIn.value.trim())    p.bssid      = bssidIn.value.trim();
            if (encSel.value !== 'auto') p.encryption = encSel.value;
            if (wdsCb.checked)           p.wds        = '1';
            if (isMlo) {
                p.mlo                    = '1';
                p.mld_assoc_phy          = parseInt(assocSel.value);
                p.mld_allowed_phy_bitmap = 7;
            }
            applyFlow(applyDiv, function() {
                return layer3.wizard_sta(isMlo ? 'radio1' : bandSel.value, p);
            }, function() { close(); if (onDone) onDone(); }, setCloseable);
        });
        body.appendChild(node('div', { style: 'margin-top:12px' }, goBtn));
        body.appendChild(applyDiv);
    });
}

function wizardWDS(onDone) {
    openModal('Add WDS / Bridge', function(body, close, setCloseable) {
        var ssidIn    = inputField('', 'Upstream SSID');
        var passIn    = inputField('', 'Password', 'password');
        var remoteMac = inputField('', 'AA:BB:CC:DD:EE:FF (optional)');
        var bandSel   = selectEl([['radio0','2.4 GHz'],['radio1','5 GHz']], 'radio1');
        var typeSel   = selectEl([['wds','WDS (4-address)'],['relayd','relayd (ARP proxy)']], 'wds');
        var applyDiv  = node('div', {});

        var WDS_ENC_OPTS = {
            radio0: [['none','Open'],['psk2','WPA2'],['sae-mixed','WPA2/WPA3']],
            radio1: [['none','Open'],['psk2','WPA2'],['sae-mixed','WPA2/WPA3']]
        };
        var encSel  = selectEl(WDS_ENC_OPTS.radio1, 'none');
        var ifaceSel = networkSel('lan');

        function updateEnc() {
            var opts = WDS_ENC_OPTS[bandSel.value] || WDS_ENC_OPTS.radio1;
            while (encSel.firstChild) encSel.removeChild(encSel.firstChild);
            opts.forEach(function(o) { encSel.appendChild(node('option', { value: o[0] }, o[1])); });
        }
        bandSel.addEventListener('change', updateEnc);

        var wdsErrDiv = node('div', {});
        var wdsScanBtn = btnSecondary('Scan', function() {
            wdsScanBtn.disabled = true;
            wdsScanBtn.textContent = 'Scanning…';
            while (wdsErrDiv.firstChild) wdsErrDiv.removeChild(wdsErrDiv.firstChild);
            layer2.uplink_scan(bandSel.value).then(function(res) {
                wdsScanBtn.disabled = false;
                wdsScanBtn.textContent = 'Scan';
                if (!res.ok || !res.data.length) {
                    wdsErrDiv.appendChild(inlineErr('No networks found — try again'));
                    return;
                }
                openModal('Available Networks', function(scanBody, scanClose) {
                    var refreshTimer = null;
                    var autoOn = true;
                    var tbl = node('table', { style: 'width:100%;border-collapse:collapse' });
                    var hdr = node('tr', {});
                    ['Signal','Band','SSID','Ch','Encryption'].forEach(function(h) {
                        hdr.appendChild(node('th', { style: 'text-align:left;padding:4px 8px;opacity:.6;font-size:11px' }, h));
                    });
                    tbl.appendChild(hdr);

                    function renderRows(data) {
                        while (tbl.rows.length > 1) tbl.deleteRow(1);
                        data.forEach(function(bss) {
                            var b = (bss.mhz >= 5925) ? 6 : (bss.mhz >= 5000) ? 5 : 2;
                            var bandLabel = b === 6 ? '6 GHz' : b === 5 ? '5 GHz' : '2.4 GHz';
                            var bandRadio = b === 6 ? 'radio2' : b === 5 ? 'radio1' : 'radio0';
                            var sigPct = bss.quality_max ? Math.round(100 * bss.quality / bss.quality_max) : 0;
                            var sigColor = sigPct >= 66 ? '#4caf50' : sigPct >= 33 ? '#f5a623' : '#e53935';
                            var row = node('tr', { style: 'cursor:pointer;border-top:1px solid rgba(255,255,255,.08)' });
                            row.appendChild(node('td', { style: 'padding:6px 8px' },
                                node('span', { style: 'color:' + sigColor }, sigPct + '%')));
                            row.appendChild(node('td', { style: 'padding:6px 8px' }, bandPill(bandLabel)));
                            row.appendChild(node('td', { style: 'padding:6px 8px;font-weight:500' }, bss.ssid || ''));
                            row.appendChild(node('td', { style: 'padding:6px 8px;opacity:.6' }, String(bss.channel || '')));
                            row.appendChild(node('td', { style: 'padding:6px 8px;opacity:.6;font-size:11px' }, bss.encryption || 'open'));
                            row.addEventListener('mouseenter', function() { row.style.background = 'rgba(255,255,255,.06)'; });
                            row.addEventListener('mouseleave', function() { row.style.background = ''; });
                            row.addEventListener('click', function() {
                                ssidIn.value = bss.ssid || '';
                                bandSel.value = bandRadio;
                                bandSel.dispatchEvent(new Event('change'));
                                var encMap = { 'sae': 'sae-mixed', 'sae-mixed': 'sae-mixed', 'psk2': 'psk2', 'none': 'none' };
                                var encVal = encMap[bss.encryption] || 'auto';
                                if (encSel.querySelector('option[value="' + encVal + '"]'))
                                    encSel.value = encVal;
                                passIn.focus();
                                clearInterval(refreshTimer);
                                scanClose();
                            });
                            tbl.appendChild(row);
                        });
                    }
                    renderRows(res.data);

                    var stopBtn = node('button', {}, '■ Stop');
                    stopBtn.style.cssText = 'background:none;border:none;color:#666;cursor:pointer;font-size:11px;padding:0;margin-left:6px';
                    stopBtn.onclick = function() {
                        autoOn = !autoOn;
                        if (autoOn) {
                            refreshTimer = setInterval(doRefresh, 8000);
                            stopBtn.textContent = '■ Stop';
                        } else {
                            clearInterval(refreshTimer);
                            stopBtn.textContent = '▶ Resume';
                        }
                    };
                    function doRefresh() {
                        if (!tbl.isConnected) { clearInterval(refreshTimer); return; }
                        layer2.uplink_scan('radio0').then(function(newRes) {
                            if (!tbl.isConnected) { clearInterval(refreshTimer); return; }
                            if (newRes.ok && newRes.data.length) renderRows(newRes.data);
                        });
                    }
                    refreshTimer = setInterval(doRefresh, 8000);

                    scanBody.appendChild(node('div', { style: 'display:flex;align-items:center;margin-bottom:6px' },
                        muted('Auto-refresh every 8s ·'), stopBtn));
                    scanBody.appendChild(tbl);
                });
            }).catch(function() {
                wdsScanBtn.disabled = false;
                wdsScanBtn.textContent = 'Scan';
                wdsErrDiv.appendChild(inlineErr('Scan failed — try again'));
            });
        });

        var ssidRow = node('div', { style: 'display:flex;gap:8px;align-items:center' },
            node('div', { style: 'flex:1' }, ssidIn), wdsScanBtn);

        body.appendChild(formRow('SSID', ssidRow));
        body.appendChild(wdsErrDiv);
        body.appendChild(formRow('Password', pwdWrap(passIn)));
        body.appendChild(formRow('Band', bandSel));
        body.appendChild(formRow('Bridge type', typeSel));
        body.appendChild(sp('WDS: L2 bridge, clients share upstream subnet — upstream AP must also have WDS/4-address mode enabled. relayd: ARP proxy, similar result, no AP-side config needed.', 'color:#555;font-size:11px;display:block;margin:-4px 0 4px'));

        var relaydNote = node('div', { style: 'display:none;margin:6px 0 2px;padding:8px 10px;background:rgba(255,165,0,.12);border-left:3px solid #f5a623;border-radius:3px;font-size:12px;color:#f5a623' },
            'Requires the ', node('b', {}, 'relayd'), ' package on this router (apk add relayd).');
        body.appendChild(relaydNote);
        typeSel.addEventListener('change', function() {
            relaydNote.style.display = typeSel.value === 'relayd' ? '' : 'none';
        });

        var advBody = node('div', { style: 'margin-top:4px' });
        advBody.appendChild(formRow('Remote AP MAC', remoteMac));
        advBody.appendChild(formRow('Encryption', encSel));
        advBody.appendChild(formRow('Network', ifaceSel));
        body.appendChild(collapsible('wiz_wds_adv', 'Advanced parameters', function() { return advBody; }, false));

        var goBtn = btn('Add WDS / Bridge', null, function() {
            var ssid = ssidIn.value.trim();
            if (!ssid) { body.appendChild(inlineErr('SSID is required')); return; }
            var useRelayd = typeSel.value === 'relayd';
            applyFlow(applyDiv, function() {
                if (useRelayd) {
                    var p = { ssid: ssid, encryption: encSel.value };
                    if (passIn.value) p.key = passIn.value;
                    if (remoteMac.value.trim()) p.bssid = remoteMac.value.trim();
                    return layer3.wizard_relayd(bandSel.value, p);
                } else {
                    var p = { ssid: ssid, wds: '1', network: ifaceSel._getValue(), encryption: encSel.value };
                    if (passIn.value)           p.key   = passIn.value;
                    if (remoteMac.value.trim()) p.bssid = remoteMac.value.trim();
                    return layer3.wizard_sta(bandSel.value, p);
                }
            }, function() { close(); if (onDone) onDone(); }, setCloseable);
        });
        body.appendChild(node('div', { style: 'margin-top:12px' }, goBtn));
        body.appendChild(applyDiv);
    });
}

function wizardRepeater(onDone) {
    openModal('Set Up Repeater', function(body, close, setCloseable) {
        var uplinkRadioSel = selectEl([['radio1','5 GHz'],['radio0','2.4 GHz']], 'radio1');
        var scanErrDiv = node('div', {});
        var scanArea   = node('div', {});
        var step2      = node('div', { style: 'display:none' });
        var applyDiv   = node('div', {});

        var passIn      = inputField('', 'Upstream password', 'password');
        var localSsidIn = inputField('', 'Local SSID');
        var localPassIn = inputField('', 'Local password', 'password');
        var apRadioSel  = selectEl([['radio0','2.4 GHz'],['radio1','5 GHz']], 'radio0');

        var _repRefreshTimer = null;

        function renderRepRows(data) {
            while (scanArea.firstChild) scanArea.removeChild(scanArea.firstChild);
            data.forEach(function(n) {
                var b = (n.mhz >= 5925) ? 6 : (n.mhz >= 5000) ? 5 : 2;
                var bandLabel = b === 6 ? '6 GHz' : b === 5 ? '5 GHz' : '2.4 GHz';
                var sigPct = n.quality_max ? Math.round(100 * n.quality / n.quality_max) : 0;
                var sigColor = sigPct >= 66 ? '#4caf50' : sigPct >= 33 ? '#f5a623' : '#e53935';
                var r = node('div', {
                    style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 10px;' +
                           'margin-bottom:4px;border-radius:4px;cursor:pointer;background:#0d1b2a;border:1px solid #2a3a50'
                },
                    node('div', {},
                        sp(n.ssid || '(hidden)', 'color:#ddd;font-size:13px'),
                        muted('  ' + (n.encryption || 'open'))
                    ),
                    node('div', { style: 'display:flex;align-items:center;gap:8px' },
                        bandPill(bandLabel),
                        node('span', { style: 'color:' + sigColor }, sigPct + '%')
                    )
                );
                r.addEventListener('mouseenter', function() { r.style.background = 'rgba(255,255,255,.06)'; });
                r.addEventListener('mouseleave', function() { r.style.background = '#0d1b2a'; });
                r.onclick = function() {
                    clearInterval(_repRefreshTimer);
                    scanArea.style.display = 'none';
                    step2.style.display = 'block';
                    while (step2.firstChild) step2.removeChild(step2.firstChild);
                    step2.appendChild(node('div', { style: 'color:#ddd;margin-bottom:10px;font-size:13px' },
                        'Upstream: ', node('strong', {}, n.ssid || '(hidden)')));
                    if (n.encryption !== 'none')
                        step2.appendChild(formRow('Upstream password', pwdWrap(passIn)));
                    if (apRadioSel.value === uplinkRadioSel.value)
                        apRadioSel.value = apRadioSel.value === 'radio0' ? 'radio1' : 'radio0';
                    step2.appendChild(formRow('Local AP radio', apRadioSel));
                    step2.appendChild(formRow('Local SSID', localSsidIn));
                    step2.appendChild(formRow('Local password', pwdWrap(localPassIn)));
                    var backBtn = btnSecondary('Back', function() {
                        step2.style.display = 'none';
                        scanArea.style.display = 'block';
                    });
                    step2.appendChild(node('div', { style: 'display:flex;gap:8px;margin-top:12px' },
                        btn('Set Up Repeater', null, function() {
                            if (uplinkRadioSel.value === apRadioSel.value) {
                                while (applyDiv.firstChild) applyDiv.removeChild(applyDiv.firstChild);
                                applyDiv.appendChild(inlineErr('Uplink and local AP must use different radios'));
                                return;
                            }
                            if (!localSsidIn.value.trim()) {
                                while (applyDiv.firstChild) applyDiv.removeChild(applyDiv.firstChild);
                                applyDiv.appendChild(inlineErr('Local SSID is required'));
                                return;
                            }
                            applyFlow(applyDiv, function() {
                                return layer3.wizard_repeater(
                                    uplinkRadioSel.value, apRadioSel.value,
                                    { ssid: n.ssid, encryption: n.encryption, key: passIn.value || undefined, network: 'wwan' },
                                    { ssid: localSsidIn.value, key: localPassIn.value || undefined }
                                );
                            }, function() { close(); if (onDone) onDone(); }, setCloseable);
                        }),
                        backBtn
                    ));
                };
                scanArea.appendChild(r);
            });
        }

        function doScan() {
            scanBtn.disabled = true;
            scanBtn.textContent = 'Scanning…';
            while (scanErrDiv.firstChild) scanErrDiv.removeChild(scanErrDiv.firstChild);
            layer2.uplink_scan(uplinkRadioSel.value).then(function(res) {
                scanBtn.disabled = false;
                scanBtn.textContent = 'Scan';
                if (!res.ok || !res.data.length) {
                    while (scanArea.firstChild) scanArea.removeChild(scanArea.firstChild);
                    scanErrDiv.appendChild(inlineErr('No networks found — try again'));
                    return;
                }
                renderRepRows(res.data);
                clearInterval(_repRefreshTimer);
                _repRefreshTimer = setInterval(function() {
                    if (!scanArea.isConnected || step2.style.display !== 'none') return;
                    layer2.uplink_scan('radio0').then(function(newRes) {
                        if (!scanArea.isConnected || step2.style.display !== 'none') return;
                        if (newRes.ok && newRes.data.length) renderRepRows(newRes.data);
                    });
                }, 8000);
            }).catch(function() {
                scanBtn.disabled = false;
                scanBtn.textContent = 'Scan';
                scanErrDiv.appendChild(inlineErr('Scan failed — try again'));
            });
        }

        var scanBtn = btnSecondary('Scan', doScan);

        body.appendChild(node('div', { style: 'color:#666;font-size:12px;margin-bottom:14px;line-height:1.5' },
            'L3 / NAT — connects to upstream WiFi on one radio (STA), re-broadcasts on a different radio (AP). ',
            'Clients get this router\'s LAN IP address.'));
        body.appendChild(formRow('Uplink band', uplinkRadioSel));
        body.appendChild(node('div', { style: 'margin:8px 0' }, scanBtn));
        body.appendChild(scanErrDiv);
        body.appendChild(scanArea);
        body.appendChild(step2);
        body.appendChild(applyDiv);
    });
}

function wizardCountry(onDone) {
    openModal('Change Country / Regulatory', function(body, close, setCloseable) {
        var COUNTRIES = [['AT','Austria'],['AU','Australia'],['BE','Belgium'],['BR','Brazil'],
            ['CA','Canada'],['CH','Switzerland'],['CN','China'],['CZ','Czech Republic'],
            ['DE','Germany'],['DK','Denmark'],['ES','Spain'],['FI','Finland'],['FR','France'],
            ['GB','United Kingdom'],['HU','Hungary'],['IE','Ireland'],['IT','Italy'],['JP','Japan'],
            ['KR','Korea'],['NL','Netherlands'],['NO','Norway'],['NZ','New Zealand'],['PL','Poland'],
            ['PT','Portugal'],['RU','Russia'],['SE','Sweden'],['SK','Slovakia'],['TR','Turkey'],
            ['TW','Taiwan'],['US','United States']];
        var curCountry = (_data && _data.radios && _data.radios[0]) ? (_data.radios[0].country || 'CZ') : 'CZ';
        var countrySel = selectEl(COUNTRIES, curCountry);
        var applyDiv   = node('div', {});

        body.appendChild(node('div', {
            style: 'color:#f5a623;font-size:12px;margin-bottom:12px;padding:8px 10px;background:#2a180044;border-radius:4px;border-left:3px solid #f5a623'
        }, 'Router will reboot after changing the country (~60 seconds to reconnect).'));
        body.appendChild(formRow('Country', countrySel));

        body.appendChild(node('div', { style: 'margin-top:14px' },
            btn('Apply & Reboot', null, function() {
                applyFlow(applyDiv, function() { return layer3.wizard_country(countrySel.value); },
                    function() { close(); if (onDone) onDone(); }, setCloseable);
            })
        ));
        body.appendChild(applyDiv);
    });
}

function scanWidth(bss) {
    var w = '20';
    var ht = bss.ht_op, vht = bss.vht_op, he = bss.he_op, eht = bss.eht_op;
    if (ht) {
        if (ht.secondary_channel_offset === 'above' || ht.secondary_channel_offset === 'below') w = '40';
    }
    if (vht && vht.channel_width > 40) {
        var diff = (vht.center_freq_2 && vht.center_freq_1) ? Math.abs(vht.center_freq_2 - vht.center_freq_1) : 0;
        w = vht.channel_width === 160 ? '160' : diff === 8 ? '160' : diff > 8 ? '80+80' : '80';
    }
    if (he && he.channel_width > 20) w = String(he.channel_width);
    if (eht && eht.channel_width === 320) w = '320';
    return w + ' MHz';
}

function openScanNearby() {
    openModal('Nearby Networks', function(body, close) {
        var refreshTimer = null;
        var autoOn = true;

        var tbl = node('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });
        var hdr = node('tr', {});
        ['Signal','Band','SSID','Ch','Width','BSSID','Encryption'].forEach(function(h) {
            hdr.appendChild(node('th', { style: 'text-align:left;padding:3px 8px;opacity:.5;font-size:11px;white-space:nowrap' }, h));
        });
        tbl.appendChild(hdr);

        function renderRows(data) {
            while (tbl.rows.length > 1) tbl.deleteRow(1);
            data.forEach(function(bss) {
                var b = (bss.mhz >= 5925) ? 6 : (bss.mhz >= 5000) ? 5 : 2;
                var bandLabel = b === 6 ? '6 GHz' : b === 5 ? '5 GHz' : '2.4 GHz';
                var sigPct = bss.quality_max ? Math.round(100 * bss.quality / bss.quality_max) : 0;
                var sigColor = sigPct >= 66 ? '#4caf50' : sigPct >= 33 ? '#f5a623' : '#e53935';
                var row = node('tr', { style: 'border-top:1px solid rgba(255,255,255,.06)' });
                row.appendChild(node('td', { style: 'padding:4px 8px' }, node('span', { style: 'color:' + sigColor }, sigPct + '%')));
                row.appendChild(node('td', { style: 'padding:4px 8px' }, bandPill(bandLabel)));
                row.appendChild(node('td', { style: 'padding:4px 8px;color:#ddd;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, bss.ssid || ''));
                row.appendChild(node('td', { style: 'padding:4px 8px;color:#aaa' }, String(bss.channel || '')));
                row.appendChild(node('td', { style: 'padding:4px 8px;color:#aaa;white-space:nowrap' }, scanWidth(bss)));
                row.appendChild(node('td', { style: 'padding:4px 8px;color:#555;font-size:11px;white-space:nowrap' }, bss.bssid || ''));
                row.appendChild(node('td', { style: 'padding:4px 8px;color:#555;font-size:11px' }, bss.encryption || 'open'));
                tbl.appendChild(row);
            });
        }

        function doRefresh() {
            if (!tbl.isConnected) { clearInterval(refreshTimer); return; }
            layer2.uplink_scan('radio0').then(function(res) {
                if (!tbl.isConnected) { clearInterval(refreshTimer); return; }
                if (res.ok && res.data.length) renderRows(res.data);
            });
        }

        var stopBtn = node('button', {}, '■ Stop');
        stopBtn.style.cssText = 'background:none;border:none;color:#666;cursor:pointer;font-size:11px;padding:0;margin-left:6px';
        stopBtn.onclick = function() {
            autoOn = !autoOn;
            if (autoOn) { refreshTimer = setInterval(doRefresh, 8000); stopBtn.textContent = '■ Stop'; }
            else        { clearInterval(refreshTimer); stopBtn.textContent = '▶ Resume'; }
        };

        var statusRow = node('div', { style: 'display:flex;align-items:center;margin-bottom:8px' },
            node('span', { style: 'color:#555;font-size:11px' }, 'Scanning…'));

        body.appendChild(statusRow);
        body.appendChild(tbl);

        layer2.uplink_scan('radio0').then(function(res) {
            while (statusRow.firstChild) statusRow.removeChild(statusRow.firstChild);
            if (!res.ok || !res.data.length) {
                statusRow.appendChild(muted('No networks found'));
                return;
            }
            renderRows(res.data);
            statusRow.appendChild(muted('Auto-refresh every 8s ·'));
            statusRow.appendChild(stopBtn);
            refreshTimer = setInterval(doRefresh, 8000);
        });
    });
}

// ── NETWORKS TAB ──────────────────────────────────────────────────────────────

function renderNetworks(data) {
    var mlds    = data.mlds    || [];
    var ifaces  = data.ifaces  || [];
    var clients = data.clients || [];
    var radios  = data.radios  || [];
    var el      = node('div', {});

    // Client count per ifname
    var cliCount = {};
    clients.forEach(function(c) { if (c.ifname) cliCount[c.ifname] = (cliCount[c.ifname] || 0) + 1; });

    // Country from first radio
    var country = radios.length ? (radios[0].country || '—') : '—';

    // ── Top bar ──
    var hdr = node('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px' });
    hdr.appendChild(sp('Networks', 'color:#ddd;font-weight:bold;font-size:14px'));

    var ddWrap = node('div', { style: 'position:relative' });
    var ddBtn  = node('button', {
        style: 'padding:5px 14px;background:#185fa5;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px'
    }, 'Add network ▾');
    var ddMenu = node('div', {
        style: 'display:none;position:absolute;right:0;top:calc(100% + 4px);background:#111e30;' +
               'border:1px solid #2a3a50;border-radius:6px;z-index:100;min-width:180px;overflow:hidden'
    });
    [
        ['Access point',       function() { wizardAP(_onApplied); }],
        ['Access point (MLO)', function() { wizardMLO(_onApplied); }],
        ['Station',            function() { wizardStation(_onApplied); }],
        ['WDS / Bridge',       function() { wizardWDS(_onApplied); }],
        ['Repeater',           function() { wizardRepeater(_onApplied); }]
    ].forEach(function(item) {
        var row = node('div', { style: 'padding:9px 14px;cursor:pointer;color:#ccc;font-size:13px' }, item[0]);
        row.onmouseenter = function() { row.style.background = '#1a2a3a'; };
        row.onmouseleave = function() { row.style.background = ''; };
        row.onclick = function(e) { e.stopPropagation(); ddMenu.style.display = 'none'; item[1](); };
        ddMenu.appendChild(row);
    });
    ddBtn.onclick = function(e) {
        e.stopPropagation();
        ddMenu.style.display = ddMenu.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', function() { ddMenu.style.display = 'none'; });
    ddWrap.appendChild(ddBtn);
    ddWrap.appendChild(ddMenu);
    var topBtns = node('div', { style: 'display:flex;gap:8px;align-items:center' },
        btnSecondary('Scan nearby', function() { openScanNearby(); }),
        ddWrap
    );
    hdr.appendChild(topBtns);
    el.appendChild(hdr);

    // ── Network list ──
    var allNets = [];
    mlds.forEach(function(m) { allNets.push({ type: m.mode === 'sta' ? 'MLO STA' : 'MLO AP', iface: m }); });
    ifaces.filter(function(i) { return !i.mlo; }).forEach(function(i) {
        allNets.push({ type: i.mode === 'ap' ? 'AP' : 'STA', iface: i });
    });

    var list = node('div', { style: 'border:1px solid #1a2a3a;border-radius:6px;overflow:hidden' });
    if (!allNets.length) {
        list.appendChild(node('div', { style: 'color:#555;padding:24px;font-size:14px;text-align:center' }, 'No networks configured.'));
    }
    allNets.forEach(function(net, idx) {
        list.appendChild(netRow(net.type, net.iface, data, cliCount, country, idx === allNets.length - 1));
    });
    el.appendChild(list);
    return el;
}

function netRow(type, iface, data, cliCount, country, isLast) {
    var sid    = iface.sid;
    var ssid   = iface.ssid || '(no SSID)';
    var enc    = iface.encryption || 'none';
    var is_mld = (type === 'MLO AP' || type === 'MLO STA');
    var rids   = is_mld
        ? (iface.radios || [])
        : (Array.isArray(iface.device) ? iface.device : [iface.device].filter(Boolean));
    var status = is_mld
        ? (iface.links && iface.links.length ? 'ENABLED' : 'DOWN')
        : (iface.status || 'DISABLED');
    var isUp   = status === 'ENABLED' || status === 'UP';
    var nCli   = (type !== 'STA' && iface.ifname) ? (cliCount[iface.ifname] || 0) : 0;

    var expanded = (_netExpandState[sid] && _netExpandState[sid].expanded) || false;
    var editMode = (_netExpandState[sid] && _netExpandState[sid].editMode) || false;
    var applyDiv = node('div', {});

    var wrapper = node('div', { style: isLast ? '' : 'border-bottom:1px solid #1a2a3a' });

    // ── Collapsed row ──
    var row = node('div', { style: 'display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer' });
    row.onmouseenter = function() { row.style.background = '#1a2535'; };
    row.onmouseleave = function() { row.style.background = ''; };

    row.appendChild(sp('●', 'color:' + (isUp ? '#1d9e75' : '#444') + ';font-size:10px;flex-shrink:0'));

    var nameWrap = node('div', { style: 'display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow:hidden' });
    nameWrap.appendChild(sp(ssid, 'color:#ddd;font-weight:bold;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'));
    nameWrap.appendChild(sp(type, 'font-size:11px;padding:1px 6px;background:#1a2a3a;color:#888;border-radius:3px;flex-shrink:0'));
    if (iface.wds) nameWrap.appendChild(sp('WDS', 'font-size:11px;padding:1px 6px;background:#1a2a3a;color:#f5a623;border-radius:3px;flex-shrink:0'));
    if (iface.repeater) {
        var _repPeer = (data.ifaces || []).find(function(i) { return i.repeater && i !== iface; });
        var _repLabel = iface.mode === 'sta'
            ? (_repPeer ? '→ ' + _repPeer.ssid : 'repeater uplink')
            : (_repPeer ? '← ' + _repPeer.ssid : 'repeater AP');
        nameWrap.appendChild(sp(_repLabel, 'font-size:11px;padding:1px 6px;background:#1a2a3a;color:#81c784;border-radius:3px;flex-shrink:0'));
    }
    if (data.relayd && data.relayd.active && iface.network && iface.network === data.relayd.uplink_net)
        nameWrap.appendChild(sp('relayd', 'font-size:11px;padding:1px 6px;background:#1a2a3a;color:#4fc3f7;border-radius:3px;flex-shrink:0'));
    var _gbEl = (function() {
        if (is_mld) return genBadge('EHT');
        var _rid = Array.isArray(iface.device) ? iface.device[0] : iface.device;
        var _r = (_rid && data.radios) ? data.radios.find(function(r) { return r.id === _rid; }) : null;
        return (_r && _r.htmode) ? genBadge(_r.htmode) : null;
    })();
    if (_gbEl) nameWrap.appendChild(_gbEl);
    row.appendChild(nameWrap);

    var meta = node('div', { style: 'display:flex;align-items:center;gap:5px;flex-shrink:0' });
    rids.forEach(function(rid) { meta.appendChild(bandPill(rid)); });
    meta.appendChild(muted(encLabel(enc)));
    if (nCli > 0) meta.appendChild(muted(' · ' + nCli + (nCli === 1 ? ' client' : ' clients')));
    row.appendChild(meta);

    var editBtn = btn('Edit', '#1e2a3a', function(e) {
        e.stopPropagation();
        expanded = true; editMode = true; refresh();
    });
    editBtn.style.cssText += ';padding:3px 10px;font-size:12px;flex-shrink:0';

    var removeBtn = btnDanger('✕', function(e) {
        e.stopPropagation();
        var warn = is_mld
            ? 'Remove "' + ssid + '"? All clients on all bands will disconnect.'
            : 'Remove "' + ssid + '"?';
        if (!confirm(warn)) return;
        delete _netExpandState[sid];
        applyFlow(applyDiv, function() {
            var isRelaydUplink = !is_mld && data.relayd && data.relayd.active &&
                iface.network && iface.network === data.relayd.uplink_net;
            var isRepeaterSta = !is_mld && iface.repeater && iface.mode === 'sta';
            var prom = is_mld ? layer2.mld_remove(sid) : layer2.iface_remove(sid);
            if (isRelaydUplink) prom = prom.then(function() { return layer2.relayd_remove(); });
            if (isRepeaterSta) prom = prom.then(function() { return layer2.repeater_fw_remove(); });
            return prom.then(function(r) { return Object.assign({ restartRequired: 'wifi' }, r); });
        }, _onApplied);
    });
    removeBtn.style.cssText += ';padding:3px 8px;font-size:12px;flex-shrink:0';

    row.appendChild(editBtn);
    row.appendChild(removeBtn);

    var chevron = sp('▼', 'color:#555;font-size:10px;flex-shrink:0');
    row.appendChild(chevron);

    row.onclick = function() { expanded = !expanded; if (!expanded) editMode = false; refresh(); };

    // ── Detail panel ──
    var panel = node('div', { style: 'display:none;background:#0d1520;padding:12px 14px;border-top:1px solid #1a2a3a' });

    function refresh() {
        if (expanded) { _netExpandState[sid] = { expanded: true, editMode: editMode }; }
        else          { delete _netExpandState[sid]; }
        chevron.textContent = expanded ? '▲' : '▼';
        panel.style.display = expanded ? 'block' : 'none';
        while (panel.firstChild) panel.removeChild(panel.firstChild);
        if (expanded) panel.appendChild(editMode ? buildEditForm() : buildDetail());
    }

    function kvGrid(items) {
        var g = node('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-bottom:10px' });
        items.forEach(function(it) {
            if (!it) { g.appendChild(node('div', {})); return; }
            var cell = node('div', {});
            cell.appendChild(lbl(it[0]));
            if (it[1] && it[1].nodeType) {
                cell.appendChild(it[1]);
            } else {
                cell.appendChild(node('div', { style: 'color:#ddd;font-size:13px;margin-top:2px' }, String(it[1] == null ? '—' : it[1])));
            }
            g.appendChild(cell);
        });
        return g;
    }

    function buildDetail() {
        var b = node('div', {});

        if (is_mld) {
            // Config fields — add new fields here
            var cfgItems = [
                ['SSID',           ssid],
                ['Encryption',     encLabel(enc)],
                ['Interface',      iface.ifname  || '—'],
                ['Network (L3)',   iface.network || '—'],
                ['MLD address',    iface.mld_addr || '—'],
                ['Isolate clients',iface.isolate ? 'Yes' : 'No'],
                ['Allowed links',  iface.mld_allowed_links != null ? String(iface.mld_allowed_links) : '—'],
                ['EML disabled',   iface.eml_disable ? 'Yes' : 'No'],
                ['Country',        country],
            ];
            b.appendChild(kvGrid(cfgItems));

            // Per-link table
            var links = iface.links || [];
            if (links.length) {
                b.appendChild(sp('Links', 'display:block;color:#88888899;font-size:11px;font-weight:bold;letter-spacing:0.5px;margin:10px 0 6px'));
                var tbl = node('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });
                var thead = node('tr', { style: 'color:#555' });
                ['Link','Freq','CH','BW','TX','DFS','Util'].forEach(function(h) {
                    thead.appendChild(node('th', { style: 'text-align:left;padding:2px 8px;font-weight:normal' }, h));
                });
                tbl.appendChild(thead);
                links.forEach(function(lk) {
                    var tr = node('tr', { style: 'color:#aaa' });
                    [String(lk.link_id),
                     lk.freq    ? lk.freq    + ' MHz' : '—',
                     lk.channel ? String(lk.channel) : '—',
                     lk.bw_mhz ? lk.bw_mhz + ' MHz' : '—',
                     lk.txpower != null ? lk.txpower + ' dBm' : '—',
                     lk.dfs_active ? 'CAC' : '—',
                     lk.chan_util != null ? Math.min(lk.chan_util, 100) + '%' : 'n/a',
                    ].forEach(function(v) {
                        tr.appendChild(node('td', { style: 'padding:3px 8px' }, v));
                    });
                    tbl.appendChild(tr);
                });
                b.appendChild(tbl);
            }

        } else if (iface.mode === 'ap') {
            var radio = rids.length ? (data.radios || []).find(function(r) { return r.id === rids[0]; }) : null;
            // Config + runtime fields — add new fields here
            var apItems = [
                ['SSID',             ssid],
                ['Encryption',       encLabel(enc)],
                ['Interface',        iface.ifname  || '—'],
                ['Network (L3)',     iface.network || '—'],
                ['Hidden SSID',      iface.hidden  ? 'Yes' : 'No'],
                ['Isolate clients',  iface.isolate ? 'Yes' : 'No'],
                ['Max stations',     iface.maxassoc != null ? String(iface.maxassoc) : '—'],
                null, null,
                ['Channel',  radio ? (radio.channel ? String(radio.channel) : 'auto') : '—'],
                ['Width',    radio ? (radio.htmode || '—') : '—'],
                ['TX power', radio && radio.txpower_actual != null ? radio.txpower_actual + ' dBm' : '—'],
            ];
            b.appendChild(kvGrid(apItems));

        } else {
            // STA config fields — add new fields here
            var staItems = [
                ['SSID',         ssid],
                ['Encryption',   encLabel(enc)],
                ['Interface',    iface.ifname  || '—'],
                ['Network (L3)', iface.network || '—'],
            ];
            b.appendChild(kvGrid(staItems));

            // Uplink connection status
            var uplink = (data.uplinks || []).find(function(u) { return u.sid === sid; });
            if (uplink) {
                b.appendChild(sp('Connection status', 'display:block;color:#88888899;font-size:11px;font-weight:bold;letter-spacing:0.5px;margin:10px 0 6px'));
                var _staRadio = (iface.radio && data.radios) ? data.radios.find(function(r) { return r.id === iface.radio; }) : null;
                var _staNoise = _staRadio && _staRadio.noise != null ? _staRadio.noise : null;
                // Add new connection fields here
                var connItems = [
                    ['State',      uplink.wpa_state  || '—'],
                    ['BSSID',      uplink.bssid      || '—'],
                    ['IP address', uplink.ip_address || '—'],
                    ['Signal',     uplink.signal     != null ? uplink.signal + (_staNoise != null ? ' / ' + _staNoise : '') + ' dBm' : '—'],
                    ['TX / RX',    (uplink.tx_bitrate || '?') + ' / ' + (uplink.rx_bitrate || '?')],
                    ['WiFi gen.',  uplink.wifi_generation ? 'WiFi ' + uplink.wifi_generation : '—'],
                ];
                b.appendChild(kvGrid(connItems));

                if (uplink.is_mlo && uplink.links && uplink.links.length) {
                    b.appendChild(sp('Per-link (WiFi 7)', 'display:block;color:#888;font-size:12px;margin:8px 0 4px'));
                    var ltbl = node('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });
                    var lhead = node('tr', { style: 'color:#555' });
                    ['Link','Freq','BW','Signal','TX','RX'].forEach(function(h) {
                        lhead.appendChild(node('th', { style: 'text-align:left;padding:2px 6px;font-weight:normal' }, h));
                    });
                    ltbl.appendChild(lhead);
                    uplink.links.forEach(function(lk) {
                        var tr = node('tr', { style: 'color:#aaa' });
                        [String(lk.link_id),
                         lk.freq   ? lk.freq + ' MHz' : '—',
                         lk.bw_mhz ? lk.bw_mhz + ' MHz' : '—',
                         lk.signal != null ? lk.signal + ' dBm' : '—',
                         lk.tx_bitrate || '—', lk.rx_bitrate || '—',
                        ].forEach(function(v) { tr.appendChild(node('td', { style: 'padding:3px 6px' }, v)); });
                        ltbl.appendChild(tr);
                    });
                    b.appendChild(ltbl);
                }
            }
        }

        var btnBar = node('div', { style: 'display:flex;gap:8px;margin-top:10px' });
        btnBar.appendChild(btn('Edit', null, function() { editMode = true; refresh(); }));
        btnBar.appendChild(btnDanger('Remove', function() {
            var warn = is_mld
                ? 'Remove "' + ssid + '"? All clients on all bands will disconnect.'
                : 'Remove "' + ssid + '"?';
            if (!confirm(warn)) return;
            applyFlow(applyDiv, function() {
                var prom = is_mld ? layer2.mld_remove(sid) : layer2.iface_remove(sid);
                return prom.then(function(r) { return Object.assign({ restartRequired: 'wifi' }, r); });
            }, _onApplied);
        }));
        b.appendChild(btnBar);
        return b;
    }

    function buildEditForm() {
        // Field definitions — add new editable fields here (one line each).
        // types: text | number | password | select | checkbox
        var defs;
        if (is_mld) {
            defs = [
                { label: 'SSID',             key: 'ssid',       type: 'text',     val: ssid },
                { label: 'Password',         key: 'key',        type: 'password', val: iface.key || '' },
                { label: 'Security',         key: 'encryption', type: 'select',   opts: [['sae','WPA3'],['sae-mixed','WPA2/WPA3'],['owe','OWE']], val: enc },
                { label: 'Network',          key: 'network',    type: 'network',  val: iface.network || 'lan' },
                { label: 'Client isolation', key: 'isolate',    type: 'checkbox', val: iface.isolate },
            ];
        } else if (iface.mode === 'ap') {
            var apRadio = rids.length ? (data.radios || []).find(function(r) { return r.id === rids[0]; }) : null;
            var apBand  = apRadio ? apRadio.id : 'radio1';
            var apHtOpts = apBand === 'radio2'
                ? [['EHT320','320 MHz'],['EHT160','160 MHz'],['EHT80','80 MHz'],['EHT40','40 MHz'],['EHT20','20 MHz']]
                : apBand === 'radio1'
                    ? [['EHT160','160 MHz'],['EHT80','80 MHz'],['EHT40','40 MHz'],['EHT20','20 MHz'],['VHT160','160 MHz (VHT)']]
                    : [['EHT40','40 MHz'],['EHT20','20 MHz'],['HT40+','HT40+'],['HT40-','HT40-'],['HT20','20 MHz (HT)']];
            var apChVal = apRadio ? (apRadio.channel === 'auto' || apRadio.channel == null ? 'auto' : String(apRadio.channel)) : 'auto';
            var apChIn  = inputField(apChVal, 'auto or number');
            var apHtIn  = selectEl(apHtOpts, apRadio ? apRadio.htmode : null);
            defs = [
                { label: 'SSID',             key: 'ssid',      type: 'text',     val: ssid },
                { label: 'Password',         key: 'key',       type: 'password', val: iface.key || '' },
                { label: 'Security',         key: 'encryption',type: 'select',   opts: [['psk2','WPA2'],['sae-mixed','WPA2/WPA3'],['sae','WPA3'],['none','Open']], val: enc },
                { label: 'Network',          key: 'network',   type: 'network',  val: iface.network || 'lan' },
                { label: 'Max stations',     key: 'maxassoc',  type: 'number',   val: iface.maxassoc != null ? String(iface.maxassoc) : '', placeholder: 'unlimited' },
                { label: 'Hidden SSID',      key: 'hidden',    type: 'checkbox', val: iface.hidden },
                { label: 'Client isolation', key: 'isolate',   type: 'checkbox', val: iface.isolate },
                { label: 'WDS bridge',       key: 'wds',       type: 'checkbox', val: iface.wds },
            ];
        } else {
            defs = [
                { label: 'SSID',     key: 'ssid',       type: 'text',     val: ssid },
                { label: 'Password', key: 'key',        type: 'password', val: iface.key || '' },
                { label: 'Security', key: 'encryption', type: 'select',   opts: [['psk2','WPA2'],['sae-mixed','WPA2/WPA3'],['sae','WPA3'],['none','Open']], val: enc },
                { label: 'Network',  key: 'network',    type: 'network',  val: iface.network || 'wwan', forSTA: true },
            ];
        }

        var ctrls = {};
        var b = node('div', {});
        defs.forEach(function(d) {
            var ctrl;
            if      (d.type === 'text' || d.type === 'number') ctrl = inputField(d.val || '', d.placeholder || '');
            else if (d.type === 'password') ctrl = inputField(d.val, 'password');
            else if (d.type === 'select')   ctrl = selectEl(d.opts, d.val);
            else if (d.type === 'checkbox') ctrl = checkbox(!!d.val);
            else if (d.type === 'network')  ctrl = networkSel(d.val, d.forSTA);
            ctrls[d.key] = ctrl;
            b.appendChild(d.type === 'password' ? formRow(d.label, pwdWrap(ctrl)) : formRow(d.label, ctrl));
        });

        // Radio-level controls for AP mode
        if (iface.mode === 'ap' && apRadio) {
            b.appendChild(node('div', { style: 'border-top:1px solid #1a2a3a;margin:10px 0 6px' }));
            var apChWrap = node('div', {});
            apChWrap.appendChild(apChIn);
            if (apBand === 'radio1') apChWrap.appendChild(sp('DFS (CAC ~60s): 52–144', 'display:block;color:#555;font-size:11px;margin-top:3px'));
            b.appendChild(formRow('Channel', apChWrap));
            b.appendChild(formRow('Channel width', apHtIn));
        }

        var saveBtn = btn('Save', null, function() {
            var p = {};
            defs.forEach(function(d) {
                var ctrl = ctrls[d.key];
                if (!ctrl) return;
                if      (d.type === 'checkbox') p[d.key] = ctrl.checked ? '1' : '0';
                else if (d.type === 'select')   p[d.key] = ctrl.value;
                else if (d.type === 'network')  { var nv = ctrl._getValue ? ctrl._getValue() : ''; if (nv) p[d.key] = nv; }
                else if (ctrl.value && ctrl.value.trim()) p[d.key] = ctrl.value.trim();
            });
            applyFlow(applyDiv, function() {
                var ifaceProm = is_mld ? layer2.mld_set(sid, p) : layer2.iface_set(sid, p);
                if (iface.mode === 'ap' && apRadio) {
                    var rp = { channel: apChIn.value.trim() || 'auto', htmode: apHtIn.value };
                    return layer2.radio_set(apRadio.id, rp).then(function(rr) {
                        if (!rr.ok) return Object.assign({ restartRequired: 'none' }, rr);
                        return ifaceProm.then(function(r) { return Object.assign({ restartRequired: r.ok ? 'wifi' : 'none' }, r); });
                    });
                }
                return ifaceProm.then(function(r) { return Object.assign({ restartRequired: r.ok ? 'wifi' : 'none' }, r); });
            }, function() { editMode = false; delete _netExpandState[sid]; if (_onApplied) _onApplied(); });
        });
        b.appendChild(node('div', { style: 'display:flex;gap:8px;margin-top:10px' },
            saveBtn, btnSecondary('Cancel', function() { editMode = false; refresh(); })));
        return b;
    }

    wrapper.appendChild(row);
    wrapper.appendChild(panel);
    wrapper.appendChild(applyDiv);
    if (expanded) refresh();
    return wrapper;
}

// ── CLIENTS TAB ───────────────────────────────────────────────────────────────

function renderClients(data) {
    var clients = data.clients || [];
    var el      = node('div', {});

    var ssidMap = {};
    (data.ifaces || []).forEach(function(f) { if (f.ifname && f.ssid) ssidMap[f.ifname] = f.ssid; });
    (data.mlds   || []).forEach(function(m) { if (m.ifname && m.ssid) ssidMap[m.ifname] = m.ssid; });

    var eht  = clients.filter(function(c) { return c.is_mld; }).length;
    var sigs = clients.map(function(c) { return bestClientSignal(c); }).filter(function(s) { return s != null; });
    var avg  = sigs.length ? Math.round(sigs.reduce(function(a,b){ return a+b; }, 0) / sigs.length) : null;

    el.appendChild(node('div', { style: 'color:#666;font-size:12px;margin-bottom:12px' },
        'Total: ' + clients.length + ' client' + (clients.length !== 1 ? 's' : '') +
        (eht ? ' · WiFi 7: ' + eht : '') +
        (avg != null ? ' · Average signal: ' + avg + ' dBm' : '')
    ));

    if (!clients.length) {
        el.appendChild(node('div', { style: 'color:#444;padding:20px 0;font-size:14px' }, 'No clients connected.'));
        return el;
    }

    clients.forEach(function(c) {
        var mac_key = c.mac.replace(/:/g, '');

        // ── HEADER (always visible) ───────────────────────────────────────
        var hdrEl = node('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' });
        hdrEl.appendChild(sp(c.mac, 'color:#ddd;font-family:monospace;font-size:13px'));

        // WiFi gen badge
        var mb = modeBadge((c.tx_bitrate || '') + ' ' + (c.rx_bitrate || ''), c.is_mld);
        if (mb) hdrEl.appendChild(mb);

        // Band pills per active link (or from iface for legacy)
        if (c.links && c.links.length) {
            c.links.forEach(function(lk) {
                var rid = clientLinkBand(c.ifname, lk.link_id, data);
                if (rid) hdrEl.appendChild(bandPill(rid));
            });
        } else {
            var iface = (data.ifaces || []).find(function(f) { return f.ifname === c.ifname; });
            if (iface && iface.radio) hdrEl.appendChild(bandPill(iface.radio));
        }

        // Signal (best per-link for MLO — iw top-level is 0 for MLO)
        hdrEl.appendChild(signalBars(bestClientSignal(c)));

        // Best speed
        var spd = bestClientSpeed(c);
        if (spd) hdrEl.appendChild(muted(spd));

        // Connected time
        if (c.connected_time) hdrEl.appendChild(muted(formatDuration(c.connected_time)));

        // SSID
        if (c.ifname) {
            var cSsid = ssidMap[c.ifname];
            if (cSsid) hdrEl.appendChild(sp('"' + cSsid + '"', 'color:#85b7eb;font-size:12px'));
        }

        // ── BODY (expanded) ───────────────────────────────────────────────
        var deauthDiv = node('div', {});
        var bodyFn = function() {
            var b = node('div', { style: 'margin-top:8px' });

            if (c.flags && c.flags.length) {
                var flags = node('div', { style: 'margin-bottom:8px' });
                c.flags.forEach(function(f) {
                    flags.appendChild(sp(f, 'font-size:11px;padding:1px 6px;background:#1a2a4a;color:#85b7eb;border-radius:3px;margin-right:4px'));
                });
                b.appendChild(flags);
            }

            // For legacy (non-MLO) show TX/RX as plain text; for MLO the per-link table has the real data
            if (!c.is_mld) {
                b.appendChild(rowEl(lbl('TX / RX'), val((c.tx_bitrate || '?') + ' / ' + (c.rx_bitrate || '?'))));
            }

            // Per-link table
            if (c.links && c.links.length) {
                b.appendChild(sp('Per-link', 'display:block;color:#888;font-size:12px;margin:8px 0 4px'));
                var tbl = node('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });
                var th = node('tr', { style: 'color:#555' });
                ['Band', 'Signal', '↓ Download', '↑ Upload'].forEach(function(h) {
                    th.appendChild(node('th', { style: 'text-align:left;padding:2px 6px;font-weight:normal' }, h));
                });
                tbl.appendChild(th);
                c.links.forEach(function(lk) {
                    var tr = node('tr', { style: 'color:#aaa;vertical-align:top' });
                    // Band
                    var bandTd = node('td', { style: 'padding:4px 6px' });
                    var rid = clientLinkBand(c.ifname, lk.link_id, data);
                    if (rid) bandTd.appendChild(bandPill(rid)); else bandTd.appendChild(document.createTextNode('—'));
                    tr.appendChild(bandTd);
                    // Signal — 0 means unmeasured/idle
                    var sigTd = node('td', { style: 'padding:4px 6px;white-space:nowrap' });
                    var lkSig = (typeof lk.signal === 'number' && lk.signal < 0) ? lk.signal : null;
                    var _lkRadio = rid ? (data.radios || []).find(function(r) { return r.id === rid; }) : null;
                    var _lkNoise = _lkRadio && _lkRadio.noise != null ? _lkRadio.noise : null;
                    if (lkSig != null) {
                        var sc = lkSig >= -65 ? '#1d9e75' : lkSig >= -75 ? '#f5a623' : '#e24b4a';
                        sigTd.appendChild(sp(lkSig + (_lkNoise != null ? ' / ' + _lkNoise : '') + ' dBm', 'color:' + sc));
                    } else {
                        sigTd.appendChild(sp('—', 'color:#444'));
                    }
                    tr.appendChild(sigTd);
                    // RX (download) then TX (upload) — speed + detail on two lines
                    [lk.rx_bitrate, lk.tx_bitrate].forEach(function(bitrateStr) {
                        var td = node('td', { style: 'padding:4px 6px' });
                        var p = parseBitrate(bitrateStr);
                        if (p && p.speed) {
                            td.appendChild(node('div', {}, p.speed));
                            if (p.detail) td.appendChild(node('div', { style: 'color:#555;font-size:11px;margin-top:1px' }, p.detail));
                        } else {
                            td.appendChild(sp('—', 'color:#444'));
                        }
                        tr.appendChild(td);
                    });
                    tbl.appendChild(tr);
                });
                b.appendChild(tbl);
            }

            b.appendChild(node('div', { style: 'margin-top:10px' },
                btnDanger('Disconnect client', function() {
                    if (!confirm('Disconnect ' + c.mac + '?')) return;
                    layer2.clients_deauth(c.ifname, c.mac).then(function(r) {
                        while (deauthDiv.firstChild) deauthDiv.removeChild(deauthDiv.firstChild);
                        deauthDiv.appendChild(r.ok ? successBadge('Disconnected') : inlineErr('Failed'));
                    });
                }),
                deauthDiv
            ));
            return b;
        };

        // MLO clients open by default — per-link info is the interesting part
        el.appendChild(card(collapsible('cli_' + mac_key, hdrEl, bodyFn, c.is_mld)));
    });

    return el;
}

// ── RADIOS TAB (Advanced only) ────────────────────────────────────────────────

function renderRadios(data) {
    var radios = data.radios || [];
    var el     = node('div', {});

    // Country + TX power mode card — both system-wide settings
    var country = (radios.length ? radios[0].country : null) || '—';
    var curTxMode = (radios.length ? radios[0].txpower_mode : null) || 'regdb';
    var TX_MODES = [['regdb','Regulatory (country regdb)'],['efuse_max','eFuse max (hardware maximum)'],['manual','Manual (per-radio dBm)']];
    var txModeSel = selectEl(TX_MODES, curTxMode);
    var radioTxInputs = []; // populated in radios.forEach below; used by system Apply & Reboot
    txModeSel.onchange = function() {
        var isManual = txModeSel.value === 'manual';
        el.querySelectorAll('.txpower-manual-row').forEach(function(row) { row.style.display = isManual ? '' : 'none'; });
    };
    var sysApplyDiv = node('div', {});
    var modeHints = {
        regdb:     'Regulatory: country SKU table enforced — stays within legal limits.',
        efuse_max: 'eFuse max: hardware maximum, ignores country limits. Use only if you know what you\'re doing.',
        manual:    'Manual: enter dBm limits in the radio cards below, then click Apply & Reboot here — mode and limits are saved in one step.'
    };
    var modeHintEl = sp(modeHints[curTxMode] || '', 'color:#555;font-size:11px;margin-bottom:8px;display:block');
    txModeSel.addEventListener('change', function() { modeHintEl.textContent = modeHints[txModeSel.value] || ''; });
    el.appendChild(card(node('div', {},
        node('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px' },
            node('div', {},
                lbl('Country '),
                node('span', { style: 'color:#ddd;font-size:15px;font-weight:bold' }, country),
                sp('  — reboot required to change', 'color:#555;font-size:11px')
            ),
            btn('Change', '#1e2a3a', function() { wizardCountry(_onApplied); })
        ),
        formRow('TX power mode', txModeSel),
        modeHintEl,
        node('div', { style: 'display:flex;gap:8px' },
            btn('Apply & Reboot', null, function() {
                applyFlow(sysApplyDiv, function() {
                    var mode = txModeSel.value;
                    return layer2.system_set_txpower_mode(mode).then(function(modeRes) {
                        if (!modeRes.ok || mode !== 'manual') return modeRes;
                        var txPromises = radioTxInputs
                            .filter(function(item) { return item.txIn.value.trim(); })
                            .map(function(item) { return layer2.radio_set(item.rid, { txpower: item.txIn.value.trim() }); });
                        if (!txPromises.length) return modeRes;
                        return Promise.all(txPromises).then(function() { return modeRes; });
                    });
                }, _onApplied);
            })
        ),
        sysApplyDiv
    )));

    radios.forEach(function(r) {
        var applyDiv = node('div', {});
        var htOpts = r.id === 'radio2'
            ? [['EHT320','320 MHz (EHT)'],['EHT160','160 MHz (EHT)'],['EHT80','80 MHz'],['EHT40','40 MHz'],['EHT20','20 MHz']]
            : r.id === 'radio1'
                ? [['EHT160','160 MHz (EHT)'],['EHT80','80 MHz'],['EHT40','40 MHz'],['EHT20','20 MHz'],['VHT160','160 MHz (VHT)']]
                : [['EHT40','40 MHz (EHT)'],['EHT20','20 MHz'],['HT40+','HT40+'],['HT40-','HT40-'],['HT20','20 MHz (HT)']];

        var chIn   = inputField(r.channel === 'auto' || r.channel == null ? 'auto' : String(r.channel), 'auto or channel number');
        var htSel  = selectEl(htOpts, r.htmode);
        var txIn   = inputField(r.txpower_uci != null ? String(r.txpower_uci) : '', '1–30 dBm');
        radioTxInputs.push({ rid: r.id, txIn: txIn });
        var bgIn   = checkbox(r.background_radar);
        var nsIn   = checkbox(r.noscan);
        var disIn  = checkbox(r.disabled);
        // LPI — 6 GHz only
        var lpiPsdIn  = r.id === 'radio2' ? checkbox(r.lpi_psd)         : null;
        var lpiEnhIn  = r.id === 'radio2' ? checkbox(r.lpi_bcn_enhance) : null;
        var lpiSkuIn  = r.id === 'radio2' ? inputField(r.lpi_sku_idx != null ? String(r.lpi_sku_idx) : '', '0–255') : null;
        // Advanced radio params
        var twtIn     = checkbox(r.he_twt_responder);
        var legIn     = r.id === 'radio0' ? checkbox(r.legacy_rates) : null;
        var srIn      = checkbox(r.sr_enable);
        var txbfIn    = checkbox(r.etxbfen);

        var bodyFn = function() {
            var b = node('div', { style: 'margin-top:10px' });
            var chWrap = node('div', {});
            chWrap.appendChild(chIn);
            if (r.id === 'radio1') chWrap.appendChild(sp('DFS channels (CAC ~60s): 52–144', 'display:block;color:#555;font-size:11px;margin-top:3px'));
            b.appendChild(formRow('Channel', chWrap));
            b.appendChild(formRow('Channel width', htSel));
            var txRow = formRow('TX power (dBm)', txIn);
            txRow.className = 'txpower-manual-row';
            txRow.style.display = (r.txpower_mode === 'manual' || txModeSel.value === 'manual') ? '' : 'none';
            b.appendChild(txRow);
            b.appendChild(formRow('Background radar', bgIn));
            b.appendChild(formRow('No scan', nsIn));
            if (lpiPsdIn)  b.appendChild(formRow('LPI PSD', lpiPsdIn));
            if (lpiEnhIn)  b.appendChild(formRow('LPI beacon enhance', lpiEnhIn));
            if (lpiSkuIn)  b.appendChild(formRow('LPI SKU index', lpiSkuIn));
            b.appendChild(formRow('TWT responder', twtIn));
            if (legIn) {
                b.appendChild(formRow('Legacy rates (b/g)', legIn));
                b.appendChild(sp('Enable only if you have 802.11b/g devices — reduces 2.4GHz performance for all clients.', 'color:#555;font-size:11px;display:block;margin:-4px 0 4px'));
            }
            b.appendChild(formRow('Spatial reuse', srIn));
            b.appendChild(formRow('Explicit TxBF', txbfIn));
            b.appendChild(node('div', { style: 'background:#1a1a0044;border:1px solid #f5a62344;border-radius:4px;padding:6px 10px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between' },
                sp('Disabled', 'color:#e24b4a99;font-size:12px'),
                disIn
            ));
            b.appendChild(node('div', { style: 'display:flex;gap:8px' },
                btn('Apply', null, function() {
                    if (disIn.checked && !r.disabled) {
                        if (!confirm('WARNING: Disabling this radio changes the WiFi 7 topology. Re-enabling requires a power cycle. Continue?')) return;
                    }
                    var p = { channel: chIn.value.trim() || 'auto', htmode: htSel.value,
                              background_radar: bgIn.checked ? '1' : '0',
                              noscan: nsIn.checked ? '1' : '0',
                              disabled: disIn.checked ? '1' : '0' };
                    if (txIn.value.trim()) p.txpower = txIn.value.trim();
                    if (lpiPsdIn  !== null) p.lpi_psd         = lpiPsdIn.checked  ? '1' : '0';
                    if (lpiEnhIn  !== null) p.lpi_bcn_enhance  = lpiEnhIn.checked  ? '1' : '0';
                    if (lpiSkuIn  !== null && lpiSkuIn.value.trim()) p.lpi_sku_idx = lpiSkuIn.value.trim();
                    p.he_twt_responder = twtIn.checked  ? '1' : '0';
                    p.sr_enable        = srIn.checked   ? '1' : '0';
                    p.etxbfen          = txbfIn.checked ? '1' : '0';
                    if (legIn !== null) p.legacy_rates  = legIn.checked  ? '1' : '0';
                    applyFlow(applyDiv, function() { return layer2.radio_set(r.id, p); }, _onApplied);
                })
            ));
            b.appendChild(applyDiv);
            return b;
        };

        var hdrEl = node('div', { style: 'display:flex;align-items:center;gap:8px' },
            bandPill(r.id),
            sp('CH ' + (r.channel || '?') + ' · ' + (r.htmode || '?') + ' · TX ' + (r.txpower_actual != null ? r.txpower_actual + ' dBm' : '?'), 'color:#888;font-size:12px'),
            statusBadge(r.disabled ? 'DOWN' : (r.up ? 'UP' : 'DOWN'))
        );

        el.appendChild(card(collapsible('radio_' + r.id, hdrEl, bodyFn, true)));
    });

    return el;
}

// ── DIAGNOSTICS TAB ───────────────────────────────────────────────────────────

function renderDiagnostics(diag) {
    var el  = node('div', {});

    if (!diag) {
        el.appendChild(node('div', { style: 'color:#555;padding:20px 0' }, 'Loading diagnostics...'));
        return el;
    }

    var sysinfo = diag.sysinfo || {};
    var radios  = (_data && _data.radios)  || [];
    var clients = (_data && _data.clients) || [];

    // Thermal inline — compact, tucked into Firmware card footer
    var wifiTemp = sysinfo.wifi_temp || {};
    var thermal  = sysinfo.thermal  || {};
    var TEMP_BANDS = [['band0','2.4G'],['band1','5G'],['band2','6G']];
    var socTemps = ['eth2p5g-thermal','eth2p5g-1-thermal'].map(function(n) { return thermal[n]; }).filter(function(v) { return v != null; });
    var tempRow = node('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:6px;border-top:1px solid #1a2a3a' },
        sp('Temp:', 'color:#444;font-size:11px')
    );
    TEMP_BANDS.forEach(function(b) {
        var mc = wifiTemp[b[0]];
        if (mc == null) return;
        var t = Math.round(mc / 1000);
        var c = t > 80 ? '#e24b4a' : t > 65 ? '#f5a623' : '#1d9e75';
        tempRow.appendChild(sp(b[1] + ' ' + t + '°', 'font-size:11px;color:' + c));
    });
    if (socTemps.length) {
        var st = Math.round(Math.max.apply(null, socTemps) / 1000);
        tempRow.appendChild(sp('SoC ' + st + '°', 'font-size:11px;color:#444'));
    }

    // FW version + temp footer
    el.appendChild(card(
        sp('FIRMWARE', 'display:block;color:#88888899;font-size:11px;font-weight:bold;margin-bottom:6px;letter-spacing:0.5px'),
        node('pre', { style: 'color:#aaa;font-size:12px;font-family:monospace;margin:0;white-space:pre-wrap;word-break:break-all' },
            sysinfo.fw_version || '—'),
        tempRow
    ));

    // Per-radio WiFi stats card
    if (radios.length) {
        var statsCard = card(
            sp('RADIO STATS', 'display:block;color:#88888899;font-size:11px;font-weight:bold;margin-bottom:10px;letter-spacing:0.5px')
        );
        var activeRadios = radios.filter(function(r) { return r.up; });
        activeRadios.forEach(function(r, ri) {
            var clientCount = clients.filter(function(c) {
                var phyIdx = r.id.replace('radio', '');
                return c.ifname && c.ifname.indexOf('phy0.' + phyIdx) === 0;
            }).length;
            var row = node('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' +
                (ri < activeRadios.length - 1 ? ';margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #0d1b2a' : '') });
            row.appendChild(bandPill(r.id));
            var fields = [];
            if (r.channel)                fields.push(['CH',      String(r.channel)]);
            fields.push(['Util', r.chan_util != null ? Math.min(r.chan_util, 100) + '%' : 'n/a']);
            if (r.noise != null)          fields.push(['Noise',   r.noise + ' dBm']);
            if (r.txpower_actual != null) fields.push(['TX',      r.txpower_actual + ' dBm']);
            fields.push(['Clients', String(clientCount)]);
            fields.forEach(function(f) {
                row.appendChild(node('span', { style: 'font-size:12px;white-space:nowrap' },
                    sp(f[0] + ' ', 'color:#555'), sp(f[1], 'color:#ccc')));
            });
            statsCard.appendChild(row);
        });
        el.appendChild(statsCard);
    }

    // Country
    el.appendChild(card(
        node('div', {}, lbl('Country'), node('div', { style: 'color:#ddd;font-size:16px;font-weight:bold;margin-top:2px' }, sysinfo.country || '—'))
    ));

    // Kernel
    if (sysinfo.kernel) {
        el.appendChild(card(collapsible('diag_kernel', 'Kernel', function() {
            return node('pre', { style: 'color:#666;font-size:11px;margin:6px 0 0;white-space:pre-wrap;word-break:break-all' }, sysinfo.kernel);
        }, false)));
    }

    // MLO internals
    var mlds = (_data && _data.mlds) || [];
    if (mlds.length) {
        el.appendChild(card(collapsible('diag_mld', 'MLO / WiFi 7', function() {
            var wrap = node('div', { style: 'margin-top:6px' });
            mlds.forEach(function(m, mi) {
                if (mi > 0) wrap.appendChild(node('div', { style: 'margin-top:10px;padding-top:10px;border-top:1px solid #0d1b2a' }));
                var hdr = node('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:6px' });
                hdr.appendChild(sp('"' + (m.ssid || '?') + '"', 'color:#ddd;font-weight:bold;font-size:12px'));
                hdr.appendChild(sp(m.ifname || '?', 'color:#555;font-size:11px;font-family:monospace'));
                wrap.appendChild(hdr);
                var allowedStr = (function() {
                    var v = m.mld_allowed_links;
                    if (v == null) {
                        var bands = (m.radios || []).map(function(r) {
                            return r === 'radio0' ? '2.4G' : r === 'radio1' ? '5G' : r === 'radio2' ? '6G' : r;
                        });
                        return bands.length ? 'all  (' + bands.join(' + ') + ')' : '—';
                    }
                    var bands = [];
                    if (v & 1) bands.push('2.4G');
                    if (v & 2) bands.push('5G');
                    if (v & 4) bands.push('6G');
                    return '0x' + v.toString(16).toUpperCase() + (bands.length ? '  (' + bands.join(' + ') + ')' : '');
                })();
                var emlsrStr = (function() {
                    var t = m.ap_mld_type || '';
                    if (t.indexOf('EMLSR') >= 0) return 'active — ' + t;
                    if (m.eml_disable) return 'disabled';
                    return 'STR (simultaneous TX/RX)';
                })();
                var rows = [
                    ['MLD address',   m.mld_addr  || '—'],
                    ['Active links',  m.num_links != null ? String(m.num_links) : '—'],
                    ['Allowed links', allowedStr],
                    ['EMLSR',         emlsrStr],
                ];
                rows.forEach(function(f) {
                    wrap.appendChild(node('div', { style: 'display:flex;gap:8px;font-size:11px;margin-bottom:2px' },
                        sp(f[0], 'color:#555;min-width:100px;flex-shrink:0'), sp(f[1], 'color:#aaa;font-family:monospace')));
                });
                if (m.links && m.links.length) {
                    wrap.appendChild(sp('Per-link:', 'display:block;color:#444;font-size:11px;margin:6px 0 3px'));
                    m.links.forEach(function(lk) {
                        var band = lk.freq < 3000 ? '2.4G' : lk.freq < 5900 ? '5G' : '6G';
                        var lstr = 'link' + (lk.link_id != null ? lk.link_id : '?') +
                            '  ' + band +
                            (lk.freq   ? '  ' + lk.freq + ' MHz'   : '') +
                            (lk.channel ? '  CH' + lk.channel      : '') +
                            (lk.bw_mhz  ? '  ' + lk.bw_mhz + ' MHz BW' : '') +
                            (lk.bssid   ? '  ' + lk.bssid          : '') +
                            (lk.dfs_active ? '  [CAC]'             : '');
                        wrap.appendChild(node('div', { style: 'font-size:11px;color:#666;font-family:monospace;padding-left:8px;margin-bottom:1px' }, lstr));
                    });
                }
            });
            return wrap;
        }, false)));
    }

    // TX power info per band
    var BAND_NAMES = ['2.4 GHz', '5 GHz', '6 GHz'];
    (diag.txpower || []).forEach(function(raw, i) {
        if (!raw) return;
        el.appendChild(card(collapsible('diag_txp' + i, 'TX Power Info — ' + BAND_NAMES[i], function() {
            return node('pre', { style: 'color:#666;font-size:11px;margin:6px 0 0;overflow-x:auto;white-space:pre-wrap' }, raw);
        }, false)));
    });

    // Logs
    if (diag.logs) {
        el.appendChild(card(collapsible('diag_logs', 'System Logs', function() {
            var tail = diag.logs.split('\n').slice(-100).join('\n');
            var dlBtn = btnSecondary('Download .txt', function() {
                var blob = new Blob([diag.logs], { type: 'text/plain' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'wifimgr-syslog.txt';
                a.click();
            });
            dlBtn.style.cssText = 'margin-bottom:6px;font-size:11px;padding:2px 10px';
            var wrap = node('div', { style: 'margin-top:6px' });
            wrap.appendChild(dlBtn);
            wrap.appendChild(node('pre', { style: 'color:#555;font-size:11px;max-height:280px;overflow-y:auto;margin:6px 0 0;white-space:pre-wrap' }, tail));
            return wrap;
        }, false)));
    }

    return el;
}

// ── TAB MANAGEMENT ────────────────────────────────────────────────────────────

// tabDefs replaced by static TAB_DEFS constant defined in module state section

function renderTab(id, data) {
    switch (id) {
        case 'networks':    return renderNetworks(data);
        case 'radios':      return renderRadios(data);
        case 'clients':     return renderClients(data);
        case 'diagnostics': return renderDiagnostics(_diag);
    }
    return node('div', {});
}

function activateTab(id) {
    _tab = id;
    Object.keys(_tabNavBtns).forEach(function(k) {
        var active = k === id;
        _tabNavBtns[k].style.borderBottom = active ? '2px solid #5b9bd5' : '2px solid transparent';
        _tabNavBtns[k].style.color        = active ? '#ddd' : '#666';
    });
    Object.keys(_tabContainers).forEach(function(k) {
        _tabContainers[k].style.display = k === id ? 'block' : 'none';
    });
    if (id === 'diagnostics' && !_diag) loadDiag();
}

function refreshNav(data) {
    // All tabs are always visible with the static tab list
    if (!TAB_DEFS.some(function(t) { return t.id === _tab; })) activateTab('networks');
}

function refreshTab(id) {
    var container = _tabContainers[id];
    if (!container) return;
    var newEl = renderTab(id, _data);
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(newEl);
}

function refreshAll() {
    refreshNav(_data);
    Object.keys(_tabContainers).forEach(function(id) { refreshTab(id); });
}

function loadDiag() {
    layer3.load_diag().then(function(d) {
        _diag  = d;
        _diagTs = Date.now();
        refreshTab('diagnostics');
    });
}

// ── MAIN VIEW ─────────────────────────────────────────────────────────────────

return view.extend({
    load: function() {
        return layer3.load_all();
    },

    render: function(data) {
        _data          = data;
        _diag          = null;
        _diagTs        = 0;
        _tabContainers = {};
        _tabNavBtns    = {};
        _tab           = 'networks';

        _onApplied = function() {
            _lastFormTouch = 0;
            layer3.load_all().then(function(d) { _data = d; refreshAll(); });
        };

        document.addEventListener('change', function() { _lastFormTouch = Date.now(); }, true);
        document.addEventListener('input',  function() { _lastFormTouch = Date.now(); }, true);

        // ── Top bar ──
        var topBar = node('div', { style: 'padding:8px 0 12px' });
        topBar.appendChild(sp('WiFi Manager', 'color:#ddd;font-weight:bold;font-size:15px'));

        // ── Tab nav ──
        var tabNav = node('div', { style: 'display:flex;border-bottom:1px solid #1a2a3a;margin-bottom:16px;overflow-x:auto' });
        TAB_DEFS.forEach(function(t) {
            var tb = node('button', {
                style: 'background:none;border:none;border-bottom:2px solid transparent;color:#666;' +
                       'padding:8px 14px;cursor:pointer;font-size:13px;white-space:nowrap'
            }, t.label);
            tb.onclick = function() { activateTab(t.id); };
            _tabNavBtns[t.id] = tb;
            tabNav.appendChild(tb);
        });

        // ── Tab content ──
        var content = node('div', {});
        TAB_DEFS.forEach(function(t) {
            var container = node('div', { style: 'display:none' });
            container.appendChild(renderTab(t.id, data));
            _tabContainers[t.id] = container;
            content.appendChild(container);
        });

        activateTab('networks');

        // ── Page ──
        var page = node('div', { style: 'color:#ddd;font-family:sans-serif;max-width:960px' },
            topBar, tabNav, content);

        // ── Poll ──
        poll.add(function() {
            return layer3.load_all().then(function(d) {
                _data = d;
                var editing = (_tab === 'networks' &&
                    Object.keys(_netExpandState).some(function(k) { return _netExpandState[k].editMode; })) ||
                    (Date.now() - _lastFormTouch < 15000);
                if (!editing) refreshTab(_tab);
                if (_tab === 'diagnostics' && (_diagTs === 0 || Date.now() - _diagTs > 30000)) loadDiag();
            });
        }, 10);

        return page;
    },

    handleSave:        null,
    handleSaveApply:   null,
    handleReset:       null
});
