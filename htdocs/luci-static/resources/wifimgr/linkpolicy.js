// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 Petr Wozniak <petr.wozniak@gmail.com>

'use strict';
'require baseclass';
'require wifimgr/layer3 as layer3';

// Link Policy tab — MLO link steering daemon control + status.
// Renders standalone; receives (steerdData, mainData, onRefresh) from index.js.
// All daemon actions go through layer3; no direct shell calls here.

// ── DOM HELPERS (local, mirrors index.js conventions) ────────────────────────

function el(tag, attrs) {
    var e = E(tag, attrs || {});
    for (var i = 2; i < arguments.length; i++) {
        var c = arguments[i];
        if (c == null) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
}

function sp(text, style) {
    return el('span', { style: style || '' }, text);
}

// ── BAND HELPERS ─────────────────────────────────────────────────────────────

var LINK_BANDS = { 0: '2.4G', 1: '5G', 2: '6G' };

// Band definitions keyed by link_id (0/1/2) → display color/bg matching index.js
var BAND_STYLE = {
    0: { color: '#5b9bd5', bg: '#0d2137' },
    1: { color: '#4caf7d', bg: '#0d2a1a' },
    2: { color: '#f5a623', bg: '#2a1800' }
};

function bandBadge(link_id) {
    var s = BAND_STYLE[link_id] || { color: '#aaa', bg: '#1a1a2a' };
    return el('span', {
        style: 'display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;' +
               'font-weight:bold;background:' + s.bg + ';color:' + s.color
    }, LINK_BANDS[link_id] || ('L' + link_id));
}

// Convert bitmask of link IDs to display string, e.g. 0x7 → "2.4G+5G+6G"
function bitmaskToLinks(mask) {
    var parts = [];
    for (var i = 0; i < 3; i++) {
        if (mask & (1 << i)) parts.push(LINK_BANDS[i] || ('L' + i));
    }
    return parts.length ? parts.join('+') : '—';
}

// ── RENDER ───────────────────────────────────────────────────────────────────

function render(sd, data, onRefresh) {
    var wrap = el('div', { style: 'padding:4px 0' });

    // Header
    wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
        sp('Link Policy', 'color:#5b9bd5;font-weight:bold;font-size:13px'),
        sp(' — dynamic MLO link steering + Neg-TTLM', 'color:#444;font-size:12px')
    ));

    // ── Daemon control ────────────────────────────────────────────────────────
    wrap.appendChild(renderDaemonRow(sd, onRefresh));

    // ── Steering override ─────────────────────────────────────────────────────
    if (sd && sd.script_present) {
        wrap.appendChild(renderOverrideRow(sd, onRefresh));
    }

    // ── Noise floor table (only when data is available) ───────────────────────
    if (sd && sd.noise && Object.keys(sd.noise).length > 0) {
        wrap.appendChild(renderNoiseTable(sd.noise));
    }

    // ── MLO clients table ─────────────────────────────────────────────────────
    var mloClients = ((data && data.clients) || []).filter(function(c) { return c.is_mld; });
    wrap.appendChild(renderClientsTable(mloClients, sd ? (sd.neg_ttlm || {}) : {}));

    // ── Log ───────────────────────────────────────────────────────────────────
    wrap.appendChild(renderLog(sd));

    return wrap;
}

