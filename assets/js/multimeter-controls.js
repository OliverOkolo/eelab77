/**
 * multimeter-controls.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Wires every UI element in multimeter.html to EEDmmEngine
 * and EEDmmSerial. Owns all DOM updates and canvas drawing.
 *
 * Responsibilities:
 *   - Serial connect / disconnect
 *   - Mode button wiring
 *   - Hold button
 *   - Stats reset
 *   - Main DMM display update (reading, unit, colour)
 *   - Min / Max / Avg panel update
 *   - Continuity and diode indicator update
 *   - Secondary reading row update
 *   - Wiring guide panel update per mode
 *   - Strip chart canvas drawing
 *   - Stats strip (bytes/s, frames/s, health)
 *   - Diagnostics modal (checks + serial echo test)
 *   - Sketch modal (copy + download)
 *   - Log output
 *   - Export CSV
 *
 * Exposes window.EEDmmControls so multimeter-engine.js can
 * call back into the DOM without a circular dependency.
 *
 * Depends on:
 *   multimeter-serial.js  (EEDmmSerial)
 *   multimeter-engine.js  (EEDmmEngine)
 *   multimeter-sketch.js  (EELAB_MULTIMETER_SKETCH)
 * Load order: sketch → serial → engine → controls
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Shorthand ───────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  /* ── Mode constants (mirror engine) ─────────────────────── */
  var MODE = {
    DCV: 1, DCA: 2, RES: 3,
    CONT: 4, FREQ: 5, DUTY: 6, DIODE: 7
  };

  /* Mode code → CSS class suffix for colouring the reading */
  var MODE_CSS = {
    1: 'voltage',
    2: 'current',
    3: 'resist',
    4: 'cont',
    5: 'freq',
    6: 'freq',
    7: 'diode'
  };

  /* Mode code → active CSS class on the mode button */
  var MODE_BTN_ACTIVE = {
    1: 'is-active--dcv',
    2: 'is-active--dca',
    3: 'is-active--res',
    4: 'is-active--cont',
    5: 'is-active--freq',
    6: 'is-active--duty',
    7: 'is-active--diode'
  };

  /* ── Logging ─────────────────────────────────────────────── */
  function log(msg, cls) {
    var el = $('dmm-log');
    if (!el) return;
    var line = document.createElement('div');
    line.className  = 'log__line' + (cls ? ' log__line--' + cls : '');
    line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
    el.prepend(line);
    if (el.children.length > 60) el.removeChild(el.lastElementChild);
  }

  /* ── Badge helper ────────────────────────────────────────── */
  function setBadge(id, text, extraClass) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'badge' + (extraClass ? ' ' + extraClass : '');
  }

  /* ── Active mode button ──────────────────────────────────── */
  function setActiveModeBtn(modeCode) {
    var all = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < all.length; i++) {
      /* Strip all is-active-- classes */
      var classes = all[i].className.split(' ').filter(function (c) {
        return c.indexOf('is-active') === -1;
      });
      all[i].className = classes.join(' ');
    }
    var active = $('mode-btn-' + modeCode);
    if (active && MODE_BTN_ACTIVE[modeCode]) {
      active.classList.add(MODE_BTN_ACTIVE[modeCode]);
    }
  }

  /* ── Active range label for a given mode + numeric value ─── */
  function getRangeLabel(modeCode, numeric) {
    if (!window.EEDmmEngine) return '';
    var md = window.EEDmmEngine.getModeData()[modeCode];
    if (!md || !md.ranges) return '';
    var abs = Math.abs(numeric);
    for (var i = 0; i < md.ranges.length; i++) {
      if (abs <= md.ranges[i].max) return md.ranges[i].label;
    }
    return md.ranges[md.ranges.length - 1].label;
  }

  /* ── Update main DMM display ─────────────────────────────── */
  function updateDisplay(state) {
    var readingEl  = $('dmm-reading');
    var unitEl     = $('dmm-unit');
    var modeEl     = $('dmm-mode-label');
    var olEl       = $('dmm-ol');
    var holdBadge  = $('dmm-hold-badge');
    var contInd    = $('cont-indicator');

    if (!readingEl) return;

    /* Mode label + range indicator */
    if (modeEl) {
      var rangeLabel = getRangeLabel(state.mode, state.numericValue);
      modeEl.textContent = rangeLabel
        ? state.displayMode + '  ·  ' + rangeLabel
        : state.displayMode;
    }

    /* Hold badge */
    if (holdBadge) {
      holdBadge.classList.toggle('is-visible', state.hold);
    }

    /* Overrange */
    if (state.overrange) {
      if (olEl) olEl.classList.add('is-visible');
      readingEl.classList.add('is-hidden');
      readingEl.className = 'dmm-reading is-hidden';
    } else {
      if (olEl) olEl.classList.remove('is-visible');
      readingEl.classList.remove('is-hidden');

      /* Set the reading value */
      readingEl.textContent = state.displayValue;

      /* Apply colour class */
      var colourCls = 'dmm-reading--' + (MODE_CSS[state.mode] || 'voltage');
      readingEl.className = 'dmm-reading ' + colourCls;
    }

    /* Unit */
    if (unitEl) unitEl.textContent = state.displayUnit;

    /* Continuity indicator */
    if (contInd) {
      if (state.mode === MODE.CONT) {
        contInd.style.display = 'flex';
        contInd.classList.toggle('is-closed', state.contClosed);
        contInd.classList.toggle('is-open',  !state.contClosed);
        contInd.textContent = state.contClosed ? '\u25CF' : '\u25CB';
      } else {
        contInd.style.display = 'none';
      }
    }

    /* Diode Vf label */
    var diodeVf = $('diode-vf');
    if (diodeVf) {
      if (state.mode === MODE.DIODE && !state.overrange) {
        diodeVf.style.display = 'block';
        diodeVf.innerHTML =
          'Vf = <strong>' + state.displayValue + ' ' + state.displayUnit + '</strong>' +
          (state.diodeFwd ? ' \u2014 Forward biased' : ' \u2014 Open / reverse');
      } else {
        diodeVf.style.display = 'none';
      }
    }

    /* Secondary reading */
    var secLabel = $('detail-label-1');
    var secVal   = $('detail-value-1');
    if (secLabel && secVal) {
      if (state.secondary && state.secondary.label) {
        secLabel.textContent = state.secondary.label;
        secVal.textContent   = state.secondary.value;
        var secRow = $('detail-rows');
        if (secRow) secRow.style.display = 'flex';
      } else {
        var secRow2 = $('detail-rows');
        if (secRow2) secRow2.style.display = 'none';
      }
    }
  }

  /* ── Update min / max / avg panel ────────────────────────── */
  function updateStatPanel() {
    if (!window.EEDmmEngine) return;
    var fmt = window.EEDmmEngine.getFormattedStats();
    var minEl = $('stat-min');
    var maxEl = $('stat-max');
    var avgEl = $('stat-avg');
    if (minEl) minEl.textContent = fmt.min;
    if (maxEl) maxEl.textContent = fmt.max;
    if (avgEl) avgEl.textContent = fmt.avg;
  }

  /* ── Update wiring guide ─────────────────────────────────── */
  function updateWiringGuide(modeCode) {
    var el = $('wiring-content');
    if (!el || !window.EEDmmEngine) return;
    var md = window.EEDmmEngine.getModeData()[modeCode];
    if (md) el.textContent = md.wiring;
  }

  /* ── Strip chart drawing ─────────────────────────────────── */
  var chartCanvas = null;
  var chartCtx    = null;

  function initChart() {
    chartCanvas = $('strip-chart');
    if (!chartCanvas) return;
    chartCtx = chartCanvas.getContext('2d');
    resizeChart();
    window.addEventListener('resize', resizeChart);
  }

  function resizeChart() {
    if (!chartCanvas) return;
    var wrap = chartCanvas.parentElement;
    var dpr  = window.devicePixelRatio || 1;
    chartCanvas.width       = wrap.clientWidth  * dpr;
    chartCanvas.height      = wrap.clientHeight * dpr;
    chartCanvas.style.width  = wrap.clientWidth  + 'px';
    chartCanvas.style.height = wrap.clientHeight + 'px';
  }

  function drawChart(chartBuffer, state) {
    if (!chartCtx || !chartCanvas) return;

    var W = chartCanvas.width;
    var H = chartCanvas.height;
    var dpr = window.devicePixelRatio || 1;

    /* Background */
    chartCtx.fillStyle = '#07080F';
    chartCtx.fillRect(0, 0, W, H);

    /* Grid — 5 horizontal divisions */
    chartCtx.strokeStyle = 'rgba(20, 30, 48, 0.9)';
    chartCtx.lineWidth   = 1;
    chartCtx.beginPath();
    for (var gi = 0; gi <= 5; gi++) {
      var gy = gi * H / 5;
      chartCtx.moveTo(0,  gy);
      chartCtx.lineTo(W, gy);
    }
    /* 10 vertical divisions */
    for (var gj = 0; gj <= 10; gj++) {
      var gx = gj * W / 10;
      chartCtx.moveTo(gx, 0);
      chartCtx.lineTo(gx, H);
    }
    chartCtx.stroke();

    /* Filter to valid (non-null) points */
    var validPoints = [];
    for (var pi = 0; pi < chartBuffer.length; pi++) {
      if (chartBuffer[pi].value !== null) {
        validPoints.push(chartBuffer[pi].value);
      }
    }

    if (validPoints.length < 2) return;

    /* Y scale — find min and max with some padding */
    var dataMin =  Infinity;
    var dataMax = -Infinity;
    for (var vi = 0; vi < validPoints.length; vi++) {
      if (validPoints[vi] < dataMin) dataMin = validPoints[vi];
      if (validPoints[vi] > dataMax) dataMax = validPoints[vi];
    }

    /* Add 10% padding to top and bottom */
    var dataRange = dataMax - dataMin;
    if (dataRange === 0) dataRange = Math.abs(dataMax) * 0.1 || 0.001;
    var yMin = dataMin - dataRange * 0.1;
    var yMax = dataMax + dataRange * 0.1;
    var ySpan = yMax - yMin;

    /* Colour by mode */
    var modeColours = {
      1: '#00C87A', /* DCV green  */
      2: '#F5A623', /* DCA amber  */
      3: '#4E8CFF', /* RES blue   */
      4: '#00C87A', /* CONT green */
      5: '#00C8E8', /* FREQ cyan  */
      6: '#00C8E8', /* DUTY cyan  */
      7: '#F5A623'  /* DIODE amber*/
    };
    var colour = modeColours[state.mode] || '#00C87A';

    /* Time range for x-axis — use actual timestamps, not index */
    var n      = chartBuffer.length;
    var tStart = chartBuffer[0].timestamp;
    var tEnd   = chartBuffer[n - 1].timestamp;
    var tSpan  = Math.max(1, tEnd - tStart); /* ms */

    function xForPoint(idx) {
      var pt = chartBuffer[idx];
      if (pt.value === null) return null;
      return ((pt.timestamp - tStart) / tSpan) * W;
    }

    /* Glow pass */
    chartCtx.beginPath();
    chartCtx.strokeStyle = colour + '18';
    chartCtx.lineWidth   = 6;
    chartCtx.lineJoin    = 'round';
    chartCtx.lineCap     = 'round';

    var firstDrawn = false;
    for (var ci = 0; ci < n; ci++) {
      if (chartBuffer[ci].value === null) { firstDrawn = false; continue; }
      var cx = xForPoint(ci);
      var cy = H - ((chartBuffer[ci].value - yMin) / ySpan) * H;
      cy = Math.max(2, Math.min(H - 2, cy));
      if (!firstDrawn) { chartCtx.moveTo(cx, cy); firstDrawn = true; }
      else             { chartCtx.lineTo(cx, cy); }
    }
    chartCtx.stroke();

    /* Main line pass */
    chartCtx.beginPath();
    chartCtx.strokeStyle = colour;
    chartCtx.lineWidth   = 1.5;
    chartCtx.shadowColor = colour;
    chartCtx.shadowBlur  = 4;
    chartCtx.lineJoin    = 'round';
    chartCtx.lineCap     = 'round';

    firstDrawn = false;
    for (var li = 0; li < n; li++) {
      if (chartBuffer[li].value === null) { firstDrawn = false; continue; }
      var lx = xForPoint(li);
      var ly = H - ((chartBuffer[li].value - yMin) / ySpan) * H;
      ly = Math.max(2, Math.min(H - 2, ly));
      if (!firstDrawn) { chartCtx.moveTo(lx, ly); firstDrawn = true; }
      else             { chartCtx.lineTo(lx, ly); }
    }
    chartCtx.stroke();
    chartCtx.shadowBlur = 0;

    /* Y-axis labels — min, mid, max */
    chartCtx.fillStyle  = 'rgba(78, 96, 128, 0.7)';
    chartCtx.font       = (9 * dpr) + 'px JetBrains Mono';
    chartCtx.textAlign  = 'left';

    var fmt = window.EEDmmEngine ? window.EEDmmEngine.formatValue : null;
    var mode = state.mode;

    function fmtY(v) {
      if (!fmt) return v.toFixed(3);
      var r = fmt(mode, v);
      return r.display + ' ' + r.unit;
    }

    chartCtx.fillText(fmtY(yMax), 4, 14);
    chartCtx.fillText(fmtY((yMin + yMax) / 2), 4, H / 2 + 4);
    chartCtx.fillText(fmtY(yMin), 4, H - 4);

    /* Time span label — actual elapsed time from first to last sample */
    var spanSec = (tSpan / 1000).toFixed(1);
    chartCtx.textAlign = 'right';
    chartCtx.fillText(spanSec + ' s', W - 4, 14);

    /* Update the chart-timespan element if present */
    var tsEl = document.getElementById('chart-timespan');
    if (tsEl) tsEl.textContent = spanSec + ' s';
  }

  /* ── Main update callback (called by engine) ─────────────── */
  function onUpdate(state, stats, chartBuffer) {
    updateDisplay(state);
    updateStatPanel();
    drawChart(chartBuffer, state);
  }

  /* ── Stats strip (1-second interval) ────────────────────── */
  function updateStatsStrip() {
    var connected = window.EEDmmSerial && window.EEDmmSerial.isConnected();
    var ids = ['dmm-st-bps', 'dmm-st-fps', 'dmm-st-err', 'dmm-st-health'];

    if (!connected) {
      ids.forEach(function (id) {
        var el = $(id);
        if (el) { el.textContent = '\u2014'; el.className = 'stat-cell__value'; }
      });
      return;
    }

    var diag    = window.EEDmmSerial.getDiag();
    var elapsed = Math.max(1, (Date.now() - diag.connectTime) / 1000);
    var bps     = diag.bytesWindow;
    var fps     = diag.framesWindow;
    diag.bytesWindow  = 0;
    diag.framesWindow = 0;

    var health = diag.bytesTotal > 0
      ? Math.min(100, Math.round(diag.framesTotal / (diag.bytesTotal / 6) * 100))
      : 0;

    function setStat(id, value, cls) {
      var el = $(id);
      if (!el) return;
      el.textContent = value;
      el.className   = 'stat-cell__value stat-cell__value--' + cls;
    }

    setStat('dmm-st-bps', bps, bps > 0 ? 'ok' : 'err');
    setStat('dmm-st-fps', fps, fps > 0 ? 'ok' : 'warn');
    setStat('dmm-st-err', diag.syncErrors,
      diag.syncErrors === 0 ? 'ok' : diag.syncErrors < 10 ? 'warn' : 'err');
    setStat('dmm-st-health', health + '%',
      health >= 80 ? 'ok' : health >= 40 ? 'warn' : 'err');

    /* Watchdog */
    var since = Date.now() - diag.lastFrameTime;
    if (connected && diag.lastFrameTime > 0 && since > 5000) {
      log('\u26A0 No frames for ' + Math.round(since / 1000) + 's \u2014 check mode/wiring', 'warn');
      diag.lastFrameTime = Date.now();
    }
  }

  /* ── Export CSV ──────────────────────────────────────────── */
  function exportCSV() {
    if (!window.EEDmmEngine) return;
    var buf = window.EEDmmEngine.getChart();
    if (!buf || buf.length === 0) { log('No data to export', 'warn'); return; }

    var state = window.EEDmmEngine.getState();
    var lines = ['timestamp_ms,value,unit,mode'];

    for (var i = 0; i < buf.length; i++) {
      var pt = buf[i];
      if (pt.value === null) continue;
      var fmt = window.EEDmmEngine.formatValue(state.mode, pt.value);
      lines.push(pt.timestamp + ',' + pt.value + ',' + fmt.unit + ',' + state.displayMode);
    }

    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'eelab77_dmm_' + Date.now() + '.csv';
    a.click();
    log('Exported CSV (' + (lines.length - 1) + ' readings)', 'ok');
  }

  /* ── Diagnostics checks ──────────────────────────────────── */
  function runAllChecks() {
    var c = $('dmm-diag-checks');
    if (!c) return;
    c.innerHTML = '';

    var connected = window.EEDmmSerial && window.EEDmmSerial.isConnected();
    var diag      = connected ? window.EEDmmSerial.getDiag() : null;

    /* Web Serial */
    window.EELab.addCheck(c,
      navigator.serial ? '\u2713' : '\u2717',
      navigator.serial ? 'pass'   : 'fail',
      navigator.serial ? 'Web Serial API supported' : 'Web Serial NOT supported',
      navigator.serial ? 'Chrome or Edge detected.' : 'Switch to Chrome or Edge.'
    );

    /* Connection */
    if (connected) {
      window.EELab.addCheck(c, '\u2713', 'pass',
        'Port open @ ' + ($('dmm-baud-select') ? $('dmm-baud-select').value : '?') + ' baud');
    } else {
      window.EELab.addCheck(c, '\u2717', 'fail', 'Not connected', 'Click Connect.');
    }

    if (connected && diag) {
      /* Data flow */
      var since = Date.now() - diag.lastFrameTime;
      if (diag.framesTotal === 0) {
        window.EELab.addCheck(c, '\u2717', 'fail',
          'No frames received',
          'Check baud rate and sketch. Firmware sends 10 frames/sec.');
      } else if (since > 5000) {
        window.EELab.addCheck(c, '\u26A0', 'warn',
          'Frames stopped ' + Math.round(since / 1000) + 's ago',
          'Arduino may have reset. Try disconnecting and reconnecting.');
      } else {
        window.EELab.addCheck(c, '\u2713', 'pass',
          diag.framesTotal.toLocaleString() + ' frames received',
          'Data is flowing from the Arduino.');
      }

      /* Frame health — 6 bytes per frame */
      var health = diag.bytesTotal > 0
        ? Math.min(100, Math.round(diag.framesTotal / (diag.bytesTotal / 6) * 100))
        : 0;

      window.EELab.addCheck(c,
        health >= 80 ? '\u2713' : health >= 40 ? '\u26A0' : '\u2717',
        health >= 80 ? 'pass'   : health >= 40 ? 'warn'   : 'fail',
        'Frame health ' + health + '%',
        health >= 80 ? 'Protocol sync is good.'
          : health >= 40 ? 'Partial sync \u2014 try a lower baud rate.'
          : 'Baud rate mismatch \u2014 change to match the sketch.'
      );

      /* Sync errors */
      window.EELab.addCheck(c,
        diag.syncErrors === 0 ? '\u2713' : diag.syncErrors < 10 ? '\u26A0' : '\u2717',
        diag.syncErrors === 0 ? 'pass'   : diag.syncErrors < 10 ? 'warn'   : 'fail',
        diag.syncErrors + ' sync errors',
        diag.syncErrors === 0 ? 'Frame boundaries are clean.'
          : 'Try a lower baud rate or disconnect and reconnect.'
      );
    }
  }

  /* ── Serial echo test ────────────────────────────────────── */
  var testLines = [];

  function runSerialTest() {
    var outEl = $('dmm-serial-test-out');
    if (!outEl) return;

    if (!window.EEDmmSerial || !window.EEDmmSerial.isConnected()) {
      outEl.textContent = '\u2717 Not connected. Connect your Arduino first.';
      outEl.className   = 'serial-test-out';
      return;
    }

    outEl.className   = 'serial-test-out';
    outEl.textContent = 'Sending T command to Arduino...\n';
    testLines         = [];

    window.EEDmmSerial.onRawText = function (text) {
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

    var ok = window.EEDmmSerial.runSerialTest();

    if (!ok) {
      clearInterval(iv);
      outEl.textContent = '\u2717 Not connected.';
      return;
    }

    setTimeout(function () {
      clearInterval(iv);
      window.EEDmmSerial.onRawText = null;
      outEl.textContent = testLines.length > 0
        ? testLines.join('\n')
        : '(no response \u2014 verify baud rate matches sketch)';
      testLines = [];
      log('Serial test complete \u2014 resuming', 'ok');
      runAllChecks();
    }, 3200);
  }

  /* ── Serial status handler ───────────────────────────────── */
  function handleStatus(event, detail) {
    switch (event) {

      case 'no-serial':
        var warn = $('dmm-no-serial-warn');
        if (warn) warn.style.display = 'block';
        log('Web Serial not supported \u2014 use Chrome or Edge.', 'err');
        break;

      case 'connected':
        var ov = $('dmm-connect-overlay');
        if (ov) ov.classList.add('is-hidden');
        setBadge('dmm-conn-badge', 'CONNECTED', 'badge--live');
        log('Port open @ ' + detail + ' baud', 'ok');
        break;

      case 'ready':
        log('Streaming \u2014 DC Voltage mode', 'ok');
        setActiveModeBtn(MODE.DCV);
        updateWiringGuide(MODE.DCV);
        break;

      case 'disconnected':
        var ov2 = $('dmm-connect-overlay');
        if (ov2) ov2.classList.remove('is-hidden');
        setBadge('dmm-conn-badge', 'DISCONNECTED', '');
        log('Disconnected', 'warn');
        break;

      case 'connect-error':
        log('Connect failed: ' + detail, 'err');
        break;

      case 'read-error':
        log('Read error: ' + detail, 'err');
        break;
    }
  }

  /* ── Connect / Disconnect ────────────────────────────────── */
  function connect() {
    var baud = parseInt($('dmm-baud-select') ? $('dmm-baud-select').value : '115200');
    window.EEDmmSerial.connect(baud);
  }

  function disconnect() {
    window.EEDmmSerial.disconnect();
  }

  /* ── Sync baud selectors ─────────────────────────────────── */
  function wireBaudSelectors() {
    var ids = ['dmm-baud-select', 'dmm-overlay-baud-select'];
    ids.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function (e) {
        ids.forEach(function (oid) {
          var o = $(oid);
          if (o) o.value = e.target.value;
        });
        log('Baud \u2192 ' + e.target.value);
      });
    });
  }

  /* ── Wire mode buttons ───────────────────────────────────── */
  function wireModeButtons() {
    var modes = [
      { code: MODE.DCV,   id: 'mode-btn-1' },
      { code: MODE.DCA,   id: 'mode-btn-2' },
      { code: MODE.RES,   id: 'mode-btn-3' },
      { code: MODE.CONT,  id: 'mode-btn-4' },
      { code: MODE.FREQ,  id: 'mode-btn-5' },
      { code: MODE.DUTY,  id: 'mode-btn-6' },
      { code: MODE.DIODE, id: 'mode-btn-7' }
    ];

    modes.forEach(function (m) {
      var btn = $(m.id);
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (!window.EEDmmEngine) return;
        window.EEDmmEngine.setMode(m.code);
        setActiveModeBtn(m.code);
        updateWiringGuide(m.code);

        /* Clear stats and chart on mode change */
        window.EEDmmEngine.resetStats();
        window.EEDmmEngine.resetChart();
        updateStatPanel();

        log('Mode \u2192 ' + window.EEDmmEngine.getModeData()[m.code].label);
      });
    });
  }

  /* ── Wire all controls ───────────────────────────────────── */
  function init() {

    /* Register serial status handler */
    if (window.EEDmmSerial) {
      window.EEDmmSerial.onStatus = handleStatus;
    }

    /* Register engine callback */
    window.EEDmmControls = { onUpdate: onUpdate };

    /* Baud selectors */
    wireBaudSelectors();

    /* Connect / Disconnect */
    var btnCo = $('dmm-btn-connect-overlay');
    var btnC  = $('dmm-btn-connect');
    var btnD  = $('dmm-btn-disconnect');
    if (btnCo) btnCo.addEventListener('click', connect);
    if (btnC)  btnC.addEventListener('click',  connect);
    if (btnD)  btnD.addEventListener('click',  disconnect);

    /* Mode buttons */
    wireModeButtons();

    /* Hold button */
    var btnHold = $('dmm-btn-hold');
    if (btnHold) {
      btnHold.addEventListener('click', function () {
        if (!window.EEDmmEngine) return;
        var st   = window.EEDmmEngine.getState();
        var held = !st.hold;
        window.EEDmmEngine.setHold(held);
        btnHold.classList.toggle('is-active', held);
        btnHold.textContent = held ? 'Hold ON' : 'Hold';
        log(held ? 'Hold ON' : 'Hold OFF');
      });
    }

    /* Reset stats */
    var btnReset = $('dmm-btn-reset');
    if (btnReset) {
      btnReset.addEventListener('click', function () {
        if (!window.EEDmmEngine) return;
        window.EEDmmEngine.resetStats();
        window.EEDmmEngine.resetChart();
        updateStatPanel();
        log('Statistics reset');
      });
    }

    /* Export CSV */
    var btnCSV = $('dmm-btn-csv');
    if (btnCSV) btnCSV.addEventListener('click', exportCSV);

    /* Sketch modal */
    var btnSketch = $('dmm-btn-sketch');
    if (btnSketch) {
      btnSketch.addEventListener('click', function () {
        var pre = $('dmm-sketch-text');
        if (pre) pre.textContent = window.EELAB_MULTIMETER_SKETCH || '';
        var modal = $('dmm-sketch-modal-backdrop');
        if (modal) modal.classList.add('is-open');
      });
    }

    var btnModalClose = $('dmm-modal-close');
    if (btnModalClose) {
      btnModalClose.addEventListener('click', function () {
        var modal = $('dmm-sketch-modal-backdrop');
        if (modal) modal.classList.remove('is-open');
      });
    }

    var btnCopySketch = $('dmm-btn-copy-sketch');
    if (btnCopySketch) {
      btnCopySketch.addEventListener('click', function () {
        navigator.clipboard.writeText(window.EELAB_MULTIMETER_SKETCH || '');
        btnCopySketch.textContent = 'Copied!';
        setTimeout(function () {
          btnCopySketch.textContent = 'Copy';
        }, 2000);
      });
    }

    var btnDLSketch = $('dmm-btn-dl-sketch');
    if (btnDLSketch) {
      btnDLSketch.addEventListener('click', function () {
        var blob = new Blob(
          [window.EELAB_MULTIMETER_SKETCH || ''],
          { type: 'text/plain' }
        );
        var a = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'eelab77_multimeter.ino';
        a.click();
      });
    }

    /* Diagnostics modal */
    var btnDiag = $('dmm-btn-diag');
    if (btnDiag) {
      btnDiag.addEventListener('click', function () {
        var modal = $('dmm-diag-modal-backdrop');
        if (modal) modal.classList.add('is-open');
        runAllChecks();
      });
    }

    var btnDiagClose = $('dmm-diag-close');
    if (btnDiagClose) {
      btnDiagClose.addEventListener('click', function () {
        var modal = $('dmm-diag-modal-backdrop');
        if (modal) modal.classList.remove('is-open');
      });
    }

    var btnRunChecks = $('dmm-btn-run-checks');
    if (btnRunChecks) btnRunChecks.addEventListener('click', runAllChecks);

    var btnTest = $('dmm-btn-test');
    if (btnTest) btnTest.addEventListener('click', runSerialTest);

    var btnClearTest = $('dmm-btn-clear-test');
    if (btnClearTest) {
      btnClearTest.addEventListener('click', function () {
        var el = $('dmm-serial-test-out');
        if (!el) return;
        el.textContent = 'Output will appear here after running the test...';
        el.className   = 'serial-test-out is-empty';
      });
    }

    /* Init chart canvas */
    initChart();

    /* Stats strip — 1-second interval */
    setInterval(updateStatsStrip, 1000);

    /* Initial UI state */
    setActiveModeBtn(MODE.DCV);
    updateWiringGuide(MODE.DCV);

    /* Startup log */
    log('EElab77 Multimeter v1.0 ready.', 'ok');
    log('Connect your Arduino to begin.', '');
    log('Default mode: DC Voltage.', '');
  }

  /* ── Expose ──────────────────────────────────────────────── */
  window.EEDmmControls = {
    onUpdate: onUpdate,
    log:      log
  };

  document.addEventListener('DOMContentLoaded', init);

}());
