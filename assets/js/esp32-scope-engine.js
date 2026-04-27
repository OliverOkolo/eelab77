/**
 * esp32-scope-engine.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Core state machine for the ESP32 oscilloscope.
 *
 * Differences from scope-engine.js (Arduino version):
 *   - ADC_MAX is 4095 (12-bit) instead of 1023 (10-bit)
 *   - VREF is 3.3V instead of 5.0V
 *   - Ring buffer is larger (65536) to handle higher sample rate
 *   - Same trigger state machine, acquisition modes, and math
 *
 * Depends on: esp32-scope-transport.js (must load first)
 * Exposes:    window.ESP32Engine
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Constants ───────────────────────────────────────────── */
  var VREF      = 3.3;
  var ADC_MAX   = 4095;
  var RING_SIZE = 65536;
  var GRID_X    = 10;
  var GRID_Y    = 8;

  var TIMEBASE_MS = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200
  ];

  var VDIV_V = [
    0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 3.3
  ];

  var HOLDOFF_MS = [
    2, 5, 10, 20, 50, 100, 200, 500, 1000
  ];

  var AVG_COUNTS = [2, 4, 8, 16, 32, 64];

  /* ── Ring buffers ────────────────────────────────────────── */
  var ring1    = new Uint16Array(RING_SIZE);
  var ring2    = new Uint16Array(RING_SIZE);
  var head1    = 0;
  var samples1 = 0;
  var head2    = 0;
  var samples2 = 0;

  /* ── Display state ───────────────────────────────────────── */
  var state = {
    timebaseIdx:  3,
    acqMode:      'normal',
    avgTarget:    8,
    running:      true,
    singleShot:   false,
    rollingMode:  false,
    sampleRate:   100000,

    ch: [
      {
        enabled:   true,
        vdivIdx:   4,
        offsetPct: 0,
        acCouple:  false,
        invert:    false
      },
      {
        enabled:   false,
        vdivIdx:   4,
        offsetPct: 0,
        acCouple:  false,
        invert:    false
      }
    ],

    trigMode:   'auto',
    trigSrc:    0,
    trigLevel:  0.5,
    trigEdge:   'rise',
    holdoffIdx: 3,

    cursorsEnabled: false,
    cursorT1: 0.25,
    cursorT2: 0.75,
    cursorV1: 0.35,
    cursorV2: 0.65,

    interpolate:  true,
    fill:         false,
    fftEnabled:   false,
    persistence:  0
  };

  /* ── Frozen display buffers ──────────────────────────────── */
  var frozen1    = null;
  var frozen2    = null;
  var frozenRaw1 = null;

  /* ── Acquisition accumulators ────────────────────────────── */
  var avgBuffer = null;
  var avgCount  = 0;
  var peakMax   = null;
  var peakMin   = null;

  /* ── Trigger state machine ───────────────────────────────── */
  var trigState    = 'armed';
  var holdoffEnd   = 0;
  var lastSamp     = [0, 0];
  var autoTimeout  = Date.now() + 500;
  var displayDirty = false;

  /* ── Incoming sample handler ─────────────────────────────── */
  function onSample(val, ch) {

    if (ch === 0) {
      ring1[head1] = val;
      head1 = (head1 + 1) % RING_SIZE;
      if (samples1 < RING_SIZE) samples1++;
    } else {
      ring2[head2] = val;
      head2 = (head2 + 1) % RING_SIZE;
      if (samples2 < RING_SIZE) samples2++;
    }

    if (ch !== state.trigSrc) return;

    var level = Math.round(state.trigLevel * ADC_MAX);
    var prev  = lastSamp[ch];

    if (trigState === 'hold' && Date.now() >= holdoffEnd) {
      trigState = 'armed';
    }

    if (trigState === 'armed') {
      var edgeFired =
        state.trigMode !== 'none' && (
          state.trigEdge === 'rise'
            ? (prev < level && val >= level)
            : (prev > level && val <= level)
        );

      var autoFired =
        state.trigMode === 'auto' && Date.now() > autoTimeout;

      if (edgeFired || autoFired) {
        trigState    = 'hold';
        holdoffEnd   = Date.now() + HOLDOFF_MS[state.holdoffIdx];
        autoTimeout  = Date.now() +
          Math.max(HOLDOFF_MS[state.holdoffIdx] * 2, 100);
        displayDirty = true;
      }
    }

    lastSamp[ch] = val;
  }

  /* Register with transport module */
  if (window.EEScopeTransport) {
    window.EEScopeTransport.onSample = onSample;
  }

  /* ── Extract window from ring buffer ─────────────────────── */
  function extractWin(ring, head, count, back) {
    var arr     = new Uint16Array(count);
    var startBack = (back !== undefined) ? back : count;
    for (var i = 0; i < count; i++) {
      arr[i] = ring[(head - startBack + i + RING_SIZE) % RING_SIZE];
    }
    return arr;
  }

  /* ── Apply math: AC coupling and invert ──────────────────── */
  function applyMath(raw, chIdx) {
    var n   = raw.length;
    var out = new Float32Array(n);
    var cfg = state.ch[chIdx];
    var dc  = 0;

    if (cfg.acCouple) {
      for (var i = 0; i < n; i++) dc += raw[i];
      dc /= n;
    }

    for (var j = 0; j < n; j++) {
      var v = raw[j] - dc;
      if (cfg.invert) v = ADC_MAX - raw[j] - (dc > 0 ? dc : 0);
      out[j] = v;
    }
    return out;
  }

  /* ── Trigger search ──────────────────────────────────────── */
  function findTrigOffset(ring, head, samples, winSamples) {
    if (state.trigMode === 'none' || samples < winSamples + 2) return 0;

    var level  = Math.round(state.trigLevel * ADC_MAX);
    var search = Math.min(
      samples - winSamples,
      winSamples * 4,
      RING_SIZE - winSamples - 2
    );

    for (var i = search; i >= 1; i--) {
      var a = ring[(head - i - 1 + RING_SIZE) % RING_SIZE];
      var b = ring[(head - i     + RING_SIZE) % RING_SIZE];

      var hit = state.trigEdge === 'rise'
        ? (a < level && b >= level)
        : (a > level && b <= level);

      if (hit) return i;
    }
    return 0;
  }

  /* ── Main capture update ─────────────────────────────────── */
  function updateCapture() {
    if (!state.running && !state.singleShot) return;

    var tbSec      = TIMEBASE_MS[state.timebaseIdx] / 1000;
    var winSamples = Math.round(tbSec * GRID_X * state.sampleRate);
    winSamples     = Math.max(4,
      Math.min(winSamples, RING_SIZE - 2, samples1 - 1));
    if (winSamples < 4) return;

    /* Rolling mode */
    if (state.rollingMode) {
      frozenRaw1 = extractWin(ring1, head1, winSamples);
      frozen1    = applyMath(frozenRaw1, 0);

      if (state.ch[1].enabled && samples2 >= winSamples) {
        frozen2 = applyMath(
          extractWin(ring2, head2,
            Math.min(winSamples, samples2 - 1)),
          1
        );
      }

      computeMeasurements(frozen1, 0);
      if (frozen2) computeMeasurements(frozen2, 1);
      return;
    }

    if (!displayDirty && frozen1) return;

    /* Find trigger offset */
    var trigRing  = state.trigSrc === 0 ? ring1    : ring2;
    var trigHead  = state.trigSrc === 0 ? head1    : head2;
    var trigSamps = state.trigSrc === 0 ? samples1 : samples2;
    var offset    = findTrigOffset(
      trigRing, trigHead, trigSamps, winSamples
    );

    var preTrig = Math.round(winSamples * 0.1);
    var back    = Math.min(
      (offset > 0 ? offset : winSamples) + preTrig,
      samples1 - 1
    );
    if (back < winSamples) return;

    /* Extract CH1 */
    var raw1 = new Uint16Array(winSamples);
    for (var i = 0; i < winSamples; i++) {
      raw1[i] = ring1[(head1 - back + i + RING_SIZE) % RING_SIZE];
    }
    frozenRaw1 = raw1;

    var processed = applyMath(raw1, 0);

    /* Acquisition modes */
    if (state.acqMode === 'average') {
      if (!avgBuffer || avgBuffer.length !== winSamples) {
        avgBuffer = new Float32Array(winSamples);
        avgCount  = 0;
      }
      for (var a = 0; a < winSamples; a++) {
        avgBuffer[a] += processed[a];
      }
      avgCount++;

      if (window.ESP32Controls && window.ESP32Controls.setAvgProgress) {
        window.ESP32Controls.setAvgProgress(avgCount, state.avgTarget);
      }

      if (avgCount >= state.avgTarget) {
        frozen1 = new Float32Array(winSamples);
        for (var b = 0; b < winSamples; b++) {
          frozen1[b] = avgBuffer[b] / avgCount;
        }
        avgBuffer    = new Float32Array(winSamples);
        avgCount     = 0;
        displayDirty = false;
        computeMeasurements(frozen1, 0);
      }
      return;

    } else if (state.acqMode === 'peak') {
      if (!peakMax || peakMax.length !== winSamples) {
        peakMax = new Float32Array(winSamples).fill(-Infinity);
        peakMin = new Float32Array(winSamples).fill(Infinity);
      }
      for (var k = 0; k < winSamples; k++) {
        if (processed[k] > peakMax[k]) peakMax[k] = processed[k];
        if (processed[k] < peakMin[k]) peakMin[k] = processed[k];
      }
      frozen1      = processed;
      displayDirty = false;

    } else {
      frozen1      = processed;
      displayDirty = false;
    }

    /* CH2 */
    if (state.ch[1].enabled && samples2 >= winSamples) {
      var raw2 = new Uint16Array(winSamples);
      for (var j = 0; j < winSamples; j++) {
        raw2[j] = ring2[
          (head2 - back + j + RING_SIZE) % RING_SIZE
        ];
      }
      frozen2 = applyMath(raw2, 1);
      computeMeasurements(frozen2, 1);
    } else {
      frozen2 = null;
    }

    if (state.singleShot) {
      state.running    = false;
      state.singleShot = false;
      if (window.ESP32Controls && window.ESP32Controls.syncRunState) {
        window.ESP32Controls.syncRunState();
      }
    }

    computeMeasurements(frozen1, 0);
  }

  /* ── Waveform measurements ───────────────────────────────── */
  function computeMeasurements(samples, chIdx) {
    var n = samples.length;
    if (n < 4) return;

    var sum =  0;
    var max = -Infinity;
    var min =  Infinity;

    for (var i = 0; i < n; i++) {
      var s = samples[i];
      sum += s;
      if (s > max) max = s;
      if (s < min) min = s;
    }

    var mean = sum / n;
    var vmax = (max  / ADC_MAX) * VREF;
    var vmin = (min  / ADC_MAX) * VREF;
    var vdc  = (mean / ADC_MAX) * VREF;
    var vpp  = vmax - vmin;

    var ssq = 0;
    for (var j = 0; j < n; j++) {
      var v = (samples[j] / ADC_MAX) * VREF - vdc;
      ssq += v * v;
    }
    var vrms = Math.sqrt(ssq / n);

    var crossings = 0;
    for (var k = 1; k < n; k++) {
      if ((samples[k - 1] < mean) !== (samples[k] < mean)) {
        crossings++;
      }
    }
    var windowSec =
      (TIMEBASE_MS[state.timebaseIdx] / 1000) * GRID_X;
    var freq = crossings > 1 ? (crossings / 2) / windowSec : null;

    var highCount = 0;
    for (var d = 0; d < n; d++) {
      if (samples[d] > mean) highCount++;
    }
    var duty = (highCount / n * 100).toFixed(1) + '%';

    if (window.ESP32Controls && window.ESP32Controls.updateMeasurements) {
      window.ESP32Controls.updateMeasurements(chIdx, {
        freq: freq,
        vpp:  vpp,
        vmax: vmax,
        vmin: vmin,
        vdc:  vdc,
        vrms: vrms,
        duty: duty
      });
    }
  }

  /* ── Reset acquisition state ─────────────────────────────── */
  function resetAcq() {
    avgBuffer    = null;
    avgCount     = 0;
    peakMax      = null;
    peakMin      = null;
    displayDirty = true;
  }

  /* ── Getters ─────────────────────────────────────────────── */
  function getDisplayData() {
    return {
      frozen1:    frozen1,
      frozen2:    frozen2,
      frozenRaw1: frozenRaw1,
      peakMax:    peakMax,
      peakMin:    peakMin,
      state:      state,
      trigState:  trigState
    };
  }

  /* ── Expose ──────────────────────────────────────────────── */
  window.ESP32Engine = {
    state:          state,
    onSample:       onSample,
    updateCapture:  updateCapture,
    resetAcq:       resetAcq,
    getDisplayData: getDisplayData,
    VREF:           VREF,
    ADC_MAX:        ADC_MAX,
    GRID_X:         GRID_X,
    GRID_Y:         GRID_Y,
    TIMEBASE_MS:    TIMEBASE_MS,
    VDIV_V:         VDIV_V,
    HOLDOFF_MS:     HOLDOFF_MS,
    AVG_COUNTS:     AVG_COUNTS
  };

}());