function renderDaemonRow(sd, onRefresh) {
    var d = el('div', {
        style: 'display:flex;align-items:center;gap:8px;padding:10px 12px;' +
               'background:#0d1b2a;border:1px solid #1a2a3a;border-radius:4px;margin-bottom:16px'
    });

    if (!sd) {
        d.appendChild(sp('Loading…', 'color:#555;font-size:13px'));
        return d;
    }

    if (!sd.script_present) {
        d.appendChild(el('span', {
            style: 'display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#444'
        }));
        d.appendChild(sp('mlo-steerd: ', 'color:#aaa;font-size:13px'));
        d.appendChild(sp('not installed on this device', 'color:#555;font-size:13px'));
        d.appendChild(sp(' — deploy /root/mlo-steerd.sh on the AP router', 'color:#333;font-size:11px;margin-left:4px'));
        return d;
    }

    var running = sd.running;

    // Status dot
    d.appendChild(el('span', {
        style: 'display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;' +
               'background:' + (running ? '#4caf50' : '#444')
    }));

    d.appendChild(sp('mlo-steerd: ', 'color:#aaa;font-size:13px'));
    d.appendChild(sp(
        running ? ('running — PID ' + sd.pid) : 'stopped',
        'font-size:13px;color:' + (running ? '#4caf50' : '#555')
    ));

    // Start / Stop button
    var btn = el('button', {
        style: 'margin-left:auto;border:1px solid #1a3a5a;background:none;' +
               'color:#5b9bd5;padding:3px 12px;border-radius:3px;cursor:pointer;font-size:12px'
    }, running ? 'Stop' : 'Start');
    btn.onclick = function() {
        btn.disabled = true;
        btn.textContent = running ? 'Stopping…' : 'Starting…';
        (running ? layer3.steerd_stop() : layer3.steerd_start()).then(function() {
            if (onRefresh) onRefresh();
        });
    };
    d.appendChild(btn);

    return d;
}

// ── STEERING OVERRIDE ─────────────────────────────────────────────────────────

function renderOverrideRow(sd, onRefresh) {
    var mode = (sd && sd.mode) || 'auto';

    var wrap = el('div', {
        style: 'display:flex;align-items:center;gap:8px;padding:10px 12px;' +
               'background:#0d1b2a;border:1px solid #1a2a3a;border-radius:4px;margin-bottom:16px'
    });

    wrap.appendChild(sp('Steering mode:', 'color:#aaa;font-size:13px;flex-shrink:0'));

    var MODES = [
        { key: 'auto',    label: 'Auto',         desc: 'SNR-weighted algorithm' },
        { key: 'all_on',  label: 'All links ON',  desc: 'All bands always active' },
        { key: '5g_only', label: '5G only',       desc: 'Force 5 GHz link' }
    ];

    var btnWrap = el('div', { style: 'display:flex;gap:6px' });

    MODES.forEach(function(m) {
        var active = mode === m.key;
        var btn = el('button', {
            title: m.desc,
            style: 'border:1px solid ' + (active ? '#5b9bd5' : '#1a3a5a') + ';' +
                   'background:' + (active ? '#0d2137' : 'none') + ';' +
                   'color:' + (active ? '#5b9bd5' : '#555') + ';' +
                   'padding:3px 12px;border-radius:3px;cursor:pointer;font-size:12px'
        }, m.label);

        if (!active) {
            btn.onclick = function() {
                btn.disabled = true;
                layer3.steerd_set_mode(m.key).then(function() {
                    if (onRefresh) onRefresh();
                });
            };
        }

        btnWrap.appendChild(btn);
    });

    wrap.appendChild(btnWrap);
    return wrap;
}

// ── NOISE FLOOR TABLE ─────────────────────────────────────────────────────────

function renderNoiseTable(noise) {
    var wrap = el('div', { style: 'margin-bottom:16px' });
    wrap.appendChild(sp('Link Status',
        'color:#aaa;font-size:12px;font-weight:bold;display:block;margin-bottom:6px'));

    // Band frequency ranges: link_id → { min, max } MHz
    var BAND_FREQS = [
        { id: 0, min: 2400, max: 2500 },
        { id: 1, min: 5000, max: 6000 },
        { id: 2, min: 6000, max: 7300 }
    ];

    var tbl = el('table', { style: 'border-collapse:collapse;font-size:12px' });
    tbl.appendChild(el('tr', { style: 'border-bottom:1px solid #1a2a3a' },
        el('td', { style: 'color:#555;padding:3px 14px 3px 0;font-size:11px' }, 'Band'),
        el('td', { style: 'color:#555;padding:3px 14px;font-size:11px' }, 'Freq'),
        el('td', { style: 'color:#555;padding:3px 8px;font-size:11px' }, 'Noise floor')
    ));

    var anyRow = false;
    BAND_FREQS.forEach(function(band) {
        var freqs = Object.keys(noise).map(Number).filter(function(f) {
            return f >= band.min && f < band.max;
        });
        if (!freqs.length) return;
        anyRow = true;
        var freq = freqs[0];
        var noiseVal = noise[freq];
        tbl.appendChild(el('tr', {},
            el('td', { style: 'padding:4px 14px 4px 0' }, bandBadge(band.id)),
            el('td', { style: 'padding:4px 14px;color:#555;font-family:monospace;font-size:11px' },
                freq + ' MHz'),
            el('td', { style: 'padding:4px 8px;color:#555;font-size:12px' },
                noiseVal + ' dBm')
        ));
    });

    if (!anyRow) return el('div', {});

    wrap.appendChild(tbl);
    return wrap;
}

