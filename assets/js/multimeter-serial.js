/**
 * multimeter-serial.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Handles all Web Serial communication for the multimeter.
 * Parses the 6-byte measurement frame protocol.
 *
 * PROTOCOL (6 bytes per measurement):
 *   Byte 0: 0xAB        — frame start marker
 *   Byte 1: mode        — measurement mode (0x01–0x07)
 *   Byte 2: val_hi      — high byte of 16-bit value
 *   Byte 3: val_lo      — low byte of 16-bit value
 *   Byte 4: flags       — bit 0=overrange, bit 1=cont closed,
 *                         bit 2=diode forward biased
 *   Byte 5: 0xCD        — frame end marker
 *
 * COMMANDS (single ASCII byte sent to Arduino):
 *   '1'–'7' — set measurement mode
 *   'H'     — hold (pause readings)
 *   'R'     — resume readings
 *   'I'     — info / handshake
 *   'T'     — self-test
 *
 * PUBLIC API (window.EEDmmSerial):
 *   connect(baudRate)    — open port, send I then default mode
 *   disconnect()         — close port cleanly
 *   sendCmd(char)        — send one ASCII command byte
 *   setMode(modeCode)    — send mode command ('1'–'7')
 *   runSerialTest()      — send T, switch to text mode for 3s
 *   isConnected()        — returns boolean
 *   getDiag()            — returns diagnostic counters object
 *
 * CALLBACKS (assign before calling connect):
 *   EEDmmSerial.onMeasurement = function(frame) {}
 *     frame = { mode, value, flags, overrange, contClosed,
 *               diodeFwd, raw }
 *   EEDmmSerial.onRawText  = function(text) {}
 *   EEDmmSerial.onStatus   = function(event, detail) {}
 *
 * STATUS EVENTS:
 *   'no-serial'      — Web Serial API not available
 *   'connected'      — port opened, detail = baudRate
 *   'ready'          — I command sent, mode set
 *   'disconnected'   — port closed
 *   'connect-error'  — failed to open, detail = message
 *   'read-error'     — error in read loop, detail = message
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Internal state ──────────────────────────────────────── */
  var port      = null;
  var reader    = null;
  var writer    = null;
  var connected = false;
  var testMode  = false;

  /* Callbacks */
  var onMeasurementCb = null;
  var onRawTextCb     = null;
  var onStatusCb      = null;

  /* ── Diagnostic counters ─────────────────────────────────── */
  var diag = {
    bytesTotal:    0,
    bytesWindow:   0,
    framesTotal:   0,
    framesWindow:  0,
    syncErrors:    0,
    connectTime:   0,
    lastFrameTime: 0
  };

  /* ── Frame parser state machine ──────────────────────────── */
  /*
   * States:
   *   0 — waiting for 0xAB (start marker)
   *   1 — waiting for mode byte
   *   2 — waiting for val_hi byte
   *   3 — waiting for val_lo byte
   *   4 — waiting for flags byte
   *   5 — waiting for 0xCD (end marker)
   */
  var parseState = 0;
  var parseMode  = 0;
  var parseHi    = 0;
  var parseLo    = 0;
  var parseFlags = 0;

  function parseByte(b) {
    diag.bytesTotal++;
    diag.bytesWindow++;

    switch (parseState) {

      case 0:
        if (b === 0xAB) {
          parseState = 1;
        } else {
          diag.syncErrors++;
        }
        break;

      case 1:
        /* mode byte — must be 0x01–0x07 */
        if (b >= 0x01 && b <= 0x07) {
          parseMode  = b;
          parseState = 2;
        } else {
          /* unexpected byte — resync */
          diag.syncErrors++;
          parseState = 0;
        }
        break;

      case 2:
        parseHi    = b;
        parseState = 3;
        break;

      case 3:
        parseLo    = b;
        parseState = 4;
        break;

      case 4:
        parseFlags = b;
        parseState = 5;
        break;

      case 5:
        if (b === 0xCD) {
          /* Complete valid frame — deliver it */
          var value = (parseHi << 8) | parseLo;

          diag.framesTotal++;
          diag.framesWindow++;
          diag.lastFrameTime = Date.now();

          if (onMeasurementCb) {
            onMeasurementCb({
              mode:       parseMode,
              value:      value,
              flags:      parseFlags,
              overrange:  (parseFlags & 0x01) !== 0,
              contClosed: (parseFlags & 0x02) !== 0,
              diodeFwd:   (parseFlags & 0x04) !== 0,
              raw:        [0xAB, parseMode, parseHi, parseLo, parseFlags, 0xCD]
            });
          }
        } else {
          diag.syncErrors++;
        }
        parseState = 0;
        break;
    }
  }

  /* ── Read loop ───────────────────────────────────────────── */
  async function readLoop() {
    var textDecoder = new TextDecoder();
    reader = port.readable.getReader();

    try {
      while (true) {
        var result = await reader.read();
        if (result.done) break;

        var value = result.value;

        if (testMode) {
          var text = textDecoder.decode(value, { stream: true });
          if (onRawTextCb) onRawTextCb(text);
        } else {
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

  /* ── Reset diagnostics ───────────────────────────────────── */
  function resetDiag() {
    diag.bytesTotal    = 0;
    diag.bytesWindow   = 0;
    diag.framesTotal   = 0;
    diag.framesWindow  = 0;
    diag.syncErrors    = 0;
    diag.connectTime   = Date.now();
    diag.lastFrameTime = 0;
    parseState         = 0;
  }

  /* ── Public: connect ─────────────────────────────────────── */
  async function connect(baudRate) {
    if (!navigator.serial) {
      emit('no-serial');
      return;
    }

    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: baudRate });

      connected = true;
      testMode  = false;
      resetDiag();

      writer = port.writable.getWriter();
      emit('connected', baudRate);

      /* Handshake then set default mode to DC Voltage */
      await sendCmd('I');
      await new Promise(function (r) { setTimeout(r, 100); });
      await sendCmd('1');

      emit('ready');
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

    if (writer) {
      try {
        await sendCmd('H');
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

  /* ── Public: setMode ─────────────────────────────────────── */
  /*
   * Convenience wrapper — sends the single-digit mode command
   * and resets the parser so stale bytes from the previous
   * mode do not confuse the new frame format.
   */
  async function setMode(modeCode) {
    parseState = 0;
    await sendCmd(String(modeCode));
  }

  /* ── Public: runSerialTest ───────────────────────────────── */
  async function runSerialTest() {
    if (!connected || !writer) return false;

    testMode = true;
    await sendCmd('H');
    await new Promise(function (r) { setTimeout(r, 50); });
    await sendCmd('T');

    setTimeout(async function () {
      testMode = false;
      if (connected && writer) {
        await sendCmd('R');
        emit('ready');
      }
    }, 3000);

    return true;
  }

  /* ── Public: isConnected / getDiag ──────────────────────── */
  function isConnected() { return connected; }
  function getDiag()     { return diag; }

  /* ── Expose ──────────────────────────────────────────────── */
  window.EEDmmSerial = {
    connect:       connect,
    disconnect:    disconnect,
    sendCmd:       sendCmd,
    setMode:       setMode,
    runSerialTest: runSerialTest,
    isConnected:   isConnected,
    getDiag:       getDiag,

    set onMeasurement(fn) { onMeasurementCb = fn; },
    set onRawText(fn)     { onRawTextCb     = fn; },
    set onStatus(fn)      { onStatusCb      = fn; }
  };

}());
