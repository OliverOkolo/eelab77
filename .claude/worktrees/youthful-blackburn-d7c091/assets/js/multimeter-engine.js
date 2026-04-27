/**
 * multimeter-engine.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Processes raw measurement frames from EEDmmSerial into
 * display-ready values. Manages:
 *
 *   - Unit conversion and formatting per mode
 *   - Auto-ranging (selects the best unit prefix)
 *   - Min / Max / Average tracking
 *   - Strip chart data buffer (rolling window)
 *   - Hold state
 *   - Wiring guide text per mode
 *
 * This file contains zero DOM access and zero canvas drawing.
 * multimeter-controls.js reads from EEDmmEngine and updates
 * the DOM. multimeter-controls.js also draws the strip chart.
 *
 * Depends on: multimeter-serial.js (must load first)
 * Exposes:    window.EEDmmEngine
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Mode constants ──────────────────────────────────────── */
  var MODE = {
    DCV:   1,
    DCA:   2,
    RES:   3,
    CONT:  4,
    FREQ:  5,
    DUTY:  6,
    DIODE: 7
  };

  /* ── State ───────────────────────────────────────────────── */
  var state = {
    mode:        MODE.DCV,
    hold:        false,
    connected:   false,

    /* Current processed reading */
    displayValue:  '0.000',
    displayUnit:   'V',
    displayMode:   'DC Voltage',
    overrange:     false,
    contClosed:    false,
    diodeFwd:      false,

    /* Raw numeric value for charting (in base unit) */
    numericValue:  0,

    /* Secondary display values (e.g. period alongside freq) */
    secondary: {
      label: '',
      value: ''
    }
  };

  /* ── Statistics ──────────────────────────────────────────── */
  var stats = {
    min:     Infinity,
    max:    -Infinity,
    sum:     0,
    count:   0
  };

  /* ── Strip chart buffer ──────────────────────────────────── */
  /*
   * Holds the last CHART_POINTS numeric readings for drawing.
   * Each entry is { value, timestamp } where value is in the
   * base unit (V, A, Ω, Hz, %).
   */
  var CHART_POINTS = 300;
  var chartBuffer  = [];

  /* ── Mode metadata ───────────────────────────────────────── */
  /*
   * Each mode entry defines:
   *   label       — display name
   *   baseUnit    — the unit before prefix scaling
   *   cssClass    — colour class suffix for the reading element
   *   wiring      — text shown in the wiring guide panel
   *   ranges      — array of range objects { max, label }
   *                 used to pick the right unit prefix
   */
  var modeData = {};

  modeData[MODE.DCV] = {
    label:    'DC Voltage',
    baseUnit: 'V',
    cssClass: 'voltage',
    wiring: [
      'DC Voltage (0 – 5 V):',
      '  Signal ──────────── A0',
      '  GND ─────────────── GND',
      '',
      'DC Voltage (0 – 50 V):',
      '  Signal ─[47kΩ]──── A0 ─[5.1kΩ]─ GND',
      '',
      'WARNING: Never exceed 50 V on this input.'
    ].join('\n'),
    ranges: [
      { max: 1.0,   label: 'Range: 0 – 1 V'  },
      { max: 5.0,   label: 'Range: 0 – 5 V'  },
      { max: 50.0,  label: 'Range: 0 – 50 V' }
    ]
  };

  modeData[MODE.DCA] = {
    label:    'DC Current',
    baseUnit: 'A',
    cssClass: 'current',
    wiring: [
      'DC Current (shunt method):',
      '  Signal(+) ─[1Ω 1W shunt]─ A0',
      '  Other end of shunt ──────── GND',
      '',
      'I = V / R_shunt',
      'Max safe current: 1 A continuous.',
      '',
      'WARNING: Break the circuit to insert shunt.'
    ].join('\n'),
    ranges: [
      { max: 0.001, label: 'Range: 0 – 1 mA'  },
      { max: 0.1,   label: 'Range: 0 – 100 mA'},
      { max: 1.0,   label: 'Range: 0 – 1 A'   }
    ]
  };

  modeData[MODE.RES] = {
    label:    'Resistance',
    baseUnit: '\u03a9',
    cssClass: 'resist',
    wiring: [
      'Resistance (voltage divider method):',
      '  Arduino 5V ─[10kΩ ref]─ A0 ─[R unknown]─ GND',
      '',
      'Accuracy best from 100 Ω to 100 kΩ.',
      'Disconnect component from circuit',
      'before measuring resistance.',
      '',
      'WARNING: No voltage on component under test.'
    ].join('\n'),
    ranges: [
      { max: 1000,     label: 'Range: 0 – 1 k\u03a9'  },
      { max: 100000,   label: 'Range: 0 – 100 k\u03a9' },
      { max: 1000000,  label: 'Range: 0 – 1 M\u03a9'   }
    ]
  };

  modeData[MODE.CONT] = {
    label:    'Continuity',
    baseUnit: '\u03a9',
    cssClass: 'cont',
    wiring: [
      'Continuity (same circuit as resistance):',
      '  Arduino 5V ─[10kΩ ref]─ A0 ─[path]─ GND',
      '',
      'Closed (beep) when resistance < 50 Ω.',
      '',
      'Probe tip 1 ──────────── A0 side',
      'Probe tip 2 ──────────── GND side'
    ].join('\n'),
    ranges: [
      { max: 50,  label: 'Threshold: < 50 \u03a9' }
    ]
  };

  modeData[MODE.FREQ] = {
    label:    'Frequency',
    baseUnit: 'Hz',
    cssClass: 'freq',
    wiring: [
      'Frequency (Timer1 Input Capture):',
      '  Signal ──────────── D8',
      '  GND ─────────────── GND',
      '',
      'Input: 0 – 5 V logic ONLY.',
      'For 3.3 V signals: use 3.3V on A side',
      'of a voltage divider → D8.',
      '',
      'Range: ~1 Hz to ~8 MHz.',
      'WARNING: Never exceed 5 V on D8.'
    ].join('\n'),
    ranges: [
      { max: 1000,      label: 'Range: DC – 1 kHz'  },
      { max: 100000,    label: 'Range: DC – 100 kHz' },
      { max: 8000000,   label: 'Range: DC – 8 MHz'   }
    ]
  };

  modeData[MODE.DUTY] = {
    label:    'Duty Cycle',
    baseUnit: '%',
    cssClass: 'freq',
    wiring: [
      'Duty Cycle (Timer1 Input Capture):',
      '  Signal ──────────── D8',
      '  GND ─────────────── GND',
      '',
      'Measures high time / period × 100%.',
      'Input: 0 – 5 V logic ONLY.',
      '',
      'WARNING: Never exceed 5 V on D8.'
    ].join('\n'),
    ranges: [
      { max: 100, label: 'Range: 0 – 100 %' }
    ]
  };

  modeData[MODE.DIODE] = {
    label:    'Diode Test',
    baseUnit: 'V',
    cssClass: 'diode',
    wiring: [
      'Diode Test (voltage divider method):',
      '  Arduino 5V ─[10kΩ]─ A0 ─[Anode]─[Cathode]─ GND',
      '',
      'Reads forward voltage (Vf).',
      '  Silicon:  Vf ≈ 0.6 – 0.7 V',
      '  Schottky: Vf ≈ 0.2 – 0.4 V',
      '  LED:      Vf ≈ 1.8 – 3.5 V',
      '',
      'OL = open or reverse biased.'
    ].join('\n'),
    ranges: [
      { max: 2.0, label: 'Range: 0 – 2 V Vf' }
    ]
  };

  /* ── Value conversion per mode ───────────────────────────── */
  /*
   * Each frame value is a scaled integer from the firmware.
   * These functions convert the raw 16-bit integer into a
   * floating point number in the base unit.
   *
   *   DCV:  frame val = millivolts  → divide by 1000 → volts
   *   DCA:  frame val = µA / 10    → multiply by 10 → µA → / 1e6 → A
   *   RES:  frame val = ohms        → already in ohms
   *   CONT: frame val = ohms        → already in ohms
   *   FREQ: frame val = decihertz   → divide by 10 → Hz
   *   DUTY: frame val = tenths of % → divide by 10 → %
   *   DIODE:frame val = millivolts  → divide by 1000 → volts
   */
  function frameToBaseUnit(mode, value) {
    switch (mode) {
      case MODE.DCV:   return value / 1000;
      case MODE.DCA:   return (value * 10) / 1e6;
      case MODE.RES:   return value;
      case MODE.CONT:  return value;
      case MODE.FREQ:  return value / 10;
      case MODE.DUTY:  return value / 10;
      case MODE.DIODE: return value / 1000;
      default:         return value;
    }
  }

  /* ── Auto-range formatting ───────────────────────────────── */
  /*
   * Takes a numeric value in the base unit and returns a
   * formatted string with the appropriate SI prefix and unit.
   *
   * Examples:
   *   formatValue(MODE.DCV,  0.00245) → { display: '2.450', unit: 'mV' }
   *   formatValue(MODE.DCV,  3.14)    → { display: '3.140', unit: 'V'  }
   *   formatValue(MODE.RES,  10500)   → { display: '10.500',unit: 'kΩ' }
   *   formatValue(MODE.FREQ, 1234)    → { display: '1.234', unit: 'kHz'}
   */
  function formatValue(mode, numeric) {
    var abs = Math.abs(numeric);

    switch (mode) {

      /* ── Voltage (V / mV) ── */
      case MODE.DCV:
      case MODE.DIODE:
        if (abs < 1.0) {
          return { display: (numeric * 1000).toFixed(1), unit: 'mV' };
        }
        return { display: numeric.toFixed(3), unit: 'V' };

      /* ── Current (A / mA / µA) ── */
      case MODE.DCA:
        if (abs < 0.001) {
          return { display: (numeric * 1e6).toFixed(1), unit: '\u03bcA' };
        }
        if (abs < 1.0) {
          return { display: (numeric * 1000).toFixed(2), unit: 'mA' };
        }
        return { display: numeric.toFixed(4), unit: 'A' };

      /* ── Resistance (Ω / kΩ / MΩ) ── */
      case MODE.RES:
      case MODE.CONT:
        if (abs < 1000) {
          return { display: abs.toFixed(1), unit: '\u03a9' };
        }
        if (abs < 1000000) {
          return { display: (abs / 1000).toFixed(3), unit: 'k\u03a9' };
        }
        return { display: (abs / 1000000).toFixed(3), unit: 'M\u03a9' };

      /* ── Frequency (Hz / kHz / MHz) ── */
      case MODE.FREQ:
        if (abs < 1000) {
          return { display: abs.toFixed(2), unit: 'Hz' };
        }
        if (abs < 1000000) {
          return { display: (abs / 1000).toFixed(3), unit: 'kHz' };
        }
        return { display: (abs / 1000000).toFixed(4), unit: 'MHz' };

      /* ── Duty cycle (%) ── */
      case MODE.DUTY:
        return { display: numeric.toFixed(1), unit: '%' };

      default:
        return { display: numeric.toFixed(3), unit: '' };
    }
  }

  /* ── Secondary reading ───────────────────────────────────── */
  /*
   * Some modes show a secondary value below the main reading.
   * Frequency shows period. Voltage shows raw mV. Etc.
   */
  function getSecondary(mode, numeric) {
    switch (mode) {
      case MODE.FREQ:
        if (numeric > 0) {
          var period = 1 / numeric;
          if (period < 0.001) {
            return { label: 'Period', value: (period * 1e6).toFixed(2) + ' \u03bcs' };
          }
          if (period < 1) {
            return { label: 'Period', value: (period * 1000).toFixed(3) + ' ms' };
          }
          return { label: 'Period', value: period.toFixed(4) + ' s' };
        }
        return { label: 'Period', value: '—' };

      case MODE.DCV:
        return {
          label: 'Raw mV',
          value: (numeric * 1000).toFixed(1)
        };

      case MODE.DCA:
        return {
          label: 'Power (5V)',
          value: (numeric * 5).toFixed(4) + ' W'
        };

      case MODE.RES:
        if (numeric > 0 && numeric < 1e6) {
          var conductance = 1 / numeric;
          return {
            label: 'Conductance',
            value: (conductance * 1000).toFixed(3) + ' mS'
          };
        }
        return { label: '', value: '' };

      default:
        return { label: '', value: '' };
    }
  }

  /* ── Process incoming frame ──────────────────────────────── */
  /*
   * Called by EEDmmSerial.onMeasurement every time a valid
   * frame arrives. Converts, formats, updates stats and chart.
   */
  function processMeasurement(frame) {
    if (state.hold) return;

    var mode    = frame.mode;
    var numeric = frameToBaseUnit(mode, frame.value);
    var md      = modeData[mode];

    /* Update state */
    state.mode       = mode;
    state.overrange  = frame.overrange;
    state.contClosed = frame.contClosed;
    state.diodeFwd   = frame.diodeFwd;
    state.numericValue = numeric;

    if (md) {
      state.displayMode = md.label;
    }

    if (frame.overrange) {
      state.displayValue = 'OL';
      state.displayUnit  = md ? md.baseUnit : '';
    } else {
      var fmt = formatValue(mode, numeric);
      state.displayValue = fmt.display;
      state.displayUnit  = fmt.unit;
    }

    /* Secondary reading */
    state.secondary = getSecondary(mode, numeric);

    /* Statistics — only track when not overrange */
    if (!frame.overrange) {
      if (numeric < stats.min) stats.min = numeric;
      if (numeric > stats.max) stats.max = numeric;
      stats.sum   += numeric;
      stats.count += 1;
    }

    /* Strip chart */
    chartBuffer.push({
      value:     frame.overrange ? null : numeric,
      timestamp: Date.now()
    });

    if (chartBuffer.length > CHART_POINTS) {
      chartBuffer.shift();
    }

    /* Notify controls module */
    if (window.EEDmmControls && window.EEDmmControls.onUpdate) {
      window.EEDmmControls.onUpdate(state, stats, chartBuffer);
    }
  }

  /* Register with serial module */
  if (window.EEDmmSerial) {
    window.EEDmmSerial.onMeasurement = processMeasurement;
  }

  /* ── Public methods ──────────────────────────────────────── */

  function setMode(modeCode) {
    state.mode = modeCode;
    resetStats();
    chartBuffer = [];
    if (window.EEDmmSerial && window.EEDmmSerial.isConnected()) {
      window.EEDmmSerial.setMode(modeCode);
    }
  }

  function setHold(held) {
    state.hold = held;
    if (window.EEDmmSerial && window.EEDmmSerial.isConnected()) {
      window.EEDmmSerial.sendCmd(held ? 'H' : 'R');
    }
  }

  function resetStats() {
    stats.min   =  Infinity;
    stats.max   = -Infinity;
    stats.sum   = 0;
    stats.count = 0;
  }

  function resetChart() {
    chartBuffer = [];
  }

  function getState()     { return state; }
  function getStats()     { return stats; }
  function getChart()     { return chartBuffer; }
  function getModeData()  { return modeData; }
  function getModeConst() { return MODE; }

  /* Formatted stats for display */
  function getFormattedStats() {
    var mode = state.mode;

    function fmt(n) {
      if (!isFinite(n)) return '—';
      return formatValue(mode, n).display + ' ' + formatValue(mode, n).unit;
    }

    return {
      min: fmt(stats.min),
      max: fmt(stats.max),
      avg: stats.count > 0
        ? fmt(stats.sum / stats.count)
        : '—'
    };
  }

  /* ── Expose ──────────────────────────────────────────────── */
  window.EEDmmEngine = {
    MODE:              MODE,
    setMode:           setMode,
    setHold:           setHold,
    resetStats:        resetStats,
    resetChart:        resetChart,
    getState:          getState,
    getStats:          getStats,
    getChart:          getChart,
    getModeData:       getModeData,
    getModeConst:      getModeConst,
    getFormattedStats: getFormattedStats,
    processMeasurement:processMeasurement,
    formatValue:       formatValue
  };

}());
