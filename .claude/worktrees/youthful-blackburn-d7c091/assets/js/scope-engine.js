/**
 * scope-engine.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * The core oscilloscope state machine.
 *
 * Responsibilities:
 *   - Maintains two ring buffers (one per channel)
 *   - Runs the trigger state machine on every incoming sample
 *   - Decides when to capture a display window
 *   - Applies AC coupling and invert math to captured data
 *   - Handles Normal, Average, and Peak acquisition modes
 *   - Computes waveform measurements (freq, Vpp, Vrms, etc.)
 *   - Exposes frozen display buffers to scope-render.js
 *
 * This file is pure logic — it never touches the DOM or canvas.
 * scope-render.js reads from it. scope-controls.js writes to it.
 *
 * Depends on: scope-serial.js  (must load first)
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Constants ───────────────────────────────────────────── */
  var VREF      = 5.0;
  var ADC_MAX   = 1023;
  var RING_SIZE = 32768;
  var GRID_X    = 10;
  var GRID_Y    = 8;

  /*
   * Lookup tables for UI controls.
   * Index into these arrays using the slider integer value.
   */
  var TIMEBASE_MS  = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  var VDIV_V       = [0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0];
  var HOLDOFF_MS   = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  var AVG_COUNTS   = [2, 4, 8, 16, 32, 64];

  /* ── Ring buffers ────────────────────────────────────────── */
  /*
   * Circular buffers for incoming samples.
   * head points to the next write position.
   * samples tracks how many have been written (capped at RING_SIZE).
   */
  var ring1    = new Uint16Array(RING_SIZE);
  var ring2    = new Uint16Array(RING_SIZE);
  var head1    = 0;
  var samples1 = 0;
  var head2    = 0;
  var samples2 = 0;

  /* ── Display state ───────────────────────────────────────── */
  /*
   * state is the single object that scope-controls.js writes to
   * when the user moves a slider or clicks a button, and that
   * scope-render.js reads from when drawing.
   */
  var state = {
    /* Timebase */
    timebaseIdx:  4,        /* index into TIMEBASE_MS — 5ms/div default */

    /* Acquisition */
    acqMode:      'normal', /* 'normal' | 'average' | 'peak' */
    avgTarget:    8,        /* how many captures to average */
    running:      true,
    singleShot:   false,
    rollingMode:  false,
    sampleRate:   9600,     /* Hz — updated from live diag every second */

    /* Per-channel configuration */
    ch: [
      {
        enabled:   true,
        vdivIdx:   3,       /* index into VDIV_V — 1V/div default */
        offsetPct: 0,       /* vertical offset as % of screen height */
        acCouple:  false,   /* subtract DC mean when true */
        invert:    false    /* flip trace vertically when true */
      },
      {
        enabled:   false,
        vdivIdx:   3,
        offsetPct: 0,
        acCouple:  false,
        invert:    false
      }
    ],

    /* Trigger */
    trigMode:   'auto',   /* 'auto' | 'normal' | 'none' */
    trigSrc:    0,        /* 0 = CH1, 1 = CH2 */
    trigLevel:  0.5,      /* normalised 0..1  (0.5 = 2.5V) */
    trigEdge:   'rise',   /* 'rise' | 'fall' */
    holdoffIdx: 2,        /* index into HOLDOFF_MS — 20ms default */

    /* Cursors */
    cursorsEnabled: false,
    cursorT1: 0.25,       /* 0..1 fraction of canvas width */
    cursorT2: 0.75,
    cursorV1: 0.35,       /* 0..1 fraction of canvas height (0=top) */
    cursorV2: 0.65,

    /* Display options */
    interpolate:  true,
    fill:         false,
    fftEnabled:   false,
    persistence:  0       /* 0 = off, 0.05..0.95 = phosphor decay */
  };

  /* ── Frozen display buffers ──────────────────────────────── */
  /*
   * These are what scope-render.js draws each frame.
   * They only update when a trigger fires (or in rolling mode,
   * every frame). This is why the waveform stays stable.
   */
  var frozen1    = null;   /* Float32Array — CH1 processed samples */
  var frozen2    = null;   /* Float32Array — CH2 processed samples */
  var frozenRaw1 = null;   /* Uint16Array  — CH1 raw ADC for CSV export */

  /* ── Acquisition accumulators ────────────────────────────── */
  var avgBuffer   = null;  /* Float32Array accumulator for average mode */
  var avgCount    = 0;     /* how many captures have been stacked */
  var peakMax     = null;  /* Float32Array element-wise maximum */
  var peakMin     = null;  /* Float32Array element-wise minimum */

  /* ── Trigger state machine ───────────────────────────────── */
  /*
   * States:
   *   'armed'  — watching for a trigger crossing
   *   'hold'   — trigger fired, waiting for holdoff to expire
   *
   * When a trigger fires, displayDirty = true tells updateCapture()
   * to grab a fresh window from the ring buffer on the next call.
   */
  var trigState    = 'armed';
  var holdoffEnd   = 0;
  var lastSamp     = [0, 0];  /* previous sample value per channel */
  var autoTimeout  = Date.now() + 500;
  var displayDirty = false;

  /* ── Incoming sample handler ─────────────────────────────── */
  /*
   * Called by scope-serial.js for every valid frame received.
   * Writes the sample into the correct ring buffer, then runs
   * the trigger evaluation if this channel is the trigger source.
   */
  function onSample(val, ch) {

    /* Write into ring buffer */
    if (ch === 0) {
      ring1[head1] = val;
      head1 = (head1 + 1) % RING_SIZE;
      if (samples1 < RING_SIZE) samples1++;
    } else {
      ring2[head2] = val;
      head2 = (head2 + 1) % RING_SIZE;
      if (samples2 < RING_SIZE) samples2++;
    }

    /* Only evaluate trigger on the selected source channel */
    if (ch !== state.trigSrc) return;

    var level = Math.round(state.trigLevel * ADC_MAX);
    var prev  = lastSamp[ch];

    /* Advance holdoff timer */
    if (trigState === 'hold' && Date.now() >= holdoffEnd) {
      trigState = 'armed';
    }

    /* Check for trigger crossing */
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
        autoTimeout  = Date.now() + Math.max(HOLDOFF_MS[state.holdoffIdx] * 2, 200);
        displayDirty = true;
      }
    }

    lastSamp[ch] = val;
  }

  /* Register handler with serial module */
  if (window.EESerial) {
    window.EESerial.onSample = onSample;
  }

  /* ── Extract window from ring buffer ─────────────────────── */
  /*
   * Copies `count` samples ending at the current head position
   * into a fresh Uint16Array. The start offset lets us reach back
   * further into the buffer to include pre-trigger samples.
   */
  function extractWindow(ring, head, count, startBack) {
    var arr  = new Uint16Array(count);
    var back = startBack !== undefined ? startBack : count;
    for (var i = 0; i < count; i++) {
      arr[i] = ring[(head - back + i + RING_SIZE) % RING_SIZE];
    }
    return arr;
  }

  /* ── Apply math: AC coupling and invert ──────────────────── */
  /*
   * Takes a raw Uint16Array and returns a processed Float32Array.
   * AC coupling subtracts the mean so the signal centres at 0.
   * Invert flips around the midpoint.
   */
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

  /* ── Trigger search in ring buffer ───────────────────────── */
  /*
   * Searches backwards from the current head for the most recent
   * trigger crossing. Returns how many samples back from head the
   * crossing occurred, or 0 if none found (fall back to latest).
   */
  function findTrigOffset(ring, head, samples, winSamples) {
    if (state.trigMode === 'none' || samples < winSamples + 2) return 0;

    var level  = Math.round(state.trigLevel * ADC_MAX);
    var search = Math.min(
      samples - winSamples,
      winSamples * 4,
      RING_SIZE - winSamples - 2
    );

    for (var i = search; i >= 1; i--) {
      var idxA = (head - i - 1 + RING_SIZE) % RING_SIZE;
      var idxB = (head - i     + RING_SIZE) % RING_SIZE;
      var a    = ring[idxA];
      var b    = ring[idxB];

      var hit = state.trigEdge === 'rise'
        ? (a < level && b >= level)
        : (a > level && b <= level);

      if (hit) return i;
    }

    return 0;
  }

  /* ── Main capture update ─────────────────────────────────── */
  /*
   * Called every animation frame by scope-render.js.
   * Only does work when displayDirty = true (trigger fired)
   * or in rolling mode (always update).
   *
   * After capturing it runs the acquisition mode logic
   * (normal / average / peak) then stores the result in
   * frozen1 / frozen2 for the renderer to draw.
   */
  function updateCapture() {
    if (!state.running && !state.singleShot) return;

    /* Calculate how many samples fit in the current timebase window */
    var tbSec      = TIMEBASE_MS[state.timebaseIdx] / 1000;
    var winSamples = Math.round(tbSec * GRID_X * state.sampleRate);
    winSamples     = Math.max(4, Math.min(winSamples, RING_SIZE - 2, samples1 - 1));
    if (winSamples < 4) return;

    /* ── Rolling mode — always show the latest samples ── */
    if (state.rollingMode) {
      frozenRaw1 = extractWindow(ring1, head1, winSamples);
      frozen1    = applyMath(frozenRaw1, 0);

      if (state.ch[1].enabled && samples2 >= winSamples) {
        frozen2 = applyMath(
          extractWindow(ring2, head2, Math.min(winSamples, samples2 - 1)),
          1
        );
      }

      computeMeasurements(frozen1, 0);
      if (frozen2) computeMeasurements(frozen2, 1);
      return;
    }

    /* ── Triggered modes — only update when dirty ── */
    if (!displayDirty && frozen1) return;

    /* Find trigger crossing point in ring buffer */
    var trigRing  = state.trigSrc === 0 ? ring1  : ring2;
    var trigHead  = state.trigSrc === 0 ? head1  : head2;
    var trigSamps = state.trigSrc === 0 ? samples1 : samples2;
    var offset    = findTrigOffset(trigRing, trigHead, trigSamps, winSamples);

    /*
     * Include 10% pre-trigger samples so the trigger point appears
     * slightly right of the left edge, matching real scope behaviour.
     */
    var preTrig = Math.round(winSamples * 0.1);
    var back    = Math.min(
      (offset > 0 ? offset : winSamples) + preTrig,
      samples1 - 1
    );
    if (back < winSamples) return;

    /* Extract raw CH1 window */
    var raw1 = new Uint16Array(winSamples);
    for (var i = 0; i < winSamples; i++) {
      raw1[i] = ring1[(head1 - back + i + RING_SIZE) % RING_SIZE];
    }
    frozenRaw1 = raw1;

    var processed = applyMath(raw1, 0);

    /* ── Acquisition mode: Average ── */
    if (state.acqMode === 'average') {
      if (!avgBuffer || avgBuffer.length !== winSamples) {
        avgBuffer = new Float32Array(winSamples);
        avgCount  = 0;
      }

      for (var a = 0; a < winSamples; a++) {
        avgBuffer[a] += processed[a];
      }
      avgCount++;

      /* Report progress to UI */
      if (window.EEControls && window.EEControls.setAvgProgress) {
        window.EEControls.setAvgProgress(avgCount, state.avgTarget);
      }

      /* Only publish when the target count is reached */
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

      /* Do not show partial averages */
      return;

    /* ── Acquisition mode: Peak detect ── */
    } else if (state.acqMode === 'peak') {
      if (!peakMax || peakMax.length !== winSamples) {
        peakMax = new Float32Array(winSamples);
        peakMin = new Float32Array(winSamples);
        for (var p = 0; p < winSamples; p++) {
          peakMax[p] = -Infinity;
          peakMin[p] =  Infinity;
        }
      }

      for (var k = 0; k < winSamples; k++) {
        if (processed[k] > peakMax[k]) peakMax[k] = processed[k];
        if (processed[k] < peakMin[k]) peakMin[k] = processed[k];
      }

      frozen1      = processed;
      displayDirty = false;

    /* ── Acquisition mode: Normal ── */
    } else {
      frozen1      = processed;
      displayDirty = false;
    }

    /* ── CH2 capture ── */
    /*
     * Use the same back-offset as CH1 so both channels are
     * time-aligned on screen.
     */
    if (state.ch[1].enabled && samples2 >= winSamples) {
      var raw2 = new Uint16Array(winSamples);
      for (var j = 0; j < winSamples; j++) {
        raw2[j] = ring2[(head2 - back + j + RING_SIZE) % RING_SIZE];
      }
      frozen2 = applyMath(raw2, 1);
      computeMeasurements(frozen2, 1);
    } else {
      frozen2 = null;
    }

    /* Handle single-shot: stop after one successful capture */
    if (state.singleShot) {
      state.running    = false;
      state.singleShot = false;
      if (window.EEControls && window.EEControls.syncRunState) {
        window.EEControls.syncRunState();
      }
    }

    computeMeasurements(frozen1, 0);
  }

  /* ── Waveform measurements ───────────────────────────────── */
  /*
   * Computes Vmax, Vmin, Vpp, Vdc, Vrms, frequency (via zero
   * crossings), and duty cycle. Results are passed to
   * EEControls.updateMeasurements() for DOM display.
   */
  function computeMeasurements(samples, chIdx) {
    var n = samples.length;
    if (n < 4) return;

    var sum = 0;
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

    /* RMS (AC component) */
    var ssq = 0;
    for (var j = 0; j < n; j++) {
      var v = (samples[j] / ADC_MAX) * VREF - vdc;
      ssq += v * v;
    }
    var vrms = Math.sqrt(ssq / n);

    /* Frequency via zero-crossing count */
    var crossings = 0;
    for (var k = 1; k < n; k++) {
      if ((samples[k - 1] < mean) !== (samples[k] < mean)) crossings++;
    }
    var windowSec = (TIMEBASE_MS[state.timebaseIdx] / 1000) * GRID_X;
    var freq      = crossings > 1 ? (crossings / 2) / windowSec : null;

    /* Duty cycle — fraction of samples above the mean */
    var highCount = 0;
    for (var d = 0; d < n; d++) {
      if (samples[d] > mean) highCount++;
    }
    var duty = (highCount / n * 100).toFixed(1) + '%';

    if (window.EEControls && window.EEControls.updateMeasurements) {
      window.EEControls.updateMeasurements(chIdx, {
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
  /*
   * Called when the user changes acquisition mode, timebase, or
   * channel settings. Clears all accumulators so the new mode
   * starts clean.
   */
  function resetAcq() {
    avgBuffer    = null;
    avgCount     = 0;
    peakMax      = null;
    peakMin      = null;
    displayDirty = true;
  }

  /* ── Getters for render module ───────────────────────────── */
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

  /* ── Expose public API ───────────────────────────────────── */
  window.EEEngine = {
    /* State object — controls write directly to this */
    state: state,

    /* Methods */
    onSample:       onSample,
    updateCapture:  updateCapture,
    resetAcq:       resetAcq,
    getDisplayData: getDisplayData,

    /* Constants — needed by controls and render modules */
    VREF:        VREF,
    ADC_MAX:     ADC_MAX,
    GRID_X:      GRID_X,
    GRID_Y:      GRID_Y,
    TIMEBASE_MS: TIMEBASE_MS,
    VDIV_V:      VDIV_V,
    HOLDOFF_MS:  HOLDOFF_MS,
    AVG_COUNTS:  AVG_COUNTS
  };

}());

