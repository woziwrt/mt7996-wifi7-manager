'use strict';
'require view';
'require wifimgr/layer3 as layer3';

// ── helpers ──────────────────────────────────────────────────────────────────

function logEl(out, text, status) {
    var color = status === 'ok'  ? '#1d9e75'
              : status === 'err' ? '#e24b4a'
              : status === 'hdr' ? '#5b9bd5'
              :                    '#888';
    out.appendChild(E('div', { style: 'padding:1px 0;color:' + color }, text));
}

function step(out, n, desc) {
    logEl(out, '', null);
    logEl(out, n + '. ' + desc, 'hdr');
}

function result(out, r) {
    if (r.ok) {
        logEl(out, '   ✓  ok  sid=' + (r.sid || r.sta_sid || '?'), 'ok');
    } else {
        logEl(out, '   ✗  FAILED  errors=' + JSON.stringify(r.errors || []), 'err');
    }
    return r;
}

// ── test sequence ─────────────────────────────────────────────────────────────

return view.extend({
    load: function() { return null; },

    render: function() {
        var out = E('div', {
            style: 'font-family:monospace;font-size:13px;line-height:1.6;padding:20px;' +
                   'background:#0d1520;color:#ddd;border-radius:4px;max-width:700px'
        });

        logEl(out, 'WiFi Wizard Test Runner', 'hdr');
        logEl(out, new Date().toISOString(), null);

        var ok_count = 0, fail_count = 0;

        Promise.resolve()

        // ── 1. TestMLO-3 — 3-link MLO (radio0+radio1+radio2) ─────────────────
        .then(function() {
            step(out, 1, 'wizard_mlo  TestMLO-3  (2.4G+5G+6G)  sae');
            return layer3.wizard_mlo(['radio0', 'radio1', 'radio2'], {
                ssid: 'TestMLO-3', encryption: 'sae', key: 'testtest'
            }).then(function(r) {
                result(out, r);
                r.ok ? ok_count++ : fail_count++;
            });
        })

        // ── 2. TestMLO-2 — 2-link MLO (radio1+radio2) ────────────────────────
        .then(function() {
            step(out, 2, 'wizard_mlo  TestMLO-2  (5G+6G)  sae');
            return layer3.wizard_mlo(['radio1', 'radio2'], {
                ssid: 'TestMLO-2', encryption: 'sae', key: 'testtest'
            }).then(function(r) {
                result(out, r);
                r.ok ? ok_count++ : fail_count++;
            });
        })

        // ── 3. TestLegacy-24 — legacy AP 2.4G WPA2 ───────────────────────────
        .then(function() {
            step(out, 3, 'wizard_ap   TestLegacy-24  radio0  psk2');
            return layer3.wizard_ap('radio0', {
                ssid: 'TestLegacy-24', encryption: 'psk2', key: 'testtest'
            }).then(function(r) {
                result(out, r);
                r.ok ? ok_count++ : fail_count++;
            });
        })

        // ── 4. TestLegacy-5 — legacy AP 5G WPA2 ──────────────────────────────
        .then(function() {
            step(out, 4, 'wizard_ap   TestLegacy-5   radio1  psk2');
            return layer3.wizard_ap('radio1', {
                ssid: 'TestLegacy-5', encryption: 'psk2', key: 'testtest'
            }).then(function(r) {
                result(out, r);
                r.ok ? ok_count++ : fail_count++;
            });
        })

        // ── 5. TestSTA — STA on radio1 connecting to TestMLO-3 ───────────────
        .then(function() {
            step(out, 5, 'wizard_sta  TestMLO-3 (STA)  radio1  sae');
            return layer3.wizard_sta('radio1', {
                ssid: 'TestMLO-3', encryption: 'sae', key: 'testtest'
            }).then(function(r) {
                result(out, r);
                r.ok ? ok_count++ : fail_count++;
            });
        })

        // ── summary + wifi reload ─────────────────────────────────────────────
        .then(function() {
            logEl(out, '', null);
            if (fail_count === 0) {
                logEl(out, '✓  All ' + ok_count + ' wizards passed — starting wifi reload...', 'ok');
                layer3.start_apply('wifi');
                logEl(out, '   wifi reload started.  Networks tab will show live state.', 'ok');
            } else {
                logEl(out, '✗  ' + fail_count + ' wizard(s) FAILED, ' + ok_count + ' passed.', 'err');
                logEl(out, '   wifi reload skipped.  Check errors above.', 'err');
            }
        })

        .catch(function(e) {
            logEl(out, '', null);
            logEl(out, 'UNCAUGHT ERROR: ' + String(e), 'err');
        });

        return E('div', { style: 'padding:16px' }, out);
    },

    handleSave:      null,
    handleSaveApply: null,
    handleReset:     null
});
