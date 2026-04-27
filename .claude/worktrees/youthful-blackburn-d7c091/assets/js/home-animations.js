/**
 * home-animations.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Canvas animations for index.html only.
 * Never load this on scope.html or signal-generator.html.
 *
 * Draws three things:
 *   1. Hero background — two animated waveform traces
 *   2. Scope card preview — live dual-channel mini scope
 *   3. Signal gen card preview — animated sine wave
 *
 * Also exposes window.EElab77.waveShapes so signal-generator.js
 * can reuse the same wave functions without duplicating code.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Wave shape functions ────────────────────────────────── */
  /*
   * Each function takes:
   *   x  — normalised x position (0..1)
   *   f  — frequency multiplier (number of full cycles across x)
   *   t  — time offset in radians (increments each frame)
   * Returns a normalised y value (0..1), where 0 = top, 1 = bottom.
   */
  var waveShapes = {

    sine: function (x, f, t) {
      return 0.5 - 0.4 * Math.sin(x * Math.PI * 2 * f + t);
    },

    square: function (x, f, t) {
      var phase = (x * f + t / (2 * Math.PI)) % 1;
      return phase < 0.5 ? 0.15 : 0.85;
    },

    triangle: function (x, f, t) {
      var phase = (x * f + t / (2 * Math.PI)) % 1;
      return phase < 0.5
        ? 0.85 - phase * 1.4
        : 0.15 + (phase - 0.5) * 1.4;
    },

    sawtooth: function (x, f, t) {
      var phase = (x * f + t / (2 * Math.PI)) % 1;
      return 0.15 + phase * 0.7;
    }

  };

  /* Expose on window so signal-generator.js can import them */
  window.EElab77 = window.EElab77 || {};
  window.EElab77.waveShapes = waveShapes;


  /* ── Utility: resize canvas to device pixel ratio ────────── */
  function resizeDPR(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w   = canvas.offsetWidth;
    var h   = canvas.offsetHeight;
    canvas.width        = w * dpr;
    canvas.height       = h * dpr;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    return dpr;
  }


  /* ── 1. Hero background canvas ───────────────────────────── */
  function initHero() {
    var canvas = document.getElementById('hero-bg-canvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var dpr;

    function resize() {
      dpr = resizeDPR(canvas);
    }
    window.addEventListener('resize', resize);
    resize();

    function frame(ts) {
      var t = ts * 0.001;
      var W = canvas.width;
      var H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      /* CH1 trace — green */
      ctx.beginPath();
      ctx.strokeStyle = '#00C87A';
      ctx.lineWidth   = 2 * dpr;
      ctx.shadowColor = '#00C87A';
      ctx.shadowBlur  = 12;
      for (var i = 0; i <= W; i++) {
        var y = waveShapes.sine(i / W, 3, t * 1.8) * H;
        if (i === 0) ctx.moveTo(i, y);
        else         ctx.lineTo(i, y);
      }
      ctx.stroke();

      /* CH2 trace — amber, different frequency */
      ctx.beginPath();
      ctx.strokeStyle = '#F5A623';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.shadowColor = '#F5A623';
      ctx.shadowBlur  = 8;
      for (var j = 0; j <= W; j++) {
        var y2 = waveShapes.sine(j / W, 6, t * 2.7) * H;
        if (j === 0) ctx.moveTo(j, y2);
        else         ctx.lineTo(j, y2);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }


  /* ── 2. Scope card preview ───────────────────────────────── */
  function initScopeCard() {
    var canvas = document.getElementById('scope-card-canvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var dpr;

    function resize() { dpr = resizeDPR(canvas); }
    window.addEventListener('resize', resize);
    resize();

    var t = 0;

    function drawGrid(W, H) {
      ctx.strokeStyle = 'rgba(20, 30, 50, 0.9)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      for (var i = 0; i <= 10; i++) {
        ctx.moveTo(i * W / 10, 0);
        ctx.lineTo(i * W / 10, H);
      }
      for (var j = 0; j <= 6; j++) {
        ctx.moveTo(0, j * H / 6);
        ctx.lineTo(W, j * H / 6);
      }
      ctx.stroke();
    }

    function frame() {
      var W = canvas.width;
      var H = canvas.height;

      ctx.fillStyle = '#07080F';
      ctx.fillRect(0, 0, W, H);
      drawGrid(W, H);

      /* CH1 — green sine */
      ctx.beginPath();
      ctx.strokeStyle = '#00C87A';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.shadowColor = '#00C87A';
      ctx.shadowBlur  = 5;
      for (var i = 0; i <= W; i++) {
        var y = waveShapes.sine(i / W, 2.5, t * 1.8) * H * 0.8 + H * 0.1;
        if (i === 0) ctx.moveTo(i, y);
        else         ctx.lineTo(i, y);
      }
      ctx.stroke();

      /* CH2 — amber sine at different frequency */
      ctx.beginPath();
      ctx.strokeStyle = '#F5A623';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.shadowColor = '#F5A623';
      ctx.shadowBlur  = 4;
      for (var j = 0; j <= W; j++) {
        var y2 = waveShapes.sine(j / W, 5, t * 2.9) * H * 0.4 + H * 0.3;
        if (j === 0) ctx.moveTo(j, y2);
        else         ctx.lineTo(j, y2);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      t += 0.022;
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }


  /* ── 3. Signal gen card preview ──────────────────────────── */
  function initSigGenCard() {
    var canvas = document.getElementById('siggen-card-canvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var dpr;

    function resize() { dpr = resizeDPR(canvas); }
    window.addEventListener('resize', resize);
    resize();

    var t = 0;

    function frame() {
      var W = canvas.width;
      var H = canvas.height;

      ctx.fillStyle = '#07080F';
      ctx.fillRect(0, 0, W, H);

      /* Grid */
      ctx.strokeStyle = 'rgba(20, 30, 50, 0.9)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      for (var i = 0; i <= 10; i++) {
        ctx.moveTo(i * W / 10, 0);
        ctx.lineTo(i * W / 10, H);
      }
      for (var j = 0; j <= 6; j++) {
        ctx.moveTo(0, j * H / 6);
        ctx.lineTo(W, j * H / 6);
      }
      ctx.stroke();

      /* Amber sine */
      ctx.beginPath();
      ctx.strokeStyle = '#F5A623';
      ctx.lineWidth   = 2 * dpr;
      ctx.shadowColor = '#F5A623';
      ctx.shadowBlur  = 7;
      for (var k = 0; k <= W; k++) {
        var y = waveShapes.sine(k / W, 3, t * 1.4) * H * 0.8 + H * 0.1;
        if (k === 0) ctx.moveTo(k, y);
        else         ctx.lineTo(k, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      t += 0.018;
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }


  /* ── Init ─────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    initHero();
    initScopeCard();
    initSigGenCard();
  });

}());
