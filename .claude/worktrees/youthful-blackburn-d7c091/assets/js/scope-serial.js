/**
 * scope-serial.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Handles all Web Serial communication and binary frame parsing.
 *
 * PROTOCOL (4 bytes per sample):
 *   Byte 0: 0xAB  (frame start marker)
 *   Byte 1: lo_byte  (bits 7–0 of the 10-bit ADC value)
 *   Byte 2: (channel << 2) | hi_2bits
 *             - bits 1–0: bits 9–8 of the ADC value
 *             - bit 2:    channel (0 = CH1, 1 = CH2)
 *   Byte 3: 0xCD  (frame end marker)
 *
 * COMMANDS (single ASCII characters sent to Arduino):
 *   'S' — start streaming
 *   'P' — pause  streaming
 *   'I' — info / handshake
 *   'T' — self-test (human-readable, also works in Serial Monitor)
 *
 * PUBLIC API  (window.EESerial):
 *   connect(baudRate)   — open port and start streaming
 *   disconnect()        — stop streaming and close port
 *   sendCmd(char)       — write one ASCII command byte
 *   runSerialTest()     — send T, switch to text mode for 3 s
 *   isConnected()       — returns boolean
 *   getDiag()           — returns live diagnostic counters object
 *
 * CALLBACKS (set before calling connect):
 *   EESerial.onSample   = function(value, channel) {}
 *   EESerial.onRawText  = function(text) {}   (serial test mode)
 *   EESerial.onStatus   = function(event, detail) {}
 *
 * STATUS EVENTS emitted via onStatus:
 *   'no-serial'      — Web Serial API not available
 *   'connected'      — port opened, detail = baudRate
 *   'streaming'      — S command sent, data expected
 *   'disconnected'   — port closed cleanly
 *   'connect-error'  — failed to open, detail = error message
 *   'read-error'     — error during read loop, detail = message
 *
 * Load order: scope-serial.js → scope-engine.js → scope-render.js
 *             → scope-fft.js → scope-controls.js
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Internal state ──────────────────────────────────────── */
  var port       = null;
  var reader     = null;
  var writer     = null;
  var connected  = false;
  var testMode   = false;   /* true during serial echo test */

  /* Callbacks — set by the consumer before connecting */
  var onSampleCb  = null;
  var onRawTextCb = null;
  var onStatusCb  = null;

  /* ── Diagnostic counters ─────────────────────────────────── */
  /*
   * These are read every second by scope-controls.js to populate
   * the status bar. bytesWindow and framesWindow are zeroed after
   * each read so they represent per-second throughput.
   */
  var diag = {
    bytesTotal:   0,  /* total bytes received since connect */
    bytesWindow:  0,  /* bytes received in current 1s window */
    framesTotal:  0,  /* valid CH1 frames parsed since connect */
    framesWindow: 0,  /* CH1 frames in current 1s window */
    frames2:      0,  /* total CH2 frames parsed since connect */
    syncErrors:   0,  /* bytes that broke frame sync */
    connectTime:  0,  /* Date.now() at connect */
    lastByteTime: 0   /* Date.now() of most recent byte received */
  };

  /* ── Frame parser state machine ──────────────────────────── */
  /*
   * States:
   *   0 — waiting for 0xAB (start marker)
   *   1 — received start, waiting for lo byte
   *   2 — received lo, waiting for hi+channel byte
   *   3 — received value, waiting for 0xCD (end marker)
   */
  var parseState = 0;
  var parseLo    = 0;

  function parseByte(b) {
    diag.bytesTotal++;
    diag.bytesWindow++;
    diag.lastByteTime = Date.now();

    switch (parseState) {

      case 0:
        if (b === 0xAB) {
          parseState = 1;
        } else {
          /* Unexpected byte — lost sync */
          diag.syncErrors++;
        }
        break;

      case 1:
        parseLo    = b;
        parseState = 2;
        break;

      case 2: {
        var ch  = (b >> 2) & 0x01;
        var val = ((b & 0x03) << 8) | parseLo;

        /* Count frames */
        if (ch === 0) {
          diag.framesTotal++;
          diag.framesWindow++;
        } else {
          diag.frames2++;
        }

        /* Deliver to engine */
        if (onSampleCb) onSampleCb(val, ch);

        parseState = 3;
        break;
      }

      case 3:
        if (b === 0xCD) {
          parseState = 0;
        } else {
          /* End marker missing — resync */
          diag.syncErrors++;
          parseState = 0;
        }
        break;
    }
  }

  /* ── Read loop ────────────────────────────────────────────── */
  /*
   * Runs as an async loop after connect(). Reads chunks of bytes
   * from the serial port and routes them to either:
   *   - parseByte()   in normal streaming mode
   *   - onRawTextCb() in serial test mode (human-readable ASCII)
   */
  async function readLoop() {
    var textDecoder = new TextDecoder();
    reader = port.readable.getReader();

    try {
      while (true) {
        var result = await reader.read();
        if (result.done) break;

        var value = result.value;

        if (testMode) {
          /* Decode as UTF-8 text and pass to the test output handler */
          var text = textDecoder.decode(value, { stream: true });
          if (onRawTextCb) onRawTextCb(text);
        } else {
          /* Parse as binary frames */
          for (var i = 0; i < value.length; i++) {
            parseByte(value[i]);
          }
        }
      }
    } catch (err) {
      if (connected) emit('read-error', err.message);
    } finally {
      reader.releaseLock();
    }
  }

  /* ── Status emitter ──────────────────────────────────────── */
  function emit(event, detail) {
    if (onStatusCb) onStatusCb(event, detail);
  }

  /* ── Reset diagnostic counters ───────────────────────────── */
  function resetDiag() {
    diag.bytesTotal   = 0;
    diag.bytesWindow  = 0;
    diag.framesTotal  = 0;
    diag.framesWindow = 0;
    diag.frames2      = 0;
    diag.syncErrors   = 0;
    diag.connectTime  = Date.now();
    diag.lastByteTime = 0;
    parseState        = 0;
    parseLo           = 0;
  }

  /* ── Public: connect ─────────────────────────────────────── */
  async function connect(baudRate) {
    if (!navigator.serial) {
      emit('no-serial');
      return;
    }

    try {
      /* Prompt the user to select a port */
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: baudRate });

      connected = true;
      testMode  = false;
      resetDiag();

      /* Get a writer for sending commands */
      writer = port.writable.getWriter();

      emit('connected', baudRate);

      /* Request device info then start streaming */
      await sendCmd('I');
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      await sendCmd('S');

      emit('streaming');

      /* Start the read loop — runs until disconnect */
      readLoop();

    } catch (err) {
      connected = false;
      emit('connect-error', err.message);
    }
  }

  /* ── Public: disconnect ──────────────────────────────────── */
  async function disconnect() {
    connected = false;
    testMode  = false;

    /* Send pause command before closing */
    if (writer) {
      try {
        await sendCmd('P');
        writer.releaseLock();
      } catch (_) {}
      writer = null;
    }

    if (reader) {
      try { await reader.cancel(); } catch (_) {}
      reader = null;
    }

    if (port) {
      try { await port.close(); } catch (_) {}
      port = null;
    }

    emit('disconnected');
  }

  /* ── Public: sendCmd ─────────────────────────────────────── */
  async function sendCmd(char) {
    if (!writer) return;
    await writer.write(new Uint8Array([char.charCodeAt(0)]));
  }

  /* ── Public: runSerialTest ───────────────────────────────── */
  /*
   * Pauses streaming, sends the T command, switches to text mode
   * for 3 seconds so the Arduino's human-readable response appears
   * in the diagnostics panel, then resumes streaming automatically.
   * Returns false if not connected.
   */
  async function runSerialTest() {
    if (!connected || !writer) return false;

    testMode = true;

    await sendCmd('P');
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
    await sendCmd('T');

    /* Resume streaming after 3 seconds */
    setTimeout(async function () {
      testMode = false;
      if (connected && writer) {
        await sendCmd('S');
        emit('streaming');
      }
    }, 3000);

    return true;
  }

  /* ── Public: isConnected ─────────────────────────────────── */
  function isConnected() {
    return connected;
  }

  /* ── Public: getDiag ─────────────────────────────────────── */
  function getDiag() {
    return diag;
  }

  /* ── Expose public API ───────────────────────────────────── */
  window.EESerial = {
    connect:       connect,
    disconnect:    disconnect,
    sendCmd:       sendCmd,
    runSerialTest: runSerialTest,
    isConnected:   isConnected,
    getDiag:       getDiag,

    /* Callback setters */
    set onSample(fn)  { onSampleCb  = fn; },
    set onRawText(fn) { onRawTextCb = fn; },
    set onStatus(fn)  { onStatusCb  = fn; }
  };

}());
