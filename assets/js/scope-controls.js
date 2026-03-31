/**
 * scope-controls.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Wires every UI control in scope.html to EEEngine and EESerial.
 *
 * Responsibilities:
 *   - Connects/disconnects the serial port
 *   - Syncs all sliders, buttons, and toggles to engine state
 *   - Updates the measurement display (freq, Vpp, etc.)
 *   - Updates the stats strip (bytes/s, health, etc.)
 *   - Manages canvas overlay text (trigger state, timebase label)
 *   - Manages the cursor readout panel
 *   - Opens/closes the Sketch and Diagnostics modals
 *   - Runs the serial echo test
 *   - Handles PNG and CSV export
 *
 * Exposes window.EEControls so scope-engine.js can call back
 * into the DOM without creating a circular dependency.
 *
 * Depends on: scope-serial.js, scope-engine.js, scope-render.js
 * Load order: last of the scope JS files.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Shorthand ───────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  /* ── Format helpers ──────────────────────────────────────── */
  function fmtTime(ms) {
    var a = Math.abs(ms);
    if (a === 0)    return '0';
    if (a < 0.001)  return (ms * 1e6).toFixed(1)  + '\u03bcs';
    if (a < 1)      return (ms * 1000).toFixed(1)  + '\u03bcs';
    if (a < 1000)   return ms.toFixed(a < 10 ? 2 : 1) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function fmtFreq(hz) {
    if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
    return hz.toFixed(2) + ' Hz';
  }

  /* ── Logging ─────────────────────────────────────────────── */
  function log(msg, cls) {
    var logEl = $('scope-log');
    if (!logEl) return;

    var line = document.createElement('div');
    line.className  = 'log__line' + (cls ? ' log__line--' + cls : '');
    line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
    logEl.prepend(line);

    if (logEl.children.length > 80) {
      logEl.removeChild(logEl.lastElementChild);
    }
  }

  /* ── Active button helper ────────────────────────────────── */
  function setActive(activeId, groupIds) {
    for (var i = 0; i < groupIds.length; i++) {
      var el = $(groupIds[i]);
      if (el) el.classList.remove('is-active');
    }
    var active = $(activeId);
    if (active) active.classList.add('is-active');
  }

  /* ── Serial status handler ───────────────────────────────── */
  function handleStatus(event, detail) {
    switch (event) {

      case 'no-serial':
        var warn = $('no-serial-warn');
        if (warn) warn.style.display = 'block';
        log('Web Serial not supported — use Chrome or Edge.', 'err');
        break;

      case 'connected':
        var overlay = $('connect-overlay');
        if (overlay) overlay.classList.add('is-hidden');
        setBadge('conn-badge', 'CONNECTED', 'badge--live');
        log('Port open @ ' + detail + ' baud', 'ok');
        break;

      case 'streaming':
        log('Streaming started', 'ok');
        break;

      case 'disconnected':
        var ov = $('connect-overlay');
        if (ov) ov.classList.remove('is-hidden');
        setBadge('conn-badge', 'DISCONNECTED', '');
        log('Disconnected', 'warn');
        syncRunState();
        break;

      case 'connect-error':
        log('Connect failed: ' + detail, 'err');
        break;

      case 'read-error':
        log('Read error: ' + detail, 'err');
        break;
    }
  }

  /* ── Badge helper ────────────────────────────────────────── */
  function setBadge(id, text, extraClass) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'badge' + (extraClass ? ' ' + extraClass : '');
  }

  /* ── Connect / Disconnect ────────────────────────────────── */
  function connect() {
    var baudEl = $('baud-select');
    var baud   = baudEl ? parseInt(baudEl.value) : 115200;
    window.EESerial.connect(baud);
  }

  function disconnect() {
    window.EESerial.disconnect();
  }

  /* ── Run state badge sync ────────────────────────────────── */
  function syncRunState() {
    var s = window.EEEngine.state;

    if (!window.EESerial.isConnected()) {
      setBadge('state-badge', 'IDLE', '');
    } else if (s.singleShot) {
      setBadge('state-badge', 'SINGLE', 'badge--amber');
    } else if (!s.running) {
      setBadge('state-badge', 'PAUSED', 'badge--amber');
    } else {
      setBadge('state-badge', 'LIVE', 'badge--live');
    }
  }

  /* ── Acquisition mode ────────────────────────────────────── */
  function setAcqMode(mode) {
    var s = window.EEEngine.state;
    s.acqMode = mode;
    window.EEEngine.resetAcq();

    setBadge('acq-badge', mode.toUpperCase(), '');
    setActive(
      'btn-acq-' + mode,
      ['btn-acq-normal', 'btn-acq-avg', 'btn-acq-peak']
    );

    var rowAvg = $('row-avg');
    if (rowAvg) rowAvg.style.display = (mode === 'average') ? 'flex' : 'none';

    log('Acquisition \u2192 ' + mode);
  }

  /* ── Measurement display ─────────────────────────────────── */
  function updateMeasurements(chIdx, m) {
    var p   = chIdx === 0 ? 'm1' : 'm2';

    function set(suffix, value) {
      var el = $(p + '-' + suffix);
      if (el) el.textContent = value;
    }

    set('freq',   m.freq ? fmtFreq(m.freq) : '\u2014');
    set('period', m.freq ? fmtTime(1000 / m.freq) : '\u2014');
    set('vpp',    m.vpp.toFixed(3)  + 'V');
    set('vmax',   m.vmax.toFixed(3) + 'V');
    set('vmin',   m.vmin.toFixed(3) + 'V');
    set('dc',     m.vdc.toFixed(3)  + 'V');
    set('vrms',   m.vrms.toFixed(3) + 'V');
    set('duty',   m.duty);
  }

  function setAvgProgress(n, target) {
    var el = $('m1-freq');
    if (el) el.textContent = n + '/' + target;
  }

  /* ── Canvas overlay text ─────────────────────────────────── */
  function updateOverlays(trigState, timebaseMs) {
    /* Trigger state indicator */
    var trigEl    = $('trig-state-label');
    var connected = window.EESerial && window.EESerial.isConnected();

    if (trigEl) {
      if (!connected) {
        trigEl.textContent = '';
        trigEl.className   = 'canvas-trig-state';
      } else if (trigState === 'armed') {
        trigEl.textContent = 'ARMED';
        trigEl.className   = 'canvas-trig-state is-armed';
      } else {
        trigEl.textContent = "TRIG'D";
        trigEl.className   = 'canvas-trig-state is-triggered';
      }
    }

    /* Timebase label */
    var tbEl = $('timebase-label');
    if (tbEl) tbEl.textContent = fmtTime(timebaseMs) + '/div';
  }

  /* ── Cursor panel readout ────────────────────────────────── */
  function updateCursorPanel(vals) {
    function set(id, v) { var el = $(id); if (el) el.textContent = v; }

    set('cp-t1', fmtTime(vals.t1 * 1000));
    set('cp-t2', fmtTime(vals.t2 * 1000));
    set('cp-dt', fmtTime(vals.dt * 1000));
    set('cp-f',  vals.dt > 0 ? fmtFreq(1 / vals.dt) : '\u2014');
    set('cp-v1', vals.v1.toFixed(3) + ' V');
    set('cp-v2', vals.v2.toFixed(3) + ' V');
    set('cp-dv', Math.abs(vals.v1 - vals.v2).toFixed(3) + ' V');
  }

  /* ── Stats strip (runs every second) ────────────────────── */
  function updateStats() {
    var connected = window.EESerial.isConnected();
    var ids       = ['st-bps', 'st-fps', 'st-err', 'st-sr', 'st-ch2', 'st-health'];

    if (!connected) {
      for (var i = 0; i < ids.length; i++) {
        var el = $(ids[i]);
        if (el) { el.textContent = '\u2014'; el.className = 'stat-cell__value'; }
      }
      return;
    }

    var diag    = window.EESerial.getDiag();
    var elapsed = Math.max(1, (Date.now() - diag.connectTime) / 1000);
    var bps     = diag.bytesWindow;
    var fps     = diag.framesWindow;

    /* Reset per-second windows */
    diag.bytesWindow  = 0;
    diag.framesWindow = 0;

    var sr     = diag.framesTotal / elapsed;
    var since  = Date.now() - diag.lastByteTime;
    var health = diag.bytesTotal > 0
      ? Math.min(100, Math.round(diag.framesTotal / (diag.bytesTotal / 4) * 100))
      : 0;

    /* Feed estimated sample rate back to engine */
    if (diag.framesTotal > 200) {
      window.EEEngine.state.sampleRate = Math.round(sr);
    }

    function setStat(id, value, cls) {
      var el = $(id);
      if (!el) return;
      el.textContent = value;
      el.className   = 'stat-cell__value stat-cell__value--' + cls;
    }

    setStat('st-bps',
      bps > 1000 ? (bps / 1000).toFixed(1) + 'k' : bps,
      bps > 0 ? 'ok' : 'err'
    );
    setStat('st-fps',    fps,                                    fps > 0 ? 'ok' : 'warn');
    setStat('st-err',    diag.syncErrors,                        diag.syncErrors === 0 ? 'ok' : diag.syncErrors < 50 ? 'warn' : 'err');
    setStat('st-sr',     sr > 1000 ? (sr / 1000).toFixed(1) + 'k' : Math.round(sr),  sr > 100 ? 'ok' : 'warn');
    setStat('st-ch2',    diag.frames2,                           window.EEEngine.state.ch[1].enabled && diag.frames2 > 0 ? 'ok' : '');
    setStat('st-health', health + '%',                           health >= 80 ? 'ok' : health >= 40 ? 'warn' : 'err');

    /* Watchdog warnings */
    if (connected && diag.lastByteTime > 0 && since > 3000) {
      log('\u26A0 No data for ' + Math.round(since / 1000) + 's \u2014 check baud/sketch', 'warn');
      diag.lastByteTime = Date.now();
    }
  }

  /* ── Export PNG ──────────────────────────────────────────── */
  function exportPNG() {
    var scopeCanvas = $('scope-canvas');
    var fftCanvas   = $('fft-canvas');
    var fftVisible  = fftCanvas && fftCanvas.style.display !== 'none';

    var out  = document.createElement('canvas');
    out.width  = scopeCanvas.width;
    out.height = fftVisible
      ? scopeCanvas.height + fftCanvas.height
      : scopeCanvas.height;

    var oc = out.getContext('2d');
    oc.fillStyle = '#07080F';
    oc.fillRect(0, 0, out.width, out.height);
    oc.drawImage(scopeCanvas, 0, 0);
    if (fftVisible) oc.drawImage(fftCanvas, 0, scopeCanvas.height);

    var a = document.createElement('a');
    a.download = 'eelab77_scope_' + Date.now() + '.png';
    a.href     = out.toDataURL('image/png');
    a.click();

    log('Exported PNG', 'ok');
  }

  /* ── Export CSV ──────────────────────────────────────────── */
  function exportCSV() {
    var data = window.EEEngine.getDisplayData();
    if (!data.frozenRaw1) { log('No data to export', 'warn'); return; }

    var n    = data.frozenRaw1.length;
    var eng  = window.EEEngine;
    var dtS  = (eng.TIMEBASE_MS[eng.state.timebaseIdx] / 1000 * eng.GRID_X) / n;
    var VREF = eng.VREF;
    var MAX  = eng.ADC_MAX;

    var lines = ['time_s,ch1_raw,ch1_v'];
    if (data.frozen2) lines[0] += ',ch2_raw,ch2_v';

    for (var i = 0; i < n; i++) {
      var row = (i * dtS).toFixed(6)
        + ',' + data.frozenRaw1[i]
        + ',' + (data.frozenRaw1[i] / MAX * VREF).toFixed(4);

      if (data.frozen2 && i < data.frozen2.length) {
        var raw2 = Math.round(data.frozen2[i]);
        row += ',' + raw2 + ',' + (raw2 / MAX * VREF).toFixed(4);
      }

      lines.push(row);
    }

    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a    = document.createElement('a');
    a.download = 'eelab77_scope_' + Date.now() + '.csv';
    a.href     = URL.createObjectURL(blob);
    a.click();

    log('Exported CSV (' + n + ' samples)', 'ok');
  }

  /* ── Diagnostics: build check list ──────────────────────── */
  function addCheck(container, icon, cls, text, sub) {
    var row = document.createElement('div');
    row.className = 'diag-check';
    row.innerHTML =
      '<div class="diag-check__icon diag-check__icon--' + cls + '">' + icon + '</div>' +
      '<div>' +
        '<div class="diag-check__text">' + text + '</div>' +
        (sub ? '<div class="diag-check__sub">' + sub + '</div>' : '') +
      '</div>';
    container.appendChild(row);
  }

  function runAllChecks() {
    var c = $('diag-checks');
    if (!c) return;
    c.innerHTML = '';

    var connected = window.EESerial.isConnected();
    var diag      = window.EESerial.getDiag();
    var baud      = $('baud-select') ? $('baud-select').value : '?';

    /* Web Serial support */
    addCheck(c,
      navigator.serial ? '\u2713' : '\u2717',
      navigator.serial ? 'pass'   : 'fail',
      navigator.serial ? 'Web Serial API supported' : 'Web Serial NOT supported',
      navigator.serial ? 'Chrome or Edge detected.' : 'Switch to Chrome or Edge.'
    );

    /* Connection */
    if (connected) {
      addCheck(c, '\u2713', 'pass', 'Port open @ ' + baud + ' baud');
    } else {
      addCheck(c, '\u2717', 'fail', 'Not connected', 'Click Connect and select your Arduino COM port.');
    }

    if (connected) {
      /* Data flow */
      var since = Date.now() - diag.lastByteTime;
      if (diag.bytesTotal === 0) {
        addCheck(c, '\u2717', 'fail',
          'No bytes received',
          'Wrong baud rate, or sketch is not running.'
        );
      } else if (since > 3000) {
        addCheck(c, '\u26A0', 'warn',
          'Data stopped ' + Math.round(since / 1000) + 's ago',
          'Arduino may have reset. Try disconnecting and reconnecting.'
        );
      } else {
        addCheck(c, '\u2713', 'pass',
          diag.bytesTotal.toLocaleString() + ' bytes received',
          'Data is actively flowing from the Arduino.'
        );
      }

      /* Frame health */
      var health = diag.bytesTotal > 0
        ? Math.min(100, Math.round(diag.framesTotal / (diag.bytesTotal / 4) * 100))
        : 0;

      addCheck(c,
        health >= 80 ? '\u2713' : health >= 40 ? '\u26A0' : '\u2717',
        health >= 80 ? 'pass'   : health >= 40 ? 'warn'   : 'fail',
        'Frame health ' + health + '%',
        health >= 80
          ? 'Protocol sync is good.'
          : health >= 40
            ? 'Partial sync \u2014 try a lower baud rate.'
            : 'Baud rate mismatch \u2014 change to match the sketch.'
      );

      /* Sync errors */
      addCheck(c,
        diag.syncErrors === 0 ? '\u2713' : diag.syncErrors < 20 ? '\u26A0' : '\u2717',
        diag.syncErrors === 0 ? 'pass'   : diag.syncErrors < 20 ? 'warn'   : 'fail',
        diag.syncErrors + ' sync errors',
        diag.syncErrors === 0
          ? 'Frame boundaries are clean.'
          : 'Try a lower baud rate or disconnect and reconnect.'
      );

      /* CH2 frames */
      if (window.EEEngine.state.ch[1].enabled) {
        addCheck(c,
          diag.frames2 > 10 ? '\u2713' : '\u26A0',
          diag.frames2 > 10 ? 'pass'   : 'warn',
          'CH2 frames: ' + diag.frames2,
          diag.frames2 > 10
            ? 'CH2 data is flowing.'
            : 'No CH2 data. Check ch2Enable = true in your sketch.'
        );
      }

      /* Estimated sample rate */
      if (diag.framesTotal > 100) {
        var elapsed = Math.max(1, (Date.now() - diag.connectTime) / 1000);
        var sr      = Math.round(diag.framesTotal / elapsed);
        addCheck(c,
          sr > 500 ? '\u2713' : '\u26A0',
          sr > 500 ? 'pass'   : 'warn',
          'Estimated sample rate: ' + sr.toLocaleString() + ' Hz',
          'PS_128 \u2248 9600 Hz. PS_64 \u2248 19000 Hz. PS_32 \u2248 38000 Hz.'
        );
      }
    }
  }

  /* ── Serial echo test ────────────────────────────────────── */
  var testLines = [];

  function runSerialTest() {
    var outEl = $('serial-test-out');
    if (!outEl) return;

    if (!window.EESerial.isConnected()) {
      outEl.textContent = '\u2717 Not connected. Connect your Arduino first.';
      outEl.className   = 'serial-test-out';
      return;
    }

    outEl.className   = 'serial-test-out';
    outEl.textContent = 'Sending T command to Arduino...\n';
    testLines         = [];

    /* Receive raw text from serial module during test */
    window.EESerial.onRawText = function (text) {
      var lines = text.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (t) testLines.push(t);
      }
      outEl.textContent = testLines.join('\n');
    };

    var dots = 0;
    var iv = setInterval(function () {
      dots++;
      if (testLines.length === 0) {
        outEl.textContent = 'Waiting' + '.'.repeat(dots % 4);
      }
    }, 300);

    var ok = window.EESerial.runSerialTest();

    if (!ok) {
      clearInterval(iv);
      outEl.textContent = '\u2717 Not connected.';
      return;
    }

    /* After 3.2 s clean up and show final result */
    setTimeout(function () {
      clearInterval(iv);
      window.EESerial.onRawText = null;

      if (testLines.length > 0) {
        outEl.textContent = testLines.join('\n');
      } else {
        outEl.textContent = '(no response \u2014 verify baud rate matches sketch)';
      }

      testLines = [];
      log('Serial test complete \u2014 streaming resumed', 'ok');
      runAllChecks();
    }, 3200);
  }

  /* ── Channel tab switching ───────────────────────────────── */
  function selectChTab(n) {
    var ch1Panel = $('ch1-panel');
    var ch2Panel = $('ch2-panel');
    var tab1     = $('tab-ch1');
    var tab2     = $('tab-ch2');

    if (ch1Panel) ch1Panel.style.display = n === 1 ? 'block' : 'none';
    if (ch2Panel) ch2Panel.style.display = n === 2 ? 'block' : 'none';
    if (tab1) tab1.className = 'ch-tab' + (n === 1 ? ' is-active--ch1' : '');
    if (tab2) tab2.className = 'ch-tab' + (n === 2 ? ' is-active--ch2' : '');
  }

  /* ── Wire baud selectors (keep overlay + sidebar in sync) ── */
  function wireBaudSelectors() {
    var ids = ['baud-select', 'overlay-baud-select'];

    for (var i = 0; i < ids.length; i++) {
      (function (id) {
        var el = $(id);
        if (!el) return;

        el.addEventListener('change', function (e) {
          var val = e.target.value;
          ids.forEach(function (oid) {
            var o = $(oid);
            if (o) o.value = val;
          });
          log('Baud \u2192 ' + val);
        });
      }(ids[i]));
    }
  }

  /* ── Wire a toggle button ────────────────────────────────── */
  function wireToggle(id, stateObj, prop, onCls) {
    var el = $(id);
    if (!el) return;

    el.addEventListener('click', function () {
      stateObj[prop] = !stateObj[prop];
      if (onCls) {
        el.classList.toggle(onCls, stateObj[prop]);
      } else {
        el.classList.toggle('is-active', stateObj[prop]);
      }
    });
  }

  /* ── Wire all controls ───────────────────────────────────── */
  function init() {
    var s = window.EEEngine.state;

    /* Register serial status handler */
    window.EESerial.onStatus = handleStatus;

    /* Baud selectors */
    wireBaudSelectors();

    /* Connect / Disconnect */
    var btnCo  = $('btn-connect-overlay');
    var btnC   = $('btn-connect');
    var btnD   = $('btn-disconnect');
    if (btnCo) btnCo.addEventListener('click', connect);
    if (btnC)  btnC.addEventListener('click',  connect);
    if (btnD)  btnD.addEventListener('click',  disconnect);

    /* ── Run / Pause / Single ── */
    var runGroup = ['btn-run', 'btn-pause', 'btn-single'];

    var btnRun = $('btn-run');
    if (btnRun) {
      btnRun.addEventListener('click', function () {
        s.running    = true;
        s.singleShot = false;
        setActive('btn-run', runGroup);
        syncRunState();
      });
    }

    var btnPause = $('btn-pause');
    if (btnPause) {
      btnPause.addEventListener('click', function () {
        s.running    = false;
        s.singleShot = false;
        setActive('btn-pause', runGroup);
        syncRunState();
      });
    }

    var btnSingle = $('btn-single');
    if (btnSingle) {
      btnSingle.addEventListener('click', function () {
        s.running    = true;
        s.singleShot = true;
        setActive('btn-single', runGroup);
        syncRunState();
      });
    }

    /* ── Acquisition modes ── */
    var acqGroup = ['btn-acq-normal', 'btn-acq-avg', 'btn-acq-peak'];
    ['normal', 'avg', 'peak'].forEach(function (mode) {
      var btn = $('btn-acq-' + mode);
      if (btn) {
        btn.addEventListener('click', function () {
          setAcqMode(mode === 'avg' ? 'average' : mode);
          setActive('btn-acq-' + mode, acqGroup);
        });
      }
    });

    /* Average count slider */
    var slAvg = $('sl-avg');
    if (slAvg) {
      slAvg.addEventListener('input', function () {
        s.avgTarget = window.EEEngine.AVG_COUNTS[+slAvg.value];
        var lbl = $('lbl-avg');
        if (lbl) lbl.textContent = s.avgTarget;
        window.EEEngine.resetAcq();
      });
    }

    /* Rolling mode */
    var btnRolling = $('btn-rolling');
    if (btnRolling) {
      btnRolling.addEventListener('click', function () {
        s.rollingMode = !s.rollingMode;
        btnRolling.classList.toggle('is-active', s.rollingMode);
      });
    }

    /* ── Timebase slider ── */
    var slTb = $('sl-tb');
    if (slTb) {
      slTb.addEventListener('input', function () {
        s.timebaseIdx = +slTb.value;
        var lbl = $('lbl-tb');
        if (lbl) lbl.textContent = fmtTime(window.EEEngine.TIMEBASE_MS[s.timebaseIdx]);
      });
    }

    /* ── CH1 controls ── */
    wireToggle('btn-ch1-ac',  s.ch[0], 'acCouple');
    wireToggle('btn-ch1-inv', s.ch[0], 'invert');

    var slCh1Vdiv = $('sl-ch1-vdiv');
    if (slCh1Vdiv) {
      slCh1Vdiv.addEventListener('input', function () {
        s.ch[0].vdivIdx = +slCh1Vdiv.value;
        var v   = window.EEEngine.VDIV_V[s.ch[0].vdivIdx];
        var lbl = $('lbl-ch1-vdiv');
        if (lbl) lbl.textContent = (v < 1 ? v.toFixed(1) : v.toFixed(0)) + 'V';
      });
    }

    var slCh1Off = $('sl-ch1-off');
    if (slCh1Off) {
      slCh1Off.addEventListener('input', function () {
        s.ch[0].offsetPct = +slCh1Off.value;
        var lbl = $('lbl-ch1-off');
        if (lbl) lbl.textContent = slCh1Off.value + '%';
      });
    }

    /* ── CH2 controls ── */
    var btnCh2En = $('btn-ch2-en');
    if (btnCh2En) {
      btnCh2En.addEventListener('click', function () {
        s.ch[1].enabled = !s.ch[1].enabled;
        btnCh2En.textContent = s.ch[1].enabled ? 'CH2 Enabled' : 'Enable CH2';
        btnCh2En.classList.toggle('is-active--amber', s.ch[1].enabled);

        var badge = $('ch2-badge');
        if (badge) badge.style.opacity = s.ch[1].enabled ? '1' : '0.35';

        var row = $('ch2-meas-row');
        if (row) row.style.display = s.ch[1].enabled ? 'flex' : 'none';

        log('CH2 ' + (s.ch[1].enabled ? 'enabled' : 'disabled'));
      });
    }

    wireToggle('btn-ch2-ac',  s.ch[1], 'acCouple');
    wireToggle('btn-ch2-inv', s.ch[1], 'invert');

    var slCh2Vdiv = $('sl-ch2-vdiv');
    if (slCh2Vdiv) {
      slCh2Vdiv.addEventListener('input', function () {
        s.ch[1].vdivIdx = +slCh2Vdiv.value;
        var v   = window.EEEngine.VDIV_V[s.ch[1].vdivIdx];
        var lbl = $('lbl-ch2-vdiv');
        if (lbl) lbl.textContent = (v < 1 ? v.toFixed(1) : v.toFixed(0)) + 'V';
      });
    }

    var slCh2Off = $('sl-ch2-off');
    if (slCh2Off) {
      slCh2Off.addEventListener('input', function () {
        s.ch[1].offsetPct = +slCh2Off.value;
        var lbl = $('lbl-ch2-off');
        if (lbl) lbl.textContent = slCh2Off.value + '%';
      });
    }

    /* ── Channel tabs ── */
    var tab1 = $('tab-ch1');
    var tab2 = $('tab-ch2');
    if (tab1) tab1.addEventListener('click', function () { selectChTab(1); });
    if (tab2) tab2.addEventListener('click', function () { selectChTab(2); });

    /* ── Trigger level ── */
    var slTl = $('sl-trig-lv');
    if (slTl) {
      slTl.addEventListener('input', function () {
        s.trigLevel = +slTl.value / 100;
        var lbl = $('lbl-trig-lv');
        if (lbl) lbl.textContent = (s.trigLevel * window.EEEngine.VREF).toFixed(2) + 'V';
      });
    }

    /* Trigger source slider (1 = CH1, 2 = CH2) */
    var slTs = $('sl-trig-src');
    if (slTs) {
      slTs.addEventListener('input', function () {
        s.trigSrc = +slTs.value - 1;
        var lbl = $('lbl-trig-src');
        if (lbl) lbl.textContent = 'CH' + (s.trigSrc + 1);
      });
    }

    /* Trigger mode buttons */
    var trigModeGroup = ['btn-trig-auto', 'btn-trig-norm', 'btn-trig-none'];
    [['auto', 'auto'], ['norm', 'normal'], ['none', 'none']].forEach(function (pair) {
      var btn = $('btn-trig-' + pair[0]);
      if (btn) {
        btn.addEventListener('click', function () {
          s.trigMode = pair[1];
          setActive('btn-trig-' + pair[0], trigModeGroup);
        });
      }
    });

    /* Trigger edge */
    var edgeGroup = ['btn-trig-rise', 'btn-trig-fall'];
    var btnRise   = $('btn-trig-rise');
    var btnFall   = $('btn-trig-fall');
    if (btnRise) {
      btnRise.addEventListener('click', function () {
        s.trigEdge = 'rise';
        setActive('btn-trig-rise', edgeGroup);
      });
    }
    if (btnFall) {
      btnFall.addEventListener('click', function () {
        s.trigEdge = 'fall';
        setActive('btn-trig-fall', edgeGroup);
      });
    }

    /* Holdoff */
    var slHo = $('sl-holdoff');
    if (slHo) {
      slHo.addEventListener('input', function () {
        s.holdoffIdx = +slHo.value;
        var lbl = $('lbl-holdoff');
        if (lbl) lbl.textContent = window.EEEngine.HOLDOFF_MS[s.holdoffIdx] + 'ms';
      });
    }

    /* ── Cursors ── */
    var btnCursors = $('btn-cursors');
    if (btnCursors) {
      btnCursors.addEventListener('click', function () {
        s.cursorsEnabled = !s.cursorsEnabled;
        btnCursors.classList.toggle('is-active', s.cursorsEnabled);
        var panel = $('cursor-panel');
        if (panel) panel.classList.toggle('is-visible', s.cursorsEnabled);
      });
    }

    var btnCurReset = $('btn-cur-reset');
    if (btnCurReset) {
      btnCurReset.addEventListener('click', function () {
        s.cursorT1 = 0.25; s.cursorT2 = 0.75;
        s.cursorV1 = 0.35; s.cursorV2 = 0.65;
      });
    }

    /* ── Display options ── */
    var btnFFT = $('btn-fft');
    if (btnFFT) {
      btnFFT.addEventListener('click', function () {
        s.fftEnabled = !s.fftEnabled;
        btnFFT.classList.toggle('is-active', s.fftEnabled);
        if (window.EERender) window.EERender.resizeCanvas();
      });
    }

    wireToggle('btn-interp', s, 'interpolate');
    wireToggle('btn-fill',   s, 'fill');

    var slPersist = $('sl-persist');
    if (slPersist) {
      slPersist.addEventListener('input', function () {
        s.persistence = +slPersist.value / 100;
        var lbl = $('lbl-persist');
        if (lbl) lbl.textContent = slPersist.value + '%';
      });
    }

    /* ── Export ── */
    var btnPNG = $('btn-png');
    var btnCSV = $('btn-csv');
    if (btnPNG) btnPNG.addEventListener('click', exportPNG);
    if (btnCSV) btnCSV.addEventListener('click', exportCSV);

    /* ── Sketch modal ── */
    var btnSketch = $('btn-sketch');
    if (btnSketch) {
      btnSketch.addEventListener('click', function () {
        var pre = $('sketch-text');
        if (pre) pre.textContent = window.EELAB_SKETCH || '';
        var modal = $('sketch-modal-backdrop');
        if (modal) modal.classList.add('is-open');
      });
    }

    var btnModalClose = $('modal-close');
    if (btnModalClose) {
      btnModalClose.addEventListener('click', function () {
        var modal = $('sketch-modal-backdrop');
        if (modal) modal.classList.remove('is-open');
      });
    }

    var btnCopySketch = $('btn-copy-sketch');
    if (btnCopySketch) {
      btnCopySketch.addEventListener('click', function () {
        navigator.clipboard.writeText(window.EELAB_SKETCH || '');
        btnCopySketch.textContent = 'Copied!';
        setTimeout(function () {
          btnCopySketch.textContent = 'Copy';
        }, 2000);
      });
    }

    var btnDLSketch = $('btn-dl-sketch');
    if (btnDLSketch) {
      btnDLSketch.addEventListener('click', function () {
        var blob = new Blob([window.EELAB_SKETCH || ''], { type: 'text/plain' });
        var a = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'eelab77_scope.ino';
        a.click();
      });
    }

    /* ── Diagnostics modal ── */
    var btnDiag = $('btn-diag');
    if (btnDiag) {
      btnDiag.addEventListener('click', function () {
        var modal = $('diag-modal-backdrop');
        if (modal) modal.classList.add('is-open');
        runAllChecks();
      });
    }

    var btnDiagClose = $('diag-close');
    if (btnDiagClose) {
      btnDiagClose.addEventListener('click', function () {
        var modal = $('diag-modal-backdrop');
        if (modal) modal.classList.remove('is-open');
      });
    }

    var btnRunChecks = $('btn-run-checks');
    if (btnRunChecks) btnRunChecks.addEventListener('click', runAllChecks);

    var btnTest = $('btn-test');
    if (btnTest) btnTest.addEventListener('click', runSerialTest);

    var btnClearTest = $('btn-clear-test');
    if (btnClearTest) {
      btnClearTest.addEventListener('click', function () {
        var el = $('serial-test-out');
        if (!el) return;
        el.textContent = 'Output will appear here after running the test...';
        el.className   = 'serial-test-out is-empty';
      });
    }

    /* ── Initial UI state ── */
    selectChTab(1);
    setAcqMode('normal');
    var rowAvg = $('row-avg');
    if (rowAvg) rowAvg.style.display = 'none';

    /* Stats strip update every second */
    setInterval(updateStats, 1000);

    /* Startup log messages */
    log('EElab77 Scope v2.0 ready.', 'ok');
    log('Connect your Arduino to begin.', '');
    log('CH2 wired to A1. Enable it in the Channels panel.', '');
  }

  /* ── Expose public API ───────────────────────────────────── */
  /*
   * EEEngine calls back into these functions to update the DOM
   * without needing to know anything about it directly.
   */
  window.EEControls = {
    updateMeasurements: updateMeasurements,
    updateOverlays:     updateOverlays,
    updateCursorPanel:  updateCursorPanel,
    setAvgProgress:     setAvgProgress,
    syncRunState:       syncRunState,
    log:                log
  };

  /* ── Init on DOM ready ───────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', init);

}());

