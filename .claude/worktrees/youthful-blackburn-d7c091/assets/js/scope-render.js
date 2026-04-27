/**
 * scope-render.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Canvas drawing for the oscilloscope.
 * Reads display data from EEEngine every animation frame
 * and draws it. Never writes to EEEngine or the DOM.
 *
 * Draws:
 *   - Background grid (minor + major divisions + crosshairs)
 *   - CH1 waveform trace (green)
 *   - CH2 waveform trace (amber)
 *   - Peak detect envelope (shaded band)
 *   - Trigger level dashed line
 *   - Cursor lines (T1, T2, V1, V2)
 *   - "No signal" message when no data available
 *
 * Also handles:
 *   - Canvas resize (including DPR scaling)
 *   - FFT canvas resize
 *   - Cursor drag via mouse events
 *   - Persistence (phosphor decay effect)
 *
 * Depends on: scope-engine.js
 * Exposes:    window.EERender  { resizeCanvas }
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Canvas references ───────────────────────────────────── */
  var canvas = document.getElementById('scope-canvas');
  var fftCvs = document.getElementById('fft-canvas');

  if (!canvas) return; /* Guard — don't run outside scope.html */

  var ctx    = canvas.getContext('2d');
  var fftCtx = fftCvs ? fftCvs.getContext('2d') : null;

  /* ── Canvas resize ───────────────────────────────────────── */
  /*
   * Always scale canvas buffer to devicePixelRatio so lines are
   * sharp on HiDPI screens. CSS width/height stay at CSS pixels.
   * When FFT is active the scope canvas shrinks to 60% height
   * and the FFT canvas fills the remaining 40%.
   */
  function resizeCanvas() {
    var wrap = document.getElementById('inst-main');
    if (!wrap) return;

    var dpr  = window.devicePixelRatio || 1;
    var W    = wrap.clientWidth;
    var H    = wrap.clientHeight;
    var fft  = window.EEEngine && window.EEEngine.state.fftEnabled;

    if (fft && fftCvs) {
      canvas.style.height = '60%';
      canvas.width        = W * dpr;
      canvas.height       = Math.round(H * 0.6) * dpr;
      canvas.style.width  = W + 'px';

      fftCvs.style.display = 'block';
      fftCvs.style.height  = '40%';
      fftCvs.width         = W * dpr;
      fftCvs.height        = Math.round(H * 0.4) * dpr;
      fftCvs.style.width   = W + 'px';
    } else {
      canvas.style.height = '100%';
      canvas.width        = W * dpr;
      canvas.height       = H * dpr;
      canvas.style.width  = W + 'px';
      if (fftCvs) fftCvs.style.display = 'none';
    }
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  /* ── Value to Y pixel ────────────────────────────────────── */
  /*
   * Converts a raw ADC sample value to a canvas Y coordinate
   * for a given channel. Respects V/div and vertical offset.
   */
  function sampleToY(val, H, chIdx) {
    var eng  = window.EEEngine;
    var cfg  = eng.state.ch[chIdx];
    var vdiv = eng.VDIV_V[cfg.vdivIdx];

    /* Total voltage range shown on screen */
    var vRange = vdiv * eng.GRID_Y;

    /* ADC value at the vertical centre of the screen */
    var midADC = (0.5 + cfg.offsetPct / 100) * eng.ADC_MAX;

    return H * 0.5 - ((val - midADC) / (vRange / eng.VREF * eng.ADC_MAX)) * H;
  }

  /* ── Build canvas path from sample array ─────────────────── */
  /*
   * Moves through the pts Float32Array and builds a canvas path.
   * interp = true uses quadratic curves for a smooth trace.
   * interp = false uses straight line segments (crisp, digital look).
   */
  function buildPath(cx, pts, n, interp) {
    cx.moveTo(pts[0], pts[1]);

    if (interp) {
      for (var i = 1; i < n; i++) {
        var mx = (pts[(i - 1) * 2]     + pts[i * 2])     / 2;
        var my = (pts[(i - 1) * 2 + 1] + pts[i * 2 + 1]) / 2;
        cx.quadraticCurveTo(
          pts[(i - 1) * 2], pts[(i - 1) * 2 + 1],
          mx, my
        );
      }
      cx.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
    } else {
      for (var j = 1; j < n; j++) {
        cx.lineTo(pts[j * 2], pts[j * 2 + 1]);
      }
    }
  }

  /* ── Draw waveform trace ─────────────────────────────────── */
  /*
   * Draws a single channel trace with an optional fill and a
   * two-pass glow effect (wide dim stroke + narrow bright stroke).
   */
  function drawTrace(samples, W, H, chIdx, colour) {
    var n   = samples.length;
    var pts = new Float32Array(n * 2);

    for (var i = 0; i < n; i++) {
      pts[i * 2]     = (i / (n - 1)) * W;
      pts[i * 2 + 1] = sampleToY(samples[i], H, chIdx);
    }

    var interp = window.EEEngine.state.interpolate;
    var fill   = window.EEEngine.state.fill;

    ctx.save();

    /* Optional fill — CH1 only to avoid visual clutter */
    if (fill && chIdx === 0) {
      ctx.beginPath();
      ctx.moveTo(pts[0], H);
      buildPath(ctx, pts, n, interp);
      ctx.lineTo(pts[(n - 1) * 2], H);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, colour + '20');
      grad.addColorStop(1, colour + '02');
      ctx.fillStyle = grad;
      ctx.fill();
    }

    /* Glow pass — wide, very transparent */
    ctx.beginPath();
    ctx.strokeStyle = colour + '18';
    ctx.lineWidth   = 8;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    buildPath(ctx, pts, n, interp);
    ctx.stroke();

    /* Main trace */
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.shadowColor = colour;
    ctx.shadowBlur  = 5;
    buildPath(ctx, pts, n, interp);
    ctx.stroke();

    ctx.restore();
  }

  /* ── Draw peak detect envelope ───────────────────────────── */
  /*
   * Draws a shaded band between the element-wise maximum and
   * minimum of all captures, then draws the current capture
   * on top as a bright trace.
   */
  function drawPeakTrace(pMax, pMin, W, H, colour) {
    var n    = pMax.length;
    var ptsMx = new Float32Array(n * 2);
    var ptsMn = new Float32Array(n * 2);

    for (var i = 0; i < n; i++) {
      ptsMx[i * 2]     = (i / (n - 1)) * W;
      ptsMx[i * 2 + 1] = sampleToY(pMax[i], H, 0);
      ptsMn[i * 2]     = ptsMx[i * 2];
      ptsMn[i * 2 + 1] = sampleToY(pMin[i], H, 0);
    }

    ctx.save();

    /* Shaded fill between min and max */
    ctx.beginPath();
    ctx.moveTo(ptsMx[0], ptsMx[1]);
    for (var j = 1; j < n; j++) ctx.lineTo(ptsMx[j * 2], ptsMx[j * 2 + 1]);
    for (var k = n - 1; k >= 0; k--) ctx.lineTo(ptsMn[k * 2], ptsMn[k * 2 + 1]);
    ctx.closePath();
    ctx.fillStyle = colour + '10';
    ctx.fill();

    /* Envelope outline lines */
    ctx.strokeStyle = colour + '50';
    ctx.lineWidth   = 1;
    ctx.beginPath(); buildPath(ctx, ptsMx, n, false); ctx.stroke();
    ctx.beginPath(); buildPath(ctx, ptsMn, n, false); ctx.stroke();

    ctx.restore();
  }

  /* ── Draw grid ───────────────────────────────────────────── */
  function drawGrid(W, H) {
    var GRID_X = window.EEEngine.GRID_X;
    var GRID_Y = window.EEEngine.GRID_Y;

    ctx.save();

    /* Minor divisions (5 per major division) */
    ctx.strokeStyle = 'rgba(18, 26, 44, 0.9)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (var i = 0; i <= GRID_X * 5; i++) {
      ctx.moveTo(i * W / (GRID_X * 5), 0);
      ctx.lineTo(i * W / (GRID_X * 5), H);
    }
    for (var j = 0; j <= GRID_Y * 5; j++) {
      ctx.moveTo(0, j * H / (GRID_Y * 5));
      ctx.lineTo(W, j * H / (GRID_Y * 5));
    }
    ctx.stroke();

    /* Major divisions */
    ctx.strokeStyle = 'rgba(30, 42, 68, 0.75)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (var mi = 0; mi <= GRID_X; mi++) {
      ctx.moveTo(mi * W / GRID_X, 0);
      ctx.lineTo(mi * W / GRID_X, H);
    }
    for (var mj = 0; mj <= GRID_Y; mj++) {
      ctx.moveTo(0, mj * H / GRID_Y);
      ctx.lineTo(W, mj * H / GRID_Y);
    }
    ctx.stroke();

    /* Centre crosshairs — slightly brighter */
    ctx.strokeStyle = 'rgba(45, 62, 96, 0.5)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();

    ctx.restore();
  }

  /* ── Draw trigger level line ─────────────────────────────── */
  function drawTrigLine(W, H) {
    var s = window.EEEngine.state;
    if (s.trigMode === 'none') return;

    var y   = sampleToY(s.trigLevel * window.EEEngine.ADC_MAX, H, s.trigSrc);
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.strokeStyle = 'rgba(245, 166, 35, 0.55)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = '#F5A623';
    ctx.font      = (9 * dpr) + 'px JetBrains Mono';
    ctx.fillText('T\u25B6', 4, y - 3);
    ctx.restore();
  }

  /* ── Draw cursors ────────────────────────────────────────── */
  function drawCursors(W, H) {
    var s   = window.EEEngine.state;
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.font      = (9 * dpr) + 'px JetBrains Mono';

    /* Time cursors — amber */
    var tCursors = [
      { val: s.cursorT1, label: 'T1' },
      { val: s.cursorT2, label: 'T2' }
    ];

    for (var t = 0; t < tCursors.length; t++) {
      var tx = tCursors[t].val * W;
      ctx.strokeStyle = 'rgba(245, 166, 35, 0.75)';
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, H);
      ctx.stroke();
      ctx.fillStyle = '#F5A623';
      ctx.fillText(tCursors[t].label, tx + 3, 14);
    }

    /* Voltage cursors — cyan */
    var vCursors = [
      { val: s.cursorV1, label: 'V1' },
      { val: s.cursorV2, label: 'V2' }
    ];

    for (var v = 0; v < vCursors.length; v++) {
      var vy = vCursors[v].val * H;
      ctx.strokeStyle = 'rgba(0, 200, 232, 0.75)';
      ctx.beginPath();
      ctx.moveTo(0, vy);
      ctx.lineTo(W, vy);
      ctx.stroke();
      ctx.fillStyle = '#00C8E8';
      ctx.fillText(vCursors[v].label, 4, vy - 4);
    }

    ctx.restore();

    /* Push cursor readout values to the controls module */
    if (window.EEControls && window.EEControls.updateCursorPanel) {
      var eng     = window.EEEngine;
      var tbSec   = eng.TIMEBASE_MS[s.timebaseIdx] / 1000;
      var total   = tbSec * eng.GRID_X;
      var dt      = Math.abs(s.cursorT2 - s.cursorT1) * total;
      var vdiv    = eng.VDIV_V[s.ch[0].vdivIdx];
      var vRange  = vdiv * eng.GRID_Y;
      var midV    = (0.5 + s.ch[0].offsetPct / 100) * eng.VREF;
      var v1volts = midV - (s.cursorV1 - 0.5) * vRange;
      var v2volts = midV - (s.cursorV2 - 0.5) * vRange;

      window.EEControls.updateCursorPanel({
        t1: s.cursorT1 * total,
        t2: s.cursorT2 * total,
        dt: dt,
        v1: v1volts,
        v2: v2volts
      });
    }
  }

  /* ── Draw no-signal message ──────────────────────────────── */
  function drawNoSignal(W, H) {
    var connected = window.EESerial && window.EESerial.isConnected();
    var dpr       = window.devicePixelRatio || 1;

    ctx.save();
    ctx.fillStyle  = 'rgba(78, 96, 128, 0.3)';
    ctx.font       = (13 * dpr) + 'px JetBrains Mono';
    ctx.textAlign  = 'center';

    var msg = connected
      ? 'Waiting for trigger...'
      : 'No device connected';

    ctx.fillText(msg, W / 2, H / 2);
    ctx.restore();
  }

  /* ── Main animation loop ─────────────────────────────────── */
  function draw() {
    requestAnimationFrame(draw);

    if (!window.EEEngine || !window.EESerial) return;

    var data      = window.EEEngine.getDisplayData();
    var s         = data.state;
    var W         = canvas.width;
    var H         = canvas.height;
    var connected = window.EESerial.isConnected();

    /* ── Clear / persistence ── */
    if (s.persistence > 0) {
      ctx.fillStyle = 'rgba(7, 8, 15, ' + (1 - s.persistence) + ')';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#07080F';
      ctx.fillRect(0, 0, W, H);
    }

    /* ── Grid ── */
    drawGrid(W, H);

    /* ── Trigger capture update ── */
    if (connected && s.running) {
      window.EEEngine.updateCapture();
    }

    /* ── Traces ── */
    if (data.frozen1) {
      if (s.acqMode === 'peak' && data.peakMax && data.peakMin) {
        drawPeakTrace(data.peakMax, data.peakMin, W, H, '#00C87A');
      }
      drawTrace(data.frozen1, W, H, 0, '#00C87A');
    } else {
      drawNoSignal(W, H);
    }

    if (data.frozen2 && s.ch[1].enabled) {
      drawTrace(data.frozen2, W, H, 1, '#F5A623');
    }

    /* ── Overlays ── */
    drawTrigLine(W, H);
    if (s.cursorsEnabled) drawCursors(W, H);

    /* ── Update DOM overlay text ── */
    if (window.EEControls && window.EEControls.updateOverlays) {
      window.EEControls.updateOverlays(
        data.trigState,
        window.EEEngine.TIMEBASE_MS[s.timebaseIdx]
      );
    }

    /* ── FFT panel ── */
    if (s.fftEnabled && data.frozen1 && window.EEFFT) {
      window.EEFFT.draw(fftCtx, fftCvs, data.frozen1, data.frozen2, s);
    }
  }

  /* ── Cursor drag handling ────────────────────────────────── */
  /*
   * Detects which cursor line (T1, T2, V1, V2) is near the mouse
   * on mousedown and drags it on mousemove.
   * Epsilon is expressed as a fraction of canvas CSS width/height.
   */
  function setupCursorDrag() {
    var dragging = null;
    var EPS      = 0.018;

    canvas.addEventListener('mousedown', function (e) {
      if (!window.EEEngine) return;
      var s = window.EEEngine.state;
      if (!s.cursorsEnabled) return;

      var rect = canvas.getBoundingClientRect();
      var mx   = (e.clientX - rect.left)  / rect.width;
      var my   = (e.clientY - rect.top)   / rect.height;

      if      (Math.abs(mx - s.cursorT1) < EPS) dragging = 'T1';
      else if (Math.abs(mx - s.cursorT2) < EPS) dragging = 'T2';
      else if (Math.abs(my - s.cursorV1) < EPS) dragging = 'V1';
      else if (Math.abs(my - s.cursorV2) < EPS) dragging = 'V2';
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging || !window.EEEngine) return;
      var rect = canvas.getBoundingClientRect();
      var mx   = Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width));
      var my   = Math.max(0, Math.min(1, (e.clientY - rect.top)   / rect.height));
      var s    = window.EEEngine.state;

      if      (dragging === 'T1') s.cursorT1 = mx;
      else if (dragging === 'T2') s.cursorT2 = mx;
      else if (dragging === 'V1') s.cursorV1 = my;
      else if (dragging === 'V2') s.cursorV2 = my;
    });

    window.addEventListener('mouseup', function () {
      dragging = null;
    });
  }

  /* ── Init ─────────────────────────────────────────────────── */
  setupCursorDrag();
  requestAnimationFrame(draw);

  /* ── Expose ──────────────────────────────────────────────── */
  window.EERender = {
    resizeCanvas: resizeCanvas
  };

}());
