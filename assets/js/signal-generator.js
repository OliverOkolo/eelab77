/**
 * signal-generator.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * All logic for signal-generator.html.
 *
 * Responsibilities:
 *   - Wave type selection and thumbnail drawing
 *   - Live frequency and step size calculation
 *   - RC filter cutoff and attenuation calculation
 *   - Circuit diagram text generation
 *   - Live Arduino sketch generation
 *   - Preview canvas animation
 *   - Copy and download sketch buttons
 *
 * Depends on: home-animations.js (for waveShapes via window.EElab77)
 *             Load home-animations.js first, or this file will
 *             define its own fallback waveShapes internally.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Shorthand ───────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  /* ── Wave shape functions ────────────────────────────────── */
  /*
   * Reuse the shapes defined in home-animations.js if available.
   * This avoids duplicating the same four functions in two files.
   * If home-animations.js is not loaded, define them here instead.
   */
  var waveShapes = (window.EElab77 && window.EElab77.waveShapes)
    ? window.EElab77.waveShapes
    : {
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

  /* ── State ───────────────────────────────────────────────── */
  var waveType = 'sine';

  /* ── Wave thumbnail drawing ──────────────────────────────── */
  /*
   * Draws a small static waveform into a thumbnail canvas.
   * Called once on init and again whenever the wave type changes.
   */
  function drawThumbnail(canvasId, type, colour) {
    var c = $(canvasId);
    if (!c) return;

    var dpr     = window.devicePixelRatio || 1;
    var cssW    = c.offsetWidth  || 56;
    var cssH    = c.offsetHeight || 28;
    c.width     = cssW * dpr;
    c.height    = cssH * dpr;
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';

    var cx = c.getContext('2d');
    cx.clearRect(0, 0, c.width, c.height);

    cx.beginPath();
    cx.strokeStyle = colour;
    cx.lineWidth   = 1.5 * dpr;

    var fn = waveShapes[type];
    for (var i = 0; i <= c.width; i++) {
      var y = fn(i / c.width, 2, 0) * c.height;
      if (i === 0) cx.moveTo(i, y);
      else         cx.lineTo(i, y);
    }
    cx.stroke();
  }

  function drawAllThumbnails() {
    drawThumbnail('wc-sine',     'sine',     '#00C87A');
    drawThumbnail('wc-square',   'square',   '#F5A623');
    drawThumbnail('wc-triangle', 'triangle', '#4E8CFF');
    drawThumbnail('wc-sawtooth', 'sawtooth', '#00C8E8');
  }

  /* ── Set active wave type ────────────────────────────────── */
  /*
   * Updates waveType, toggles the is-active class on the buttons,
   * updates the info cell, and regenerates the sketch.
   * Exposed on window so the HTML onclick attributes can call it.
   */
  function setWave(type) {
    waveType = type;

    var types = ['sine', 'square', 'triangle', 'sawtooth'];
    for (var i = 0; i < types.length; i++) {
      var btn = $('wave-' + types[i]);
      if (btn) btn.classList.toggle('is-active', types[i] === type);
    }

    var infoEl = $('info-wavetype');
    if (infoEl) {
      infoEl.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    }

    update();
  }

  /* Expose so HTML onclick can reach it */
  window.setWave = setWave;

  /* ── Main parameter update ───────────────────────────────── */
  /*
   * Reads all slider/select values, recomputes every derived
   * value (step sizes, RC filter, sketch), and updates the DOM.
   * Called on every input event.
   */
  function update() {
    var fMin   = +($('sl-fmin')  ? $('sl-fmin').value  : 10);
    var fMax   = +($('sl-fmax')  ? $('sl-fmax').value  : 500);
    var delay  = +($('sl-delay') ? $('sl-delay').value : 20);
    var baud   = +($('sel-baud') ? $('sel-baud').value : 115200);
    var rKOhm  = +($('sl-r')    ? $('sl-r').value     : 1);
    var cSteps = +($('sl-c')    ? $('sl-c').value     : 10);

    /* ── Update slider labels ── */
    setText('lbl-fmin',  fMin  + ' Hz');
    setText('lbl-fmax',  fMax  + ' Hz');
    setText('lbl-delay', delay + ' \u03bcs');
    setText('lbl-r',     rKOhm + ' k\u03a9');
    setText('lbl-c',     (cSteps * 10) + ' nF');

    /* ── Step size calculation ── */
    /*
     * The phase accumulator is 16-bit (0..65535).
     * One full sine cycle = 65536 phase increments.
     * Loop period = delayMicroseconds(delay) + ~4µs overhead.
     * Therefore:
     *   stepSize = 65536 × loopPeriod_µs × freq_Hz / 1_000_000
     */
    var loopUs  = delay + 4;
    var stepMin = Math.max(1, Math.round(65536 * loopUs * fMin / 1e6));
    var stepMax = Math.max(1, Math.round(65536 * loopUs * fMax / 1e6));

    /* Actual achievable frequencies after integer rounding */
    var actFmin = (stepMin * 1e6 / (65536 * loopUs)).toFixed(1);
    var actFmax = (stepMax * 1e6 / (65536 * loopUs)).toFixed(1);

    setText('info-stepmin', stepMin.toString());
    setText('info-stepmax', stepMax.toString());

    /* Warn when integer rounding shifts fmin or fmax by more than 5% */
    var devMin = fMin > 0 ? Math.abs(parseFloat(actFmin) - fMin) / fMin * 100 : 0;
    var devMax = fMax > 0 ? Math.abs(parseFloat(actFmax) - fMax) / fMax * 100 : 0;
    var freqRangeEl = document.getElementById('info-freqrange');
    if (freqRangeEl) {
      freqRangeEl.textContent = actFmin + '\u2013' + actFmax + ' Hz';
      if (devMin > 5 || devMax > 5) {
        freqRangeEl.style.color  = 'var(--color-amber, #F5A623)';
        freqRangeEl.title = 'Actual frequencies differ from requested by >' +
          Math.max(devMin, devMax).toFixed(0) + '% due to integer step rounding. ' +
          'Increase loop delay or lower the frequency range to reduce quantisation.';
      } else {
        freqRangeEl.style.color  = '';
        freqRangeEl.title = '';
      }
    }

    /* ── RC filter calculation ── */
    /*
     * Two-stage RC filter. Each stage:
     *   R = rKOhm × 1000 Ω
     *   C = cSteps × 10nF
     *   fc = 1 / (2π × R × C)
     * Two stages give -40 dB/decade per stage → total -80 dB/decade,
     * but we approximate as -40 dB/decade here for the dominant stage.
     */
    var R          = rKOhm * 1000;
    var C          = cSteps * 10e-9;
    var fc         = 1 / (2 * Math.PI * R * C);
    var pwmCarrier = 62500; /* Hz — Timer 1 fast PWM 8-bit at 16 MHz */

    /* Attenuation in dB at pwmCarrier (two stages) */
    var attCarrier = -40 * Math.log10(pwmCarrier / fc) * 2;

    /* Attenuation at fmax (two stages, clamp to 0 dB max) */
    var attFmax = Math.min(0, -40 * Math.log10(Math.max(fMax, fc + 1) / fc) * 2);

    setText('rc-fc',   fc >= 1000
      ? (fc / 1000).toFixed(1) + ' kHz'
      : Math.round(fc) + ' Hz');
    setText('rc-att',  attCarrier.toFixed(0) + ' dB');
    setText('rc-attf', attFmax.toFixed(1)    + ' dB');

    /* Assessment */
    var assessEl = $('rc-assess');
    if (assessEl) {
      if (fc < fMax) {
        assessEl.textContent = '\u26A0 Cutoff too low \u2014 increase R or C, or lower fmax';
        assessEl.className   = 'rc-result__value rc-result__value--warn';
      } else if (attCarrier < -30) {
        assessEl.textContent = '\u2713 Good \u2014 PWM carrier well attenuated';
        assessEl.className   = 'rc-result__value rc-result__value--good';
      } else {
        assessEl.textContent = '\u2191 Increase capacitor for better filtering';
        assessEl.className   = 'rc-result__value rc-result__value--warn';
      }
    }

    /* ── Circuit diagram ── */
    var cNf       = cSteps * 10;
    var diagEl    = $('circuit-content');
    if (diagEl) {
      diagEl.textContent = [
        'Pin 9 \u2500\u2500[' + rKOhm + 'k\u03a9]\u2500\u2500\u252c\u2500\u2500[' + rKOhm + 'k\u03a9]\u2500\u2500 OUTPUT',
        '                  [' + cNf   + 'nF]   [' + cNf + 'nF]',
        '                    \u2502          \u2502',
        '                   GND        GND'
      ].join('\n');
    }

    /* ── Sketch ── */
    updateSketch(fMin, fMax, delay, baud, stepMin, stepMax, rKOhm, cNf);
  }

  /* ── DOM text helper ─────────────────────────────────────── */
  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  /* ── Live sketch generation ──────────────────────────────── */
  /*
   * Builds the complete Arduino sketch as a string and writes
   * it into the <pre> element. Also stores it in window.SIGGEN_SKETCH
   * so the copy/download buttons can read it.
   */
  function updateSketch(fMin, fMax, delay, baud, stepMin, stepMax, rKOhm, cNf) {

    /* Wave table fill — one line per wave type */
    var waveFill = {
      sine:
        '    waveTable[i] = 128 + (int)(127.0 * sin(angle));',
      square:
        '    waveTable[i] = (i < 128) ? 255 : 0;',
      triangle:
        '    waveTable[i] = (i < 128) ? (i * 2) : (255 - (i - 128) * 2);',
      sawtooth:
        '    waveTable[i] = i;'
    };

    var waveName = waveType.charAt(0).toUpperCase() + waveType.slice(1);
    var midStep  = Math.round((stepMin + stepMax) / 2);
    var loopUs   = delay + 4;

    var lines = [
      '// ============================================================',
      '//  EElab77 \u2014 Signal Generator',
      '//  Waveform : ' + waveName,
      '//  Frequency: ~' + fMin + '\u2013' + fMax + ' Hz (adjust potentiometer)',
      '//  Baud rate: ' + baud,
      '//',
      '//  RC Filter wiring (build on breadboard):',
      '//    Pin 9 \u2500\u2500[' + rKOhm + 'k\u03a9]\u2500\u2500\u252c\u2500\u2500[' + rKOhm + 'k\u03a9]\u2500\u2500 OUTPUT \u2192 scope A0',
      '//                    [' + cNf + 'nF]   [' + cNf + 'nF]',
      '//                      \u2502          \u2502',
      '//                     GND        GND',
      '//',
      '//  GND must be shared between both Arduinos.',
      '// ============================================================',
      '',
      'const int pwmPin = 9;',
      'const int potPin = A1;      // A1 keeps A0 free for scope input',
      '#define BAUD_RATE ' + baud,
      '',
      'uint8_t  waveTable[256];',
      'uint16_t phase    = 0;',
      'uint16_t stepSize = ' + midStep + ';',
      '',
      '// Read pot every N steps \u2014 avoids timing jitter from analogRead()',
      'const uint16_t POT_INTERVAL = 400;',
      'uint16_t potCounter = 0;',
      'unsigned long lastPrint = 0;',
      '',
      'void setup() {',
      '  Serial.begin(BAUD_RATE);',
      '  pinMode(pwmPin, OUTPUT);',
      '',
      '  // Build ' + waveType + ' lookup table (0\u2013255 \u2192 0\u20135V via PWM)',
      '  for (int i = 0; i < 256; i++) {',
      '    float angle = 2.0 * PI * i / 256.0;',
      waveFill[waveType],
      '  }',
      '',
      '  // Timer 1 \u2014 Fast PWM 8-bit (Mode 5), no prescaler \u2192 62.5 kHz carrier',
      '  // WGM = 0101: TOP = 255, non-inverting output on OC1A (pin 9)',
      '  // Bug note: WGM11 must NOT be set here. Use only WGM10 + WGM12.',
      '  TCCR1A = _BV(COM1A1) | _BV(WGM10);',
      '  TCCR1B = _BV(WGM12)  | _BV(CS10);',
      '}',
      '',
      'void loop() {',
      '  // Step phase accumulator and write PWM duty cycle',
      '  phase += stepSize;',
      '  OCR1A = waveTable[phase >> 8];',
      '',
      '  // Read potentiometer at reduced rate',
      '  if (++potCounter >= POT_INTERVAL) {',
      '    potCounter = 0;',
      '    int pot = analogRead(potPin);',
      '    stepSize = (uint16_t)map(pot, 0, 1023, ' + stepMin + ', ' + stepMax + ');',
      '  }',
      '',
      '  // Serial debug \u2014 open Serial Monitor @ ' + baud + ' baud',
      '  if (millis() - lastPrint >= 250) {',
      '    lastPrint = millis();',
      '    float freq = stepSize * 1e6 / (65536.0 * ' + loopUs + '.0);',
      '    Serial.print("step=");  Serial.print(stepSize);',
      '    Serial.print("  freq~"); Serial.print(freq, 1); Serial.println(" Hz");',
      '  }',
      '',
      '  delayMicroseconds(' + delay + ');',
      '}'
    ];

    var sketch = lines.join('\n');

    /* Store for copy/download */
    window.SIGGEN_SKETCH = sketch;

    /* Write into preview box */
    var pre = $('sketch-output');
    if (pre) pre.textContent = sketch;
  }

  /* ── Copy sketch ─────────────────────────────────────────── */
  function copySketch() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(window.SIGGEN_SKETCH || '');

    var btn = $('btn-copy-sketch');
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
    }
  }

  /* ── Download sketch ─────────────────────────────────────── */
  function downloadSketch() {
    var blob = new Blob([window.SIGGEN_SKETCH || ''], { type: 'text/plain' });
    var a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'eelab77_signal_generator.ino';
    a.click();
  }

  /* Expose so HTML onclick can reach them */
  window.copySketch     = copySketch;
  window.downloadSketch = downloadSketch;

  /* ── Preview canvas animation ────────────────────────────── */
  /*
   * Draws a continuously scrolling waveform in the preview panel.
   * Wave type follows waveType so it updates when the user
   * clicks a different waveform button.
   */
  function initPreview() {
    var canvas = $('preview-canvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var dpr;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      canvas.width        = canvas.offsetWidth  * dpr;
      canvas.height       = canvas.offsetHeight * dpr;
      canvas.style.width  = canvas.offsetWidth  + 'px';
      canvas.style.height = canvas.offsetHeight + 'px';
    }
    window.addEventListener('resize', resize);
    resize();

    var t = 0;

    function frame() {
      var W = canvas.width;
      var H = canvas.height;

      /* Background */
      ctx.fillStyle = '#07080F';
      ctx.fillRect(0, 0, W, H);

      /* Grid */
      ctx.strokeStyle = 'rgba(18, 26, 44, 0.9)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      for (var gi = 0; gi <= 10; gi++) {
        ctx.moveTo(gi * W / 10, 0);
        ctx.lineTo(gi * W / 10, H);
      }
      for (var gj = 0; gj <= 6; gj++) {
        ctx.moveTo(0, gj * H / 6);
        ctx.lineTo(W, gj * H / 6);
      }
      ctx.stroke();

      /* Waveform */
      var fn = waveShapes[waveType];
      ctx.beginPath();
      ctx.strokeStyle = '#F5A623';
      ctx.lineWidth   = 2 * dpr;
      ctx.shadowColor = '#F5A623';
      ctx.shadowBlur  = 8;

      for (var i = 0; i <= W; i++) {
        var y = fn(i / W, 3, t * 1.4) * H * 0.8 + H * 0.1;
        if (i === 0) ctx.moveTo(i, y);
        else         ctx.lineTo(i, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      t += 0.018;
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  /* ── Wire all controls ───────────────────────────────────── */
  function init() {
    /* Draw static thumbnails for each wave button */
    drawAllThumbnails();

    /* Wave buttons */
    var types = ['sine', 'square', 'triangle', 'sawtooth'];
    for (var wi = 0; wi < types.length; wi++) {
      (function (type) {
        var btn = $('wave-' + type);
        if (btn) btn.addEventListener('click', function () { setWave(type); });
      }(types[wi]));
    }

    /* All sliders trigger update() */
    var sliderIds = ['sl-fmin', 'sl-fmax', 'sl-delay', 'sl-r', 'sl-c'];
    for (var si = 0; si < sliderIds.length; si++) {
      var el = $(sliderIds[si]);
      if (el) el.addEventListener('input', update);
    }

    /* Baud select */
    var baudSel = $('sel-baud');
    if (baudSel) baudSel.addEventListener('change', update);

    /* Copy / Download buttons */
    var btnCopy = $('btn-copy-sketch');
    var btnDL   = $('btn-dl-sketch');
    if (btnCopy) btnCopy.addEventListener('click', copySketch);
    if (btnDL)   btnDL.addEventListener('click',   downloadSketch);

    /* Start preview canvas */
    initPreview();

    /* Generate the initial sketch with default values */
    update();
  }

  /* ── Init on DOM ready ───────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', init);

}());