// ── MLO CLIENTS TABLE ─────────────────────────────────────────────────────────

function renderClientsTable(clients, neg_ttlm) {
    var wrap = el('div', { style: 'margin-bottom:16px' });

    wrap.appendChild(sp('MLO Clients',
        'color:#aaa;font-size:12px;font-weight:bold;display:block;margin-bottom:6px'));

    if (!clients.length) {
        wrap.appendChild(sp('No MLO clients connected.', 'color:#444;font-size:12px'));
        return wrap;
    }

    var tbl = el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });

    // Header
    tbl.appendChild(el('tr', { style: 'border-bottom:1px solid #1a2a3a' },
        el('td', { style: 'color:#555;padding:3px 8px;font-size:11px' }, 'MAC'),
        el('td', { style: 'color:#555;padding:3px 8px;font-size:11px' }, 'Type'),
        el('td', { style: 'color:#555;padding:3px 8px;font-size:11px' }, 'Sim. links'),
        el('td', { style: 'color:#555;padding:3px 8px;font-size:11px' }, 'Active / Total links'),
        el('td', { style: 'color:#555;padding:3px 8px;font-size:11px' }, 'Signal')
    ));

    clients.forEach(function(c) {
        var msl = c.max_simul_links;
        var isMLMR = msl != null && msl > 1;
        var type  = msl == null ? '?' : (isMLMR ? 'MLMR' : 'EMLSR');
        var typeColor = isMLMR ? '#4caf50' : '#888';
        var activeLinks = (c.links || []).filter(function(l) {
            return l.signal != null && l.signal !== 0;
        }).length;
        var totalLinks = (c.links || []).length;
        var sig = (c.signal != null && c.signal !== 0) ? (String(c.signal) + ' dBm') : '—';

        tbl.appendChild(el('tr', { style: 'border-bottom:1px solid #0a1520' },
            el('td', { style: 'padding:5px 8px;color:#ccc;font-family:monospace;font-size:11px' }, c.mac),
            el('td', { style: 'padding:5px 8px;font-weight:bold;color:' + typeColor }, type),
            el('td', { style: 'padding:5px 8px;color:#aaa' }, msl != null ? String(msl) : '—'),
            el('td', { style: 'padding:5px 8px;color:#aaa' }, activeLinks + ' / ' + totalLinks),
            el('td', { style: 'padding:5px 8px;color:#aaa' }, sig)
        ));

        // Per-link detail row
        if (totalLinks > 0) {
            tbl.appendChild(el('tr', { style: 'border-bottom:1px solid #0a1520' },
                el('td', { colspan: '5', style: 'padding:2px 8px 4px 24px' },
                    renderLinkDetail(c.links)
                )
            ));
        }

        // Neg-TTLM row for MLMR clients
        var ttlm = isMLMR && neg_ttlm ? neg_ttlm[c.mac] : null;
        if (ttlm) {
            var ttlmEl = renderNegTtlm(ttlm);
            if (ttlmEl) {
                tbl.appendChild(el('tr', { style: 'border-bottom:1px solid #0a1520' },
                    el('td', { colspan: '5', style: 'padding:2px 8px 8px 24px' }, ttlmEl)
                ));
            }
        }
    });

    wrap.appendChild(tbl);
    return wrap;
}

