/**
 * esp32-scope-render.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Canvas drawing for the ESP32 oscilloscope.
 * Reads from ESP32Engine every animation frame and draws.
 *
 * Identical in structure to scope-render.js but reads from
 * ESP32Engine instead of EEEngine, and references
 * esp-scope-canvas / esp-fft-canvas element IDs.
 *
 * Depends on: esp32-scope-engine.js
 * Exposes:    window.ESP32Render  { resizeCanvas }
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Canvas references ───────────────────────────────────── */
  var canvas = document.getElementById('esp-scope-canvas');
  var fftCvs = document.getElementById('esp-fft-canvas');
  if (!canvas) return;

  var ctx    = canvas.getContext('2d');
  var fftCtx = fftCvs ? fftCvs.getContext('2d') : null;

  /* ── Resize ──────────────────────────────────────────────── */
  function resizeCanvas() {
    var wrap = document.getElementById('inst-main');
    if (!wrap) return;
    var dpr = window.devicePixelRatio || 1;
    var W   = wrap.clientWidth;
    var H   = wrap.clientHeight;
    var fft = window.ESP32Engine && window.ESP32Engine.state.fftEnabled;

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

  /* ── Sample to Y pixel ───────────────────────────────────── */
  function sampleToY(val, H, chIdx) {
    var eng    = window.ESP32Engine;
    var cfg    = eng.state.ch[chIdx];
    var vdiv   = eng.VDIV_V[cfg.vdivIdx];
    var vRange = vdiv * eng.GRID_Y;
    var midADC = (0.5 + cfg.offsetPct / 100) * eng.ADC_MAX;
    return H * 0.5 -
      ((val - midADC) / (vRange / eng.VREF * eng.ADC_MAX)) * H;
  }

  /* ── Build canvas path ───────────────────────────────────── */
  function buildPath(cx, pts, n, interp) {
    cx.moveTo(pts[0], pts[1]);
    if (interp) {
      for (var i = 1; i < n; i++) {
        var mx = (pts[(i-1)*2]   + pts[i*2])   / 2;
        var my = (pts[(i-1)*2+1] + pts[i*2+1]) / 2;
        cx.quadraticCurveTo(
          pts[(i-1)*2], pts[(i-1)*2+1], mx, my
        );
      }
      cx.lineTo(pts[(n-1)*2], pts[(n-1)*2+1]);
    } else {
      for (var j = 1; j < n; j++) {
        cx.lineTo(pts[j*2], pts[j*2+1]);
      }
    }
  }

  /* ── Draw trace ──────────────────────────────────────────── */
  function drawTrace(samples, W, H, chIdx, colour) {
    var n   = samples.length;
    var pts = new Float32Array(n * 2);

    for (var i = 0; i < n; i++) {
      pts[i*2]   = (i / (n - 1)) * W;
      pts[i*2+1] = sampleToY(samples[i], H, chIdx);
    }

    var interp = window.ESP32Engine.state.interpolate;
    var fill   = window.ESP32Engine.state.fill;

    ctx.save();

    if (fill && chIdx === 0) {
      ctx.beginPath();
      ctx.moveTo(pts[0], H);
      buildPath(ctx, pts, n, interp);
      ctx.lineTo(pts[(n-1)*2], H);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, colour + '20');
      grad.addColorStop(1, colour + '02');
      ctx.fillStyle = grad;
      ctx.fill();
    }

    /* Glow pass */
    ctx.beginPath();
    ctx.strokeStyle = colour + '18';
    ctx.lineWidth   = 8;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    buildPath(ctx, pts, n, interp);
    ctx.stroke();

    /* Main line */
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = colour;
    ctx.shadowBlur  = 5;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    buildPath(ctx, pts, n, interp);
    ctx.stroke();

    ctx.restore();
  }

  /* ── Draw peak envelope ──────────────────────────────────── */
  function drawPeakTrace(pMax, pMin, W, H, colour) {
    var n     = pMax.length;
    var ptsMx = new Float32Array(n * 2);
    var ptsMn = new Float32Array(n * 2);

    for (var i = 0; i < n; i++) {
      ptsMx[i*2]   = (i / (n-1)) * W;
      ptsMx[i*2+1] = sampleToY(pMax[i], H, 0);
      ptsMn[i*2]   = ptsMx[i*2];
      ptsMn[i*2+1] = sampleToY(pMin[i], H, 0);
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ptsMx[0], ptsMx[1]);
    for (var j = 1; j < n; j++) {
      ctx.lineTo(ptsMx[j*2], ptsMx[j*2+1]);
    }
    for (var k = n-1; k >= 0; k--) {
      ctx.lineTo(ptsMn[k*2], ptsMn[k*2+1]);
    }
    ctx.closePath();
    ctx.fillStyle = colour + '10';
    ctx.fill();

    ctx.strokeStyle = colour + '50';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    buildPath(ctx, ptsMx, n, false);
    ctx.stroke();
    ctx.beginPath();
    buildPath(ctx, ptsMn, n, false);
    ctx.stroke();
    ctx.restore();
  }

  /* ── Draw grid ───────────────────────────────────────────── */
  function drawGrid(W, H) {
    var GRID_X = window.ESP32Engine.GRID_X;
    var GRID_Y = window.ESP32Engine.GRID_Y;

    ctx.save();

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

    ctx.strokeStyle = 'rgba(45, 62, 96, 0.5)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H);
    ctx.moveTo(0, H/2); ctx.lineTo(W, H/2);
    ctx.stroke();

    ctx.restore();
  }

  /* ── Draw trigger line ───────────────────────────────────── */
  function drawTrigLine(W, H) {
    var s   = window.ESP32Engine.state;
    if (s.trigMode === 'none') return;

    var y   = sampleToY(
      s.trigLevel * window.ESP32Engine.ADC_MAX,
      H,
      s.trigSrc
    );
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.strokeStyle = 'rgba(245, 166, 35, 0.55)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#F5A623';
    ctx.font      = (9 * dpr) + 'px JetBrains Mono';
    ctx.fillText('T\u25B6', 4, y - 3);
    ctx.restore();
  }

  /* ── Draw cursors ────────────────────────────────────────── */
  function drawCursors(W, H) {
    var s   = window.ESP32Engine.state;
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.font      = (9 * dpr) + 'px JetBrains Mono';

    /* Time cursors — amber */
    [
      { val: s.cursorT1, label: 'T1' },
      { val: s.cursorT2, label: 'T2' }
    ].forEach(function (cur) {
      var x = cur.val * W;
      ctx.strokeStyle = 'rgba(245, 166, 35, 0.75)';
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = '#F5A623';
      ctx.fillText(cur.label, x + 3, 14);
    });

    /* Voltage cursors — cyan */
    [
      { val: s.cursorV1, label: 'V1' },
      { val: s.cursorV2, label: 'V2' }
    ].forEach(function (cur) {
      var y = cur.val * H;
      ctx.strokeStyle = 'rgba(0, 200, 232, 0.75)';
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(W, y);
      ctx.stroke();
      ctx.fillStyle = '#00C8E8';
      ctx.fillText(cur.label, 4, y - 4);
    });

    ctx.restore();

    /* Update cursor panel */
    if (window.ESP32Controls && window.ESP32Controls.updateCursorPanel) {
      var eng    = window.ESP32Engine;
      var tbSec  = eng.TIMEBASE_MS[s.timebaseIdx] / 1000;
      var total  = tbSec * eng.GRID_X;
      var dt     = Math.abs(s.cursorT2 - s.cursorT1) * total;
      var vdiv   = eng.VDIV_V[s.ch[0].vdivIdx];
      var vRange = vdiv * eng.GRID_Y;
      var midV   = (0.5 + s.ch[0].offsetPct / 100) * eng.VREF;
      var v1v    = midV - (s.cursorV1 - 0.5) * vRange;
      var v2v    = midV - (s.cursorV2 - 0.5) * vRange;

      window.ESP32Controls.updateCursorPanel({
        t1: s.cursorT1 * total,
        t2: s.cursorT2 * total,
        dt: dt,
        v1: v1v,
        v2: v2v
      });
    }
  }

  /* ── No signal message ───────────────────────────────────── */
  function drawNoSignal(W, H) {
    var connected =
      window.EEScopeTransport && window.EEScopeTransport.isConnected();
    var dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.fillStyle  = 'rgba(78, 96, 128, 0.3)';
    ctx.font       = (13 * dpr) + 'px JetBrains Mono';
    ctx.textAlign  = 'center';
    ctx.fillText(
      connected ? 'Waiting for trigger...' : 'No device connected',
      W / 2, H / 2
    );
    ctx.restore();
  }

  /* ── Main draw loop ──────────────────────────────────────── */
  function draw() {
    requestAnimationFrame(draw);

    if (!window.ESP32Engine || !window.EEScopeTransport) return;

    var data      = window.ESP32Engine.getDisplayData();
    var s         = data.state;
    var W         = canvas.width;
    var H         = canvas.height;
    var connected = window.EEScopeTransport.isConnected();

    /* Update capture */
    if (connected && s.running) {
      window.ESP32Engine.updateCapture();
    }

    /* Clear / persistence */
    if (s.persistence > 0) {
      ctx.fillStyle = 'rgba(7, 8, 15, ' + (1 - s.persistence) + ')';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#07080F';
      ctx.fillRect(0, 0, W, H);
    }

    drawGrid(W, H);

    /* Traces */
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

    drawTrigLine(W, H);
    if (s.cursorsEnabled) drawCursors(W, H);

    /* Update DOM overlays */
    if (window.ESP32Controls && window.ESP32Controls.updateOverlays) {
      window.ESP32Controls.updateOverlays(
        data.trigState,
        window.ESP32Engine.TIMEBASE_MS[s.timebaseIdx]
      );
    }

    /* FFT panel */
    if (s.fftEnabled && data.frozen1 && window.ESP32FFT) {
      window.ESP32FFT.draw(
        fftCtx, fftCvs, data.frozen1, data.frozen2, s
      );
    }
  }

  /* ── Cursor drag ─────────────────────────────────────────── */
  function setupCursorDrag() {
    var dragging = null;
    var EPS      = 0.018;

    canvas.addEventListener('mousedown', function (e) {
      if (!window.ESP32Engine) return;
      var s = window.ESP32Engine.state;
      if (!s.cursorsEnabled) return;

      var r  = canvas.getBoundingClientRect();
      var mx = (e.clientX - r.left) / r.width;
      var my = (e.clientY - r.top)  / r.height;

      if      (Math.abs(mx - s.cursorT1) < EPS) dragging = 'T1';
      else if (Math.abs(mx - s.cursorT2) < EPS) dragging = 'T2';
      else if (Math.abs(my - s.cursorV1) < EPS) dragging = 'V1';
      else if (Math.abs(my - s.cursorV2) < EPS) dragging = 'V2';
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging || !window.ESP32Engine) return;
      var r  = canvas.getBoundingClientRect();
      var mx = Math.max(0, Math.min(1,
        (e.clientX - r.left) / r.width));
      var my = Math.max(0, Math.min(1,
        (e.clientY - r.top)  / r.height));
      var s  = window.ESP32Engine.state;

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
  window.ESP32Render = {
    resizeCanvas: resizeCanvas
  };

}());
