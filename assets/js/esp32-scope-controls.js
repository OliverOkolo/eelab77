/**
 * esp32-scope-controls.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Wires every UI control in esp32-scope.html to ESP32Engine
 * and EEScopeTransport. Manages both USB and WiFi connection
 * modes, the connection overlay, WiFi configuration panel,
 * latency indicator, and all instrument controls.
 *
 * Exposes window.ESP32Controls so ESP32Engine can call back
 * into the DOM without a circular dependency.
 *
 * Depends on:
 *   esp32-scope-transport.js  (EEScopeTransport)
 *   esp32-scope-engine.js     (ESP32Engine)
 *   esp32-scope-render.js     (ESP32Render)
 *   esp32-scope-sketch.js     (EELAB_ESP32_SKETCH)
 * Load order: sketch → transport → engine → fft → render → controls
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Shorthand ───────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  /* ── Connection mode state ───────────────────────────────── */
  /*
   * 'usb'       — Web Serial selected
   * 'websocket' — WiFi / WebSocket selected
   */
  var selectedMode  = 'usb';

  /*
   * WiFi sub-mode:
   * 'ap'  — connect to ESP32 access point
   * 'sta' — ESP32 is on the same network, connect by IP
   */
  var wifiSubMode   = 'ap';

  /* ── Format helpers ──────────────────────────────────────── */
  function fmtTime(ms) {
    var a = Math.abs(ms);
    if (a === 0)   return '0';
    if (a < 0.001) return (ms * 1e6).toFixed(1)  + '\u03bcs';
    if (a < 1)     return (ms * 1000).toFixed(1)  + '\u03bcs';
    if (a < 1000)  return ms.toFixed(a < 10 ? 2 : 1) + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function fmtFreq(hz) {
    if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
    return hz.toFixed(2) + ' Hz';
  }

  /* ── Logging ─────────────────────────────────────────────── */
  function log(msg, cls) {
    var el = $('esp32-log');
    if (!el) return;
    var line = document.createElement('div');
    line.className  = 'log__line' + (cls ? ' log__line--' + cls : '');
    line.textContent =
      '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
    el.prepend(line);
    if (el.children.length > 80) el.removeChild(el.lastElementChild);
  }

  /* ── Badge helper ────────────────────────────────────────── */
  function setBadge(id, text, extraClass) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'badge' + (extraClass ? ' ' + extraClass : '');
  }

  /* ── Active button helper ────────────────────────────────── */
  function setActive(activeId, groupIds) {
    groupIds.forEach(function (id) {
      var el = $(id);
      if (el) el.classList.remove('is-active');
    });
    var el = $(activeId);
    if (el) el.classList.add('is-active');
  }

  /* ── Run state badge ─────────────────────────────────────── */
  function syncRunState() {
    var s = window.ESP32Engine.state;

    if (!window.EEScopeTransport.isConnected()) {
      setBadge('esp32-state-badge', 'IDLE', '');
    } else if (s.singleShot) {
      setBadge('esp32-state-badge', 'SINGLE', 'badge--amber');
    } else if (!s.running) {
      setBadge('esp32-state-badge', 'PAUSED', 'badge--amber');
    } else {
      setBadge('esp32-state-badge', 'LIVE', 'badge--live');
    }
  }

  /* ── Acquisition mode ────────────────────────────────────── */
  function setAcqMode(mode) {
    var s = window.ESP32Engine.state;
    s.acqMode = mode;
    window.ESP32Engine.resetAcq();

    setBadge('esp32-acq-badge', mode.toUpperCase(), '');
    setActive(
      'esp32-btn-acq-' + mode,
      ['esp32-btn-acq-normal',
       'esp32-btn-acq-avg',
       'esp32-btn-acq-peak']
    );

    var rowAvg = $('esp32-row-avg');
    if (rowAvg) {
      rowAvg.style.display = (mode === 'average') ? 'flex' : 'none';
    }
    log('Acquisition \u2192 ' + mode);
  }

  /* ── Measurement display ─────────────────────────────────── */
  function updateMeasurements(chIdx, m) {
    var p = chIdx === 0 ? 'esp32-m1' : 'esp32-m2';

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
    var el = $('esp32-m1-freq');
    if (el) el.textContent = n + '/' + target;
  }

  /* ── Canvas overlays ─────────────────────────────────────── */
  function updateOverlays(trigState, timebaseMs) {
    var trigEl    = $('esp32-trig-state');
    var connected = window.EEScopeTransport &&
                    window.EEScopeTransport.isConnected();

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

    var tbEl = $('esp32-timebase-label');
    if (tbEl) tbEl.textContent = fmtTime(timebaseMs) + '/div';
  }

  /* ── Cursor panel ────────────────────────────────────────── */
  function updateCursorPanel(vals) {
    function set(id, v) {
      var el = $(id);
      if (el) el.textContent = v;
    }
    set('esp32-cp-t1', fmtTime(vals.t1 * 1000));
    set('esp32-cp-t2', fmtTime(vals.t2 * 1000));
    set('esp32-cp-dt', fmtTime(vals.dt * 1000));
    set('esp32-cp-f',  vals.dt > 0 ? fmtFreq(1 / vals.dt) : '\u2014');
    set('esp32-cp-v1', vals.v1.toFixed(3) + ' V');
    set('esp32-cp-v2', vals.v2.toFixed(3) + ' V');
    set('esp32-cp-dv', Math.abs(vals.v1 - vals.v2).toFixed(3) + ' V');
  }

  /* ── Latency indicator ───────────────────────────────────── */
  function updateLatency(ms) {
    var el  = $('esp32-latency');
    var val = $('esp32-latency-val');
    if (!el || !val) return;

    val.textContent = ms + 'ms';

    el.classList.remove('is-good', 'is-fair', 'is-poor');
    val.classList.remove(
      'latency-indicator__value--good',
      'latency-indicator__value--fair',
      'latency-indicator__value--poor'
    );

    if (ms < 30) {
      el.classList.add('is-good');
      val.classList.add('latency-indicator__value--good');
    } else if (ms < 80) {
      el.classList.add('is-fair');
      val.classList.add('latency-indicator__value--fair');
    } else {
      el.classList.add('is-poor');
      val.classList.add('latency-indicator__value--poor');
    }
  }

  /* ── Stats strip ─────────────────────────────────────────── */
  function updateStats() {
    var connected =
      window.EEScopeTransport && window.EEScopeTransport.isConnected();
    var ids = [
      'esp32-st-bps', 'esp32-st-fps',
      'esp32-st-err', 'esp32-st-sr',
      'esp32-st-ch2', 'esp32-st-health'
    ];

    if (!connected) {
      ids.forEach(function (id) {
        var el = $(id);
        if (el) {
          el.textContent = '\u2014';
          el.className   = 'stat-cell__value';
        }
      });
      return;
    }

    var diag    = window.EEScopeTransport.getDiag();
    var elapsed = Math.max(1, (Date.now() - diag.connectTime) / 1000);
    var bps     = diag.bytesWindow;
    var fps     = diag.framesWindow;

    diag.bytesWindow  = 0;
    diag.framesWindow = 0;

    var sr     = diag.framesTotal / elapsed;
    var health = diag.bytesTotal > 0
      ? Math.min(100,
          Math.round(diag.framesTotal / (diag.bytesTotal / 4) * 100))
      : 0;

    /* Feed estimated sample rate back to engine */
    if (diag.framesTotal > 500) {
      window.ESP32Engine.state.sampleRate = Math.round(sr);
    }

    function setStat(id, value, cls) {
      var el = $(id);
      if (!el) return;
      el.textContent = value;
      el.className   = 'stat-cell__value stat-cell__value--' + cls;
    }

    setStat('esp32-st-bps',
      bps > 1000 ? (bps / 1000).toFixed(1) + 'k' : bps,
      bps > 0 ? 'ok' : 'err');

    setStat('esp32-st-fps', fps,
      fps > 0 ? 'ok' : 'warn');

    setStat('esp32-st-err', diag.syncErrors,
      diag.syncErrors === 0 ? 'ok'
        : diag.syncErrors < 50 ? 'warn' : 'err');

    setStat('esp32-st-sr',
      sr > 1000 ? (sr / 1000).toFixed(1) + 'k' : Math.round(sr),
      sr > 1000 ? 'ok' : 'warn');

    setStat('esp32-st-ch2', diag.frames2,
      window.ESP32Engine.state.ch[1].enabled && diag.frames2 > 0
        ? 'ok' : '');

    setStat('esp32-st-health', health + '%',
      health >= 80 ? 'ok' : health >= 40 ? 'warn' : 'err');

    /* Watchdog */
    var since = Date.now() - diag.lastByteTime;
    if (connected && diag.lastByteTime > 0 && since > 3000) {
      log('\u26A0 No data for ' +
        Math.round(since / 1000) + 's \u2014 check connection', 'warn');
      diag.lastByteTime = Date.now();
    }
  }

  /* ── Export ──────────────────────────────────────────────── */
  function exportPNG() {
    var scopeCanvas = $('esp-scope-canvas');
    var fftCanvas   = $('esp-fft-canvas');
    var fftVisible  =
      fftCanvas && fftCanvas.style.display !== 'none';

    var out = document.createElement('canvas');
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
    a.download = 'eelab77_esp32_' + Date.now() + '.png';
    a.href     = out.toDataURL('image/png');
    a.click();
    log('Exported PNG', 'ok');
  }

  function exportCSV() {
    var data = window.ESP32Engine.getDisplayData();
    if (!data.frozenRaw1) { log('No data to export', 'warn'); return; }

    var n    = data.frozenRaw1.length;
    var eng  = window.ESP32Engine;
    var dtS  =
      (eng.TIMEBASE_MS[eng.state.timebaseIdx] / 1000 * eng.GRID_X) / n;
    var VREF = eng.VREF;
    var MAX  = eng.ADC_MAX;

    var lines = ['time_s,ch1_raw,ch1_v'];
    if (data.frozen2) lines[0] += ',ch2_raw,ch2_v';

    for (var i = 0; i < n; i++) {
      var row =
        (i * dtS).toFixed(6) +
        ',' + data.frozenRaw1[i] +
        ',' + (data.frozenRaw1[i] / MAX * VREF).toFixed(5);

      if (data.frozen2 && i < data.frozen2.length) {
        var r2 = Math.round(data.frozen2[i]);
        row += ',' + r2 + ',' + (r2 / MAX * VREF).toFixed(5);
      }
      lines.push(row);
    }

    var a = document.createElement('a');
    a.download = 'eelab77_esp32_' + Date.now() + '.csv';
    a.href     = URL.createObjectURL(
      new Blob([lines.join('\n')], { type: 'text/csv' })
    );
    a.click();
    log('Exported CSV (' + n + ' samples)', 'ok');
  }

  /* ── Connection mode UI ──────────────────────────────────── */

  function selectConnMode(mode) {
    selectedMode = mode;

    /* Update mode switcher buttons */
    var btnUsb  = $('esp32-conn-usb');
    var btnWifi = $('esp32-conn-wifi');
    if (btnUsb) {
      btnUsb.classList.toggle('is-active--usb',  mode === 'usb');
    }
    if (btnWifi) {
      btnWifi.classList.toggle('is-active--wifi', mode === 'websocket');
    }

    /* Show/hide WiFi panel */
    var wifiPanel = $('esp32-wifi-panel');
    if (wifiPanel) {
      wifiPanel.classList.toggle('is-visible', mode === 'websocket');
    }

    /* Update overlay tabs */
    var tabUsb  = $('overlay-tab-usb');
    var tabWifi = $('overlay-tab-wifi');
    if (tabUsb) {
      tabUsb.classList.toggle('is-active--usb',  mode === 'usb');
    }
    if (tabWifi) {
      tabWifi.classList.toggle('is-active--wifi', mode === 'websocket');
    }

    /* Show/hide overlay panels */
    var ovUsb  = $('overlay-usb-panel');
    var ovWifi = $('overlay-wifi-panel');
    if (ovUsb)  ovUsb.classList.toggle('is-visible',  mode === 'usb');
    if (ovWifi) ovWifi.classList.toggle('is-visible', mode === 'websocket');

    /* Latency indicator only relevant in WiFi mode */
    var latEl = $('esp32-latency-wrap');
    if (latEl) {
      latEl.style.display = mode === 'websocket' ? 'flex' : 'none';
    }

    log('Transport mode \u2192 ' + mode);
  }

  function selectWifiSubMode(sub) {
    wifiSubMode = sub;

    var btnAP  = $('wifi-sub-ap');
    var btnSTA = $('wifi-sub-sta');
    if (btnAP)  btnAP.classList.toggle('is-active',  sub === 'ap');
    if (btnSTA) btnSTA.classList.toggle('is-active', sub === 'sta');

    var apInfo  = $('wifi-ap-info');
    var staForm = $('wifi-sta-fields');
    var hostRow = $('wifi-host-row');

    if (apInfo)  apInfo.style.display  = sub === 'ap'  ? 'block' : 'none';
    if (staForm) staForm.style.display = sub === 'sta' ? 'flex'  : 'none';
    if (hostRow) hostRow.style.display = sub === 'sta' ? 'flex'  : 'none';
  }

  /* ── Connect ─────────────────────────────────────────────── */
  async function connect() {
    if (selectedMode === 'usb') {
      var baudEl   = $('esp32-baud-select');
      var baudRate = baudEl ? parseInt(baudEl.value) : 500000;
      await window.EEScopeTransport.connect('usb', { baudRate: baudRate });

    } else {
      /* WebSocket — determine host from sub-mode */
      var host, port;

      if (wifiSubMode === 'ap') {
        /* Default AP IP */
        host = '192.168.4.1';
        port = 81;
      } else {
        /* Station mode — read from input */
        var hostEl = $('wifi-sta-host');
        var portEl = $('wifi-sta-port');
        host = hostEl ? hostEl.value.trim() : '192.168.4.1';
        port = portEl ? parseInt(portEl.value) || 81 : 81;
      }

      window.EEScopeTransport.connect('websocket', {
        host: host,
        port: port
      });
    }
  }

  async function disconnect() {
    await window.EEScopeTransport.disconnect();
  }

  /* ── IP address display ──────────────────────────────────── */
  function showIPAddress(ip) {
    var el = $('esp32-ip-display');
    var addr = $('esp32-ip-addr');
    if (!el || !addr) return;
    addr.textContent = ip;
    el.classList.add('is-visible');
  }

  function hideIPAddress() {
    var el = $('esp32-ip-display');
    if (el) el.classList.remove('is-visible');
  }

  /* ── WiFi status indicator ───────────────────────────────── */
  function setWifiStatus(type, text) {
    var dot  = $('esp32-wifi-dot');
    var txt  = $('esp32-wifi-text');
    if (!dot || !txt) return;

    dot.className  = 'wifi-status__dot';
    txt.className  = 'wifi-status__text';

    if (type === 'connected') {
      dot.classList.add('wifi-status__dot--connected');
      txt.classList.add('wifi-status__text--connected');
    } else if (type === 'ap') {
      dot.classList.add('wifi-status__dot--ap');
      txt.classList.add('wifi-status__text--ap');
    } else if (type === 'error') {
      dot.classList.add('wifi-status__dot--error');
      txt.classList.add('wifi-status__text--error');
    }

    txt.textContent = text;
  }

  /* ── Transport status handler ────────────────────────────── */
  function handleStatus(event, detail) {
    switch (event) {

      case 'no-serial':
        var warn = $('esp32-no-serial-warn');
        if (warn) warn.style.display = 'block';
        log('Web Serial not supported \u2014 use Chrome/Edge or WiFi.', 'err');
        break;

      case 'connected': {
        var overlay = $('esp32-connect-overlay');
        if (overlay) overlay.classList.add('is-hidden');

        var mode = detail.mode;

        if (mode === 'usb') {
          setBadge('esp32-conn-badge', 'USB', 'badge--usb');
          log('USB connected @ ' + detail.baudRate + ' baud', 'ok');
        } else {
          setBadge('esp32-conn-badge', 'WIFI', 'badge--wifi');
          setWifiStatus('connected', detail.host + ':' + detail.port);
          showIPAddress(detail.host);
          log('WebSocket connected \u2192 ' + detail.host + ':' + detail.port, 'ok');
        }

        setBadge('esp32-state-badge', 'LIVE', 'badge--live');
        break;
      }

      case 'streaming':
        log('Streaming started', 'ok');
        /* Send board info to engine */
        window.EEScopeTransport.sendCmd('I');
        break;

      case 'disconnected':
        var ov2 = $('esp32-connect-overlay');
        if (ov2) ov2.classList.remove('is-hidden');
        setBadge('esp32-conn-badge', 'DISCONNECTED', '');
        setBadge('esp32-state-badge', 'IDLE', '');
        hideIPAddress();
        setWifiStatus('', 'Not connected');
        log('Disconnected', 'warn');
        break;

      case 'connect-error':
        log('Connect failed: ' + detail, 'err');
        setWifiStatus('error', 'Connection failed');
        break;

      case 'ws-connecting':
        log('WebSocket connecting \u2192 ' + detail, '');
        setWifiStatus('', 'Connecting...');
        break;

      case 'ws-reconnecting':
        log('WebSocket reconnecting (attempt ' +
          detail.attempt + '/' + detail.maxAttempts + ')...', 'warn');
        setWifiStatus('error',
          'Reconnecting ' + detail.attempt + '/' + detail.maxAttempts + '...');
        break;

      case 'read-error':
        log('Read error: ' + detail, 'err');
        break;
    }
  }

  /* ── Diagnostics checks ──────────────────────────────────── */
  function addCheck(c, icon, cls, text, sub) {
    var row = document.createElement('div');
    row.className = 'diag-check';
    row.innerHTML =
      '<div class="diag-check__icon diag-check__icon--' + cls + '">' +
        icon +
      '</div>' +
      '<div>' +
        '<div class="diag-check__text">' + text + '</div>' +
        (sub
          ? '<div class="diag-check__sub">' + sub + '</div>'
          : '') +
      '</div>';
    c.appendChild(row);
  }

  function runAllChecks() {
    var c = $('esp32-diag-checks');
    if (!c) return;
    c.innerHTML = '';

    var transport = window.EEScopeTransport;
    var connected = transport && transport.isConnected();
    var mode      = transport ? transport.getMode() : null;
    var diag      = connected ? transport.getDiag() : null;

    /* Web Serial availability (only relevant in USB mode) */
    if (selectedMode === 'usb') {
      addCheck(c,
        navigator.serial ? '\u2713' : '\u2717',
        navigator.serial ? 'pass'   : 'fail',
        navigator.serial
          ? 'Web Serial API supported'
          : 'Web Serial NOT supported',
        navigator.serial
          ? 'Chrome or Edge detected.'
          : 'Switch to Chrome/Edge, or use WiFi mode instead.'
      );
    } else {
      addCheck(c, '\u2713', 'pass',
        'WiFi mode selected \u2014 works in any browser', '');
    }

    /* Connection */
    if (connected) {
      addCheck(c, '\u2713', 'pass',
        'Connected via ' + (mode === 'usb' ? 'USB' : 'WebSocket'),
        mode === 'websocket'
          ? 'Latency: ' + diag.latencyMs + 'ms'
          : 'Baud: ' + ($('esp32-baud-select')
              ? $('esp32-baud-select').value : '?'));
    } else {
      addCheck(c, '\u2717', 'fail',
        'Not connected', 'Click Connect.');
    }

    if (connected && diag) {

      /* Data flow */
      var since = Date.now() - diag.lastByteTime;
      if (diag.bytesTotal === 0) {
        addCheck(c, '\u2717', 'fail',
          'No bytes received',
          'Sketch not running, wrong baud, or wrong IP address.');
      } else if (since > 3000) {
        addCheck(c, '\u26A0', 'warn',
          'Data stopped ' + Math.round(since / 1000) + 's ago',
          'ESP32 may have reset or lost WiFi.');
      } else {
        addCheck(c, '\u2713', 'pass',
          diag.bytesTotal.toLocaleString() + ' bytes received',
          'Data flowing from ESP32.');
      }

      /* Frame health */
      var health = diag.bytesTotal > 0
        ? Math.min(100,
            Math.round(diag.framesTotal / (diag.bytesTotal / 4) * 100))
        : 0;

      addCheck(c,
        health >= 80 ? '\u2713' : health >= 40 ? '\u26A0' : '\u2717',
        health >= 80 ? 'pass'   : health >= 40 ? 'warn'   : 'fail',
        'Frame health ' + health + '%',
        health >= 80
          ? 'Protocol sync is good.'
          : health >= 40
            ? 'Partial sync. USB: try lower baud. WiFi: check signal.'
            : 'Very low health. USB: baud mismatch. WiFi: interference.'
      );

      /* Sync errors */
      addCheck(c,
        diag.syncErrors === 0 ? '\u2713' : diag.syncErrors < 50 ? '\u26A0' : '\u2717',
        diag.syncErrors === 0 ? 'pass'   : diag.syncErrors < 50 ? 'warn'   : 'fail',
        diag.syncErrors + ' sync errors',
        diag.syncErrors === 0
          ? 'Frame boundaries are clean.'
          : 'Possible interference or baud mismatch.'
      );

      /* CH2 */
      if (window.ESP32Engine.state.ch[1].enabled) {
        addCheck(c,
          diag.frames2 > 10 ? '\u2713' : '\u26A0',
          diag.frames2 > 10 ? 'pass'   : 'warn',
          'CH2 frames: ' + diag.frames2,
          diag.frames2 > 10
            ? 'CH2 is streaming.'
            : 'No CH2 data. Check ch2Enable = true in sketch.'
        );
      }

      /* Sample rate */
      if (diag.framesTotal > 200) {
        var elapsed = Math.max(1, (Date.now() - diag.connectTime) / 1000);
        var sr      = Math.round(diag.framesTotal / elapsed);
        addCheck(c,
          sr > 10000 ? '\u2713' : '\u26A0',
          sr > 10000 ? 'pass'   : 'warn',
          'Estimated sample rate: ' + sr.toLocaleString() + ' Hz',
          'Target: ~100\u2013200 kSPS aggregate.'
        );
      }

      /* WiFi-specific: latency */
      if (mode === 'websocket') {
        var lat = diag.latencyMs;
        addCheck(c,
          lat < 30 ? '\u2713' : lat < 80 ? '\u26A0' : '\u2717',
          lat < 30 ? 'pass'   : lat < 80 ? 'warn'   : 'fail',
          'WebSocket latency: ' + lat + 'ms',
          lat < 30
            ? 'Excellent \u2014 minimal buffering.'
            : lat < 80
              ? 'Acceptable \u2014 minor delays possible.'
              : 'High latency. Move closer to ESP32 or use USB.'
        );
      }
    }
  }

  /* ── Serial echo test ────────────────────────────────────── */
  var testLines = [];

  function runSerialTest() {
    var outEl = $('esp32-serial-test-out');
    if (!outEl) return;

    if (!window.EEScopeTransport.isConnected()) {
      outEl.textContent = '\u2717 Not connected.';
      outEl.className   = 'serial-test-out';
      return;
    }

    outEl.className   = 'serial-test-out';
    outEl.textContent = 'Sending T to ESP32...\n';
    testLines         = [];

    window.EEScopeTransport.onRawText = function (text) {
      var lines = text.split(/\r?\n/);
      lines.forEach(function (l) {
        var t = l.trim();
        if (t) testLines.push(t);
      });
      outEl.textContent = testLines.join('\n');
    };

    var dots = 0;
    var iv = setInterval(function () {
      dots++;
      if (testLines.length === 0) {
        outEl.textContent = 'Waiting' + '.'.repeat(dots % 4);
      }
    }, 300);

    var ok = window.EEScopeTransport.runSerialTest();

    if (!ok) {
      clearInterval(iv);
      outEl.textContent = '\u2717 Not connected.';
      return;
    }

    setTimeout(function () {
      clearInterval(iv);
      window.EEScopeTransport.onRawText = null;
      outEl.textContent = testLines.length > 0
        ? testLines.join('\n')
        : '(no response \u2014 check connection and sketch)';
      testLines = [];
      log('Self-test complete \u2014 streaming resumed', 'ok');
      runAllChecks();
    }, 3200);
  }

  /* ── Wire toggle helper ──────────────────────────────────── */
  function wireToggle(id, stateObj, prop) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('click', function () {
      stateObj[prop] = !stateObj[prop];
      el.classList.toggle('is-active', stateObj[prop]);
    });
  }

  /* ── Wire all controls ───────────────────────────────────── */
  function init() {
    var s = window.ESP32Engine.state;

    /* Register transport callbacks */
    window.EEScopeTransport.onStatus  = handleStatus;
    window.EEScopeTransport.onLatency = updateLatency;

    /* ── Connection mode switcher ── */
    var btnUsb  = $('esp32-conn-usb');
    var btnWifi = $('esp32-conn-wifi');
    if (btnUsb)  btnUsb.addEventListener('click',
      function () { selectConnMode('usb'); });
    if (btnWifi) btnWifi.addEventListener('click',
      function () { selectConnMode('websocket'); });

    /* Overlay mode tabs */
    var tabUsb  = $('overlay-tab-usb');
    var tabWifi = $('overlay-tab-wifi');
    if (tabUsb)  tabUsb.addEventListener('click',
      function () { selectConnMode('usb'); });
    if (tabWifi) tabWifi.addEventListener('click',
      function () { selectConnMode('websocket'); });

    /* WiFi sub-mode */
    var subAP  = $('wifi-sub-ap');
    var subSTA = $('wifi-sub-sta');
    if (subAP)  subAP.addEventListener('click',
      function () { selectWifiSubMode('ap'); });
    if (subSTA) subSTA.addEventListener('click',
      function () { selectWifiSubMode('sta'); });

    /* Connect / Disconnect */
    [$('esp32-btn-connect-overlay'),
     $('esp32-btn-connect')].forEach(function (btn) {
      if (btn) btn.addEventListener('click', connect);
    });
    var btnD = $('esp32-btn-disconnect');
    if (btnD) btnD.addEventListener('click', disconnect);

    /* IP address copy */
    var ipEl = $('esp32-ip-display');
    if (ipEl) {
      ipEl.addEventListener('click', function () {
        var addr = $('esp32-ip-addr');
        if (addr) {
          navigator.clipboard.writeText(addr.textContent);
          var copy = $('esp32-ip-copy');
          if (copy) {
            copy.textContent = 'Copied!';
            setTimeout(function () {
              copy.textContent = 'click to copy';
            }, 1500);
          }
        }
      });
    }

    /* Board selector */
    var boardS3  = $('board-btn-s3');
    var boardCls = $('board-btn-classic');
    if (boardS3) {
      boardS3.addEventListener('click', function () {
        boardS3.classList.add('is-active');
        if (boardCls) boardCls.classList.remove('is-active');
        /* S3 uses native USB — higher default baud */
        var baudEl = $('esp32-baud-select');
        if (baudEl) baudEl.value = '0';
        log('Board \u2192 ESP32-S3 (native USB)', '');
      });
    }
    if (boardCls) {
      boardCls.addEventListener('click', function () {
        boardCls.classList.add('is-active');
        if (boardS3) boardS3.classList.remove('is-active');
        var baudEl = $('esp32-baud-select');
        if (baudEl) baudEl.value = '500000';
        log('Board \u2192 ESP32 Classic (USB bridge)', '');
      });
    }

    /* ── Run / Pause / Single ── */
    var runGroup = [
      'esp32-btn-run', 'esp32-btn-pause', 'esp32-btn-single'
    ];

    var btnRun = $('esp32-btn-run');
    if (btnRun) {
      btnRun.addEventListener('click', function () {
        s.running = true; s.singleShot = false;
        setActive('esp32-btn-run', runGroup);
        syncRunState();
      });
    }

    var btnPause = $('esp32-btn-pause');
    if (btnPause) {
      btnPause.addEventListener('click', function () {
        s.running = false; s.singleShot = false;
        setActive('esp32-btn-pause', runGroup);
        syncRunState();
      });
    }

    var btnSingle = $('esp32-btn-single');
    if (btnSingle) {
      btnSingle.addEventListener('click', function () {
        s.running = true; s.singleShot = true;
        setActive('esp32-btn-single', runGroup);
        syncRunState();
      });
    }

    /* ── Acquisition modes ── */
    var acqGroup = [
      'esp32-btn-acq-normal',
      'esp32-btn-acq-avg',
      'esp32-btn-acq-peak'
    ];

    ['normal', 'avg', 'peak'].forEach(function (mode) {
      var btn = $('esp32-btn-acq-' + mode);
      if (btn) {
        btn.addEventListener('click', function () {
          setAcqMode(mode === 'avg' ? 'average' : mode);
        });
      }
    });

    /* Avg count slider */
    var slAvg = $('esp32-sl-avg');
    if (slAvg) {
      slAvg.addEventListener('input', function () {
        s.avgTarget = window.ESP32Engine.AVG_COUNTS[+slAvg.value];
        var lbl = $('esp32-lbl-avg');
        if (lbl) lbl.textContent = s.avgTarget;
        window.ESP32Engine.resetAcq();
      });
    }

    /* Rolling */
    var btnRolling = $('esp32-btn-rolling');
    if (btnRolling) {
      btnRolling.addEventListener('click', function () {
        s.rollingMode = !s.rollingMode;
        btnRolling.classList.toggle('is-active', s.rollingMode);
      });
    }

    /* ── Timebase ── */
    var slTb = $('esp32-sl-tb');
    if (slTb) {
      slTb.addEventListener('input', function () {
        s.timebaseIdx = +slTb.value;
        var lbl = $('esp32-lbl-tb');
        if (lbl) {
          lbl.textContent =
            fmtTime(window.ESP32Engine.TIMEBASE_MS[s.timebaseIdx]);
        }
      });
    }

    /* ── CH1 controls ── */
    wireToggle('esp32-btn-ch1-ac',  s.ch[0], 'acCouple');
    wireToggle('esp32-btn-ch1-inv', s.ch[0], 'invert');

    var slCh1Vdiv = $('esp32-sl-ch1-vdiv');
    if (slCh1Vdiv) {
      slCh1Vdiv.addEventListener('input', function () {
        s.ch[0].vdivIdx = +slCh1Vdiv.value;
        var v   = window.ESP32Engine.VDIV_V[s.ch[0].vdivIdx];
        var lbl = $('esp32-lbl-ch1-vdiv');
        if (lbl) {
          lbl.textContent = (v < 1 ? v.toFixed(2) : v.toFixed(1)) + 'V';
        }
      });
    }

    var slCh1Off = $('esp32-sl-ch1-off');
    if (slCh1Off) {
      slCh1Off.addEventListener('input', function () {
        s.ch[0].offsetPct = +slCh1Off.value;
        var lbl = $('esp32-lbl-ch1-off');
        if (lbl) lbl.textContent = slCh1Off.value + '%';
      });
    }

    /* ── CH2 controls ── */
    var btnCh2En = $('esp32-btn-ch2-en');
    if (btnCh2En) {
      btnCh2En.addEventListener('click', function () {
        s.ch[1].enabled = !s.ch[1].enabled;
        btnCh2En.textContent =
          s.ch[1].enabled ? 'CH2 Enabled' : 'Enable CH2';
        btnCh2En.classList.toggle('is-active--amber', s.ch[1].enabled);

        var badge = $('esp32-ch2-badge');
        if (badge) badge.style.opacity = s.ch[1].enabled ? '1' : '0.35';

        var row = $('esp32-ch2-meas-row');
        if (row) row.style.display = s.ch[1].enabled ? 'flex' : 'none';

        /* Tell ESP32 to enable/disable CH2 streaming */
        window.EEScopeTransport.sendCmd(s.ch[1].enabled ? '2' : '1');
        log('CH2 ' + (s.ch[1].enabled ? 'enabled' : 'disabled'));
      });
    }

    wireToggle('esp32-btn-ch2-ac',  s.ch[1], 'acCouple');
    wireToggle('esp32-btn-ch2-inv', s.ch[1], 'invert');

    var slCh2Vdiv = $('esp32-sl-ch2-vdiv');
    if (slCh2Vdiv) {
      slCh2Vdiv.addEventListener('input', function () {
        s.ch[1].vdivIdx = +slCh2Vdiv.value;
        var v   = window.ESP32Engine.VDIV_V[s.ch[1].vdivIdx];
        var lbl = $('esp32-lbl-ch2-vdiv');
        if (lbl) {
          lbl.textContent = (v < 1 ? v.toFixed(2) : v.toFixed(1)) + 'V';
        }
      });
    }

    var slCh2Off = $('esp32-sl-ch2-off');
    if (slCh2Off) {
      slCh2Off.addEventListener('input', function () {
        s.ch[1].offsetPct = +slCh2Off.value;
        var lbl = $('esp32-lbl-ch2-off');
        if (lbl) lbl.textContent = slCh2Off.value + '%';
      });
    }

    /* ── Channel tabs ── */
    var tab1 = $('esp32-tab-ch1');
    var tab2 = $('esp32-tab-ch2');
    if (tab1) {
      tab1.addEventListener('click', function () {
        $('esp32-ch1-panel').style.display = 'block';
        $('esp32-ch2-panel').style.display = 'none';
        tab1.className = 'ch-tab is-active--ch1';
        tab2.className = 'ch-tab';
      });
    }
    if (tab2) {
      tab2.addEventListener('click', function () {
        $('esp32-ch1-panel').style.display = 'none';
        $('esp32-ch2-panel').style.display = 'block';
        tab1.className = 'ch-tab';
        tab2.className = 'ch-tab is-active--ch2';
      });
    }

    /* ── Trigger ── */
    var slTl = $('esp32-sl-trig-lv');
    if (slTl) {
      slTl.addEventListener('input', function () {
        s.trigLevel = +slTl.value / 100;
        var lbl = $('esp32-lbl-trig-lv');
        if (lbl) {
          lbl.textContent =
            (s.trigLevel * window.ESP32Engine.VREF).toFixed(2) + 'V';
        }
      });
    }

    var slTs = $('esp32-sl-trig-src');
    if (slTs) {
      slTs.addEventListener('input', function () {
        s.trigSrc = +slTs.value - 1;
        var lbl = $('esp32-lbl-trig-src');
        if (lbl) lbl.textContent = 'CH' + (s.trigSrc + 1);
      });
    }

    var trigModeGroup = [
      'esp32-btn-trig-auto',
      'esp32-btn-trig-norm',
      'esp32-btn-trig-none'
    ];
    [['auto', 'auto'], ['norm', 'normal'], ['none', 'none']].forEach(
      function (pair) {
        var btn = $('esp32-btn-trig-' + pair[0]);
        if (btn) {
          btn.addEventListener('click', function () {
            s.trigMode = pair[1];
            setActive('esp32-btn-trig-' + pair[0], trigModeGroup);
          });
        }
      }
    );

    var edgeGroup = ['esp32-btn-trig-rise', 'esp32-btn-trig-fall'];
    var btnRise   = $('esp32-btn-trig-rise');
    var btnFall   = $('esp32-btn-trig-fall');
    if (btnRise) {
      btnRise.addEventListener('click', function () {
        s.trigEdge = 'rise';
        setActive('esp32-btn-trig-rise', edgeGroup);
      });
    }
    if (btnFall) {
      btnFall.addEventListener('click', function () {
        s.trigEdge = 'fall';
        setActive('esp32-btn-trig-fall', edgeGroup);
      });
    }

    var slHo = $('esp32-sl-holdoff');
    if (slHo) {
      slHo.addEventListener('input', function () {
        s.holdoffIdx = +slHo.value;
        var lbl = $('esp32-lbl-holdoff');
        if (lbl) {
          lbl.textContent =
            window.ESP32Engine.HOLDOFF_MS[s.holdoffIdx] + 'ms';
        }
      });
    }

    /* ── Cursors ── */
    var btnCursors = $('esp32-btn-cursors');
    if (btnCursors) {
      btnCursors.addEventListener('click', function () {
        s.cursorsEnabled = !s.cursorsEnabled;
        btnCursors.classList.toggle('is-active', s.cursorsEnabled);
        var panel = $('esp32-cursor-panel');
        if (panel) panel.classList.toggle('is-visible', s.cursorsEnabled);
      });
    }

    var btnCurReset = $('esp32-btn-cur-reset');
    if (btnCurReset) {
      btnCurReset.addEventListener('click', function () {
        s.cursorT1 = 0.25; s.cursorT2 = 0.75;
        s.cursorV1 = 0.35; s.cursorV2 = 0.65;
      });
    }

    /* ── Display ── */
    var btnFFT = $('esp32-btn-fft');
    if (btnFFT) {
      btnFFT.addEventListener('click', function () {
        s.fftEnabled = !s.fftEnabled;
        btnFFT.classList.toggle('is-active', s.fftEnabled);
        if (window.ESP32Render) window.ESP32Render.resizeCanvas();
        var main = $('inst-main');
        if (main) main.classList.toggle('fft-active', s.fftEnabled);
      });
    }

    wireToggle('esp32-btn-interp', s, 'interpolate');
    wireToggle('esp32-btn-fill',   s, 'fill');

    var slPersist = $('esp32-sl-persist');
    if (slPersist) {
      slPersist.addEventListener('input', function () {
        s.persistence = +slPersist.value / 100;
        var lbl = $('esp32-lbl-persist');
        if (lbl) lbl.textContent = slPersist.value + '%';
      });
    }

    /* ── Export ── */
    var btnPNG = $('esp32-btn-png');
    var btnCSV = $('esp32-btn-csv');
    if (btnPNG) btnPNG.addEventListener('click', exportPNG);
    if (btnCSV) btnCSV.addEventListener('click', exportCSV);

    /* ── Sketch modal ── */
    var btnSketch = $('esp32-btn-sketch');
    if (btnSketch) {
      btnSketch.addEventListener('click', function () {
        var pre = $('esp32-sketch-text');
        if (pre) pre.textContent = window.EELAB_ESP32_SKETCH || '';
        var modal = $('esp32-sketch-modal-backdrop');
        if (modal) modal.classList.add('is-open');
      });
    }

    var btnModalClose = $('esp32-modal-close');
    if (btnModalClose) {
      btnModalClose.addEventListener('click', function () {
        var modal = $('esp32-sketch-modal-backdrop');
        if (modal) modal.classList.remove('is-open');
      });
    }

    var btnCopySketch = $('esp32-btn-copy-sketch');
    if (btnCopySketch) {
      btnCopySketch.addEventListener('click', function () {
        navigator.clipboard.writeText(window.EELAB_ESP32_SKETCH || '');
        btnCopySketch.textContent = 'Copied!';
        setTimeout(function () {
          btnCopySketch.textContent = 'Copy';
        }, 2000);
      });
    }

    var btnDLSketch = $('esp32-btn-dl-sketch');
    if (btnDLSketch) {
      btnDLSketch.addEventListener('click', function () {
        var blob = new Blob(
          [window.EELAB_ESP32_SKETCH || ''],
          { type: 'text/plain' }
        );
        var a = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'eelab77_esp32_scope.ino';
        a.click();
      });
    }

    /* ── Diagnostics modal ── */
    var btnDiag = $('esp32-btn-diag');
    if (btnDiag) {
      btnDiag.addEventListener('click', function () {
        var modal = $('esp32-diag-modal-backdrop');
        if (modal) modal.classList.add('is-open');
        runAllChecks();
      });
    }

    var btnDiagClose = $('esp32-diag-close');
    if (btnDiagClose) {
      btnDiagClose.addEventListener('click', function () {
        var modal = $('esp32-diag-modal-backdrop');
        if (modal) modal.classList.remove('is-open');
      });
    }

    var btnRunChecks = $('esp32-btn-run-checks');
    if (btnRunChecks) btnRunChecks.addEventListener('click', runAllChecks);

    var btnTest = $('esp32-btn-test');
    if (btnTest) btnTest.addEventListener('click', runSerialTest);

    var btnClearTest = $('esp32-btn-clear-test');
    if (btnClearTest) {
      btnClearTest.addEventListener('click', function () {
        var el = $('esp32-serial-test-out');
        if (!el) return;
        el.textContent = 'Output will appear here...';
        el.className   = 'serial-test-out is-empty';
      });
    }

    /* ── Initial UI state ── */
    selectConnMode('usb');
    selectWifiSubMode('ap');
    setAcqMode('normal');
    $('esp32-ch2-panel') &&
      ($('esp32-ch2-panel').style.display = 'none');
    $('esp32-row-avg') &&
      ($('esp32-row-avg').style.display = 'none');

    /* Stats strip interval */
    setInterval(updateStats, 1000);

    /* Startup log */
    log('EElab77 ESP32 Scope ready.', 'ok');
    log('Select USB or WiFi mode, then click Connect.', '');
    log('GPIO34 = CH1, GPIO35 = CH2. Max 3.3V.', '');
  }

  /* ── Expose ──────────────────────────────────────────────── */
  window.ESP32Controls = {
    updateMeasurements: updateMeasurements,
    updateOverlays:     updateOverlays,
    updateCursorPanel:  updateCursorPanel,
    setAvgProgress:     setAvgProgress,
    syncRunState:       syncRunState,
    log:                log
  };

  document.addEventListener('DOMContentLoaded', init);

}());