function renderLinkDetail(links) {
    var wrap = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' });
    links.forEach(function(l) {
        var active = l.signal && l.signal !== 0;
        var sig = active ? (String(l.signal) + ' dBm') : 'idle';
        var s = BAND_STYLE[l.link_id] || { color: '#555', bg: '#111' };
        var row = el('span', { style: 'display:inline-flex;align-items:center;gap:5px' });
        row.appendChild(bandBadge(l.link_id));
        row.appendChild(sp(sig, 'font-size:11px;color:' + (active ? s.color : '#333')));
        wrap.appendChild(row);
    });
    return wrap;
}

// ── NEG-TTLM TID TABLE ────────────────────────────────────────────────────────

function renderNegTtlm(ttlm) {
    if (!ttlm || !ttlm.active || !ttlm.tids || !ttlm.tids.length) {
        // Show "inactive" hint when we got a response but no mapping active
        if (ttlm && ttlm.active === false) {
            return sp('Neg-TTLM inactive', 'font-size:11px;color:#333;font-style:italic');
        }
        return null;
    }

    // Group TIDs by Access Category
    var AC_GROUPS = [
        { label: 'Background', short: 'BK', tids: [1, 2] },
        { label: 'Best Effort', short: 'BE', tids: [0, 3] },
        { label: 'Video',       short: 'VI', tids: [4, 5] },
        { label: 'Voice',       short: 'VO', tids: [6, 7] }
    ];

    var tidMap = {};
    ttlm.tids.forEach(function(t) { tidMap[t.tid] = t; });

    var wrap = el('div', { style: 'margin-top:2px' });
    wrap.appendChild(sp('Neg-TTLM',
        'color:#5b9bd5;font-size:11px;font-weight:bold;display:block;margin-bottom:4px'));

    var tbl = el('table', { style: 'border-collapse:collapse;font-size:11px' });
    tbl.appendChild(el('tr', {},
        el('td', { style: 'color:#333;padding:1px 14px 1px 0;font-size:10px' }, 'AC'),
        el('td', { style: 'color:#333;padding:1px 14px;font-size:10px' }, 'Uplink'),
        el('td', { style: 'color:#333;padding:1px 8px;font-size:10px' }, 'Downlink')
    ));

    AC_GROUPS.forEach(function(ac) {
        var t = tidMap[ac.tids[0]];
        if (!t) return;
        var ul = bitmaskToLinks(t.uplink);
        var dl = bitmaskToLinks(t.downlink);
        // Check if all TIDs in this group agree (use first as representative)
        tbl.appendChild(el('tr', {},
            el('td', { style: 'padding:2px 14px 2px 0' },
                el('span', {
                    style: 'display:inline-block;padding:1px 5px;border-radius:2px;font-size:10px;' +
                           'background:#111;color:#888;font-family:monospace'
                }, ac.short)
            ),
            el('td', { style: 'padding:2px 14px;color:#7a9db5;font-family:monospace' }, ul),
            el('td', { style: 'padding:2px 8px;color:#7a9db5;font-family:monospace' }, dl)
        ));
    });

    wrap.appendChild(tbl);
    return wrap;
}

// ── LOG ───────────────────────────────────────────────────────────────────────

function renderLog(sd) {
    var wrap = el('div', {});
    wrap.appendChild(sp('Daemon log',
        'color:#aaa;font-size:12px;font-weight:bold;display:block;margin-bottom:6px'));

    if (!sd) {
        wrap.appendChild(sp('Loading…', 'color:#444;font-size:12px'));
        return wrap;
    }

    if (!sd.log || !sd.log.length) {
        wrap.appendChild(sp(
            'No log — start the daemon or check /tmp/steerd.log on the router.',
            'color:#444;font-size:12px'
        ));
        return wrap;
    }

    var box = el('div', {
        style: 'background:#060e18;border:1px solid #1a2a3a;border-radius:3px;' +
               'padding:8px 10px;font-family:monospace;font-size:11px;color:#7a9db5;' +
               'max-height:320px;overflow-y:auto;line-height:1.5'
    });
    sd.log.forEach(function(line) { box.appendChild(el('div', {}, line)); });

    // Auto-scroll to bottom
    setTimeout(function() { box.scrollTop = box.scrollHeight; }, 0);

    wrap.appendChild(box);
    return wrap;
}

// ── MODULE EXPORT ─────────────────────────────────────────────────────────────

return baseclass.extend({ render: render });
