/**
 * scope-fft.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * FFT computation and frequency spectrum drawing.
 * Only active when the user enables the FFT panel.
 *
 * Implements a Cooley-Tukey radix-2 in-place FFT with a
 * Hann window applied before the transform to reduce
 * spectral leakage. Output is displayed in dBV.
 *
 * Depends on: scope-engine.js (for sampleRate)
 * Exposes:    window.EEFFT  { draw, computeFFT }
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── FFT computation ─────────────────────────────────────── */
  /*
   * Takes a Float32Array of ADC samples and returns:
   *   mag       — Float32Array of magnitude values in dBV (N/2 bins)
   *   freqStep  — Hz per bin
   *
   * The signal is:
   *   1. Zero-padded to the next power of 2 (max 4096)
   *   2. Windowed with a Hann function
   *   3. Converted from ADC counts to volts
   *   4. Transformed in place
   *   5. Converted to magnitude in dBV
   */
  function computeFFT(signal, sampleRate) {
    /* Next power of 2, capped at 4096 */
    var N = 1;
    while (N < signal.length) N <<= 1;
    N = Math.min(N, 4096);

    var re  = new Float32Array(N);
    var im  = new Float32Array(N);
    var len = Math.min(signal.length, N);

    var VREF    = window.EEEngine ? window.EEEngine.VREF    : 5.0;
    var ADC_MAX = window.EEEngine ? window.EEEngine.ADC_MAX : 1023;

    /* Apply Hann window and convert to volts */
    for (var i = 0; i < len; i++) {
      var w  = 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)));
      re[i]  = (signal[i] / ADC_MAX * VREF) * w;
    }
    /* Remaining bins stay at zero (zero padding) */

    /* Bit-reversal permutation */
    for (var bi = 1, bj = 0; bi < N; bi++) {
      var bit = N >> 1;
      for (; bj & bit; bit >>= 1) bj ^= bit;
      bj ^= bit;
      if (bi < bj) {
        var tmpR = re[bi]; re[bi] = re[bj]; re[bj] = tmpR;
        var tmpI = im[bi]; im[bi] = im[bj]; im[bj] = tmpI;
      }
    }

    /* Cooley-Tukey butterfly */
    for (var len2 = 2; len2 <= N; len2 <<= 1) {
      var ang = -2 * Math.PI / len2;
      var wR  = Math.cos(ang);
      var wI  = Math.sin(ang);

      for (var ii = 0; ii < N; ii += len2) {
        var cR = 1;
        var cI = 0;

        for (var jj = 0; jj < len2 / 2; jj++) {
          var uR = re[ii + jj];
          var uI = im[ii + jj];
          var vR = re[ii + jj + len2 / 2] * cR - im[ii + jj + len2 / 2] * cI;
          var vI = re[ii + jj + len2 / 2] * cI + im[ii + jj + len2 / 2] * cR;

          re[ii + jj]           = uR + vR;
          im[ii + jj]           = uI + vI;
          re[ii + jj + len2/2]  = uR - vR;
          im[ii + jj + len2/2]  = uI - vI;

          var nR = cR * wR - cI * wI;
          cI     = cR * wI + cI * wR;
          cR     = nR;
        }
      }
    }

    /* Convert to magnitude in dBV (first half only — second half is mirror) */
    var mag = new Float32Array(N / 2);
    for (var mi = 0; mi < N / 2; mi++) {
      var m  = Math.sqrt(re[mi] * re[mi] + im[mi] * im[mi]) / N;
      mag[mi] = m > 1e-10 ? 20 * Math.log10(m) : -120;
    }

    return {
      mag:      mag,
      freqStep: sampleRate / N
    };
  }

  /* ── FFT panel draw ──────────────────────────────────────── */
  /*
   * Called every frame by scope-render.js when FFT is enabled.
   * Draws the frequency spectrum for CH1 (green) and optionally
   * CH2 (amber) onto the fftCvs canvas.
   */
  function draw(fftCtx, fftCvs, d1, d2, state) {
    if (!fftCtx || !fftCvs || !d1) return;

    var W          = fftCvs.width;
    var H          = fftCvs.height;
    var dpr        = window.devicePixelRatio || 1;
    var sampleRate = window.EEEngine ? window.EEEngine.state.sampleRate : 9600;

    /* Background */
    fftCtx.fillStyle = '#06070D';
    fftCtx.fillRect(0, 0, W, H);

    var dBmin = -80;
    var dBmax = 0;

    /* ── Horizontal dB grid lines ── */
    fftCtx.strokeStyle = 'rgba(18, 26, 44, 0.85)';
    fftCtx.lineWidth   = 1;
    fftCtx.beginPath();
    var dbLevels = [-80, -60, -40, -20, 0];
    for (var g = 0; g < dbLevels.length; g++) {
      var gy = H * (1 - (dbLevels[g] - dBmin) / (dBmax - dBmin));
      fftCtx.moveTo(0,  gy);
      fftCtx.lineTo(W, gy);
    }
    fftCtx.stroke();

    /* ── dB labels ── */
    fftCtx.fillStyle = 'rgba(78, 96, 128, 0.6)';
    fftCtx.font      = (9 * dpr) + 'px JetBrains Mono';
    fftCtx.textAlign = 'left';
    for (var dl = 0; dl < dbLevels.length; dl++) {
      var ly = H * (1 - (dbLevels[dl] - dBmin) / (dBmax - dBmin));
      fftCtx.fillText(dbLevels[dl] + 'dB', 4, ly - 2);
    }

    /* ── Frequency axis labels ── */
    var maxFreq = sampleRate / 2;
    fftCtx.textAlign = 'center';
    for (var fi = 0; fi <= 5; fi++) {
      var f  = (maxFreq / 5) * fi;
      var fx = (f / maxFreq) * W;
      var flabel = f >= 1000
        ? (f / 1000).toFixed(1) + 'k'
        : Math.round(f).toString();
      fftCtx.fillText(flabel, fx, H - 3);
    }

    /* ── Spectrum lines ── */
    var traces = [
      { data: d1, colour: '#00C87A' },
      { data: d2, colour: '#F5A623' }
    ];

    for (var ti = 0; ti < traces.length; ti++) {
      if (!traces[ti].data) continue;

      var result = computeFFT(traces[ti].data, sampleRate);
      var mag    = result.mag;
      var N2     = mag.length;

      fftCtx.beginPath();
      fftCtx.strokeStyle = traces[ti].colour;
      fftCtx.lineWidth   = 1.5;
      fftCtx.shadowColor = traces[ti].colour;
      fftCtx.shadowBlur  = 4;

      for (var si = 0; si < N2; si++) {
        var sx = (si / N2) * W;
        var sy = H * (1 - (mag[si] - dBmin) / (dBmax - dBmin));
        sy     = Math.min(H, Math.max(0, sy));

        if (si === 0) fftCtx.moveTo(sx, sy);
        else          fftCtx.lineTo(sx, sy);
      }

      fftCtx.stroke();
      fftCtx.shadowBlur = 0;
    }

    /* ── Panel label ── */
    var maxLabel = maxFreq >= 1000
      ? (maxFreq / 1000).toFixed(1) + ' kHz'
      : maxFreq + ' Hz';

    fftCtx.fillStyle  = 'rgba(78, 96, 128, 0.5)';
    fftCtx.font       = (9 * dpr) + 'px JetBrains Mono';
    fftCtx.textAlign  = 'right';
    fftCtx.fillText('FFT  0 \u2192 ' + maxLabel, W - 4, 13);
  }

  /* ── Expose ──────────────────────────────────────────────── */
  window.EEFFT = {
    draw:       draw,
    computeFFT: computeFFT
  };

}());
