/**
 * esp32-scope-transport.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Abstracts Web Serial (USB) and WebSocket (WiFi) into a single
 * interface. Everything above this file — engine, render,
 * controls — calls EEScopeTransport without knowing or caring
 * which physical connection is active.
 *
 * FRAME FORMAT (4 bytes, same wire format for both transports):
 *   Byte 0: 0xAB          — start marker
 *   Byte 1: val_lo        — bits 7–0 of 12-bit ADC value
 *   Byte 2: (ch<<4)|hi    — bit 4 = channel (0=CH1, 1=CH2)
 *                           bits 3–0 = bits 11–8 of ADC value
 *   Byte 3: 0xCD          — end marker
 *
 *   Reconstruction:
 *     channel = (byte2 >> 4) & 0x01
 *     value   = ((byte2 & 0x0F) << 8) | byte1
 *     range   = 0–4095  (12-bit)
 *
 * PUBLIC API (window.EEScopeTransport):
 *   connect(mode, options)
 *     mode    = 'usb' | 'websocket'
 *     options = { baudRate }           for USB
 *               { host, port }         for WebSocket
 *
 *   disconnect()
 *   sendCmd(char)
 *   isConnected()
 *   getMode()          returns 'usb' | 'websocket' | null
 *   getDiag()          returns diagnostic counters object
 *   runSerialTest()    sends T, switches to text mode for 3s
 *   ping()             sends a WebSocket ping, measures RTT
 *
 * CALLBACKS (assign before calling connect):
 *   EEScopeTransport.onSample   = function(value, channel) {}
 *   EEScopeTransport.onRawText  = function(text) {}
 *   EEScopeTransport.onStatus   = function(event, detail) {}
 *   EEScopeTransport.onLatency  = function(ms) {}
 *
 * STATUS EVENTS emitted via onStatus:
 *   'no-serial'        Web Serial not available (USB mode)
 *   'connected'        connection established
 *                      detail = { mode, baudRate|host }
 *   'streaming'        S command sent, data expected
 *   'disconnected'     connection closed cleanly
 *   'connect-error'    failed to connect, detail = message
 *   'read-error'       error during receive, detail = message
 *   'ws-connecting'    WebSocket attempting connection
 *   'ws-reconnecting'  WebSocket attempting reconnect
 *
 * INTERNAL ARCHITECTURE:
 *
 *   EEScopeTransport          (this file — public API)
 *         │
 *         ├── UsbTransport    (Web Serial implementation)
 *         └── WsTransport     (WebSocket implementation)
 *
 *   Both inner transports share:
 *     - The same parseByte() frame parser
 *     - The same diag counters object
 *     - The same callback slots
 *
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Shared frame parser ─────────────────────────────────── */
  /*
   * Both USB and WebSocket receive raw bytes and pass them
   * through this single parser. State is reset on each new
   * connection so stale bytes from a previous session cannot
   * corrupt the first frame of the next.
   *
   * States:
   *   0 — waiting for 0xAB (start marker)
   *   1 — received start, waiting for val_lo
   *   2 — received val_lo, waiting for ch|hi byte
   *   3 — received value, waiting for 0xCD (end marker)
   */
  var parseState = 0;
  var parseLo    = 0;

  function resetParser() {
    parseState = 0;
    parseLo    = 0;
  }

  function parseByte(b) {
    diag.bytesTotal++;
    diag.bytesWindow++;
    diag.lastByteTime = Date.now();

    switch (parseState) {

      case 0:
        if (b === 0xAB) {
          parseState = 1;
        } else {
          diag.syncErrors++;
        }
        break;

      case 1:
        parseLo    = b;
        parseState = 2;
        break;

      case 2: {
        /*
         * Byte layout: (ch<<4) | hi_nibble
         *   bit 4     = channel  (0 = CH1,  1 = CH2)
         *   bits 3–0  = bits 11–8 of the 12-bit ADC value
         */
        var ch    = (b >> 4) & 0x01;
        var value = ((b & 0x0F) << 8) | parseLo;

        if (ch === 0) {
          diag.framesTotal++;
          diag.framesWindow++;
        } else {
          diag.frames2++;
        }

        if (onSampleCb) onSampleCb(value, ch);

        parseState = 3;
        break;
      }

      case 3:
        if (b === 0xCD) {
          parseState = 0;
        } else {
          diag.syncErrors++;
          parseState = 0;
        }
        break;
    }
  }

  /* ── Shared diagnostic counters ──────────────────────────── */
  var diag = {
    bytesTotal:   0,
    bytesWindow:  0,
    framesTotal:  0,
    framesWindow: 0,
    frames2:      0,
    syncErrors:   0,
    connectTime:  0,
    lastByteTime: 0,
    latencyMs:    0,   /* WebSocket round-trip, 0 when USB */
    mode:         null /* 'usb' | 'websocket' | null */
  };

  function resetDiag() {
    diag.bytesTotal   = 0;
    diag.bytesWindow  = 0;
    diag.framesTotal  = 0;
    diag.framesWindow = 0;
    diag.frames2      = 0;
    diag.syncErrors   = 0;
    diag.connectTime  = Date.now();
    diag.lastByteTime = 0;
    diag.latencyMs    = 0;
    resetParser();
  }

  /* ── Shared callbacks ────────────────────────────────────── */
  var onSampleCb  = null;
  var onRawTextCb = null;
  var onStatusCb  = null;
  var onLatencyCb = null;

  function emit(event, detail) {
    if (onStatusCb) onStatusCb(event, detail);
  }

  /* ── Shared state ────────────────────────────────────────── */
  var activeMode    = null;   /* 'usb' | 'websocket' */
  var connected     = false;
  var testMode      = false;  /* true during T command echo test */

  /* ═══════════════════════════════════════════════════════════
     USB TRANSPORT (Web Serial)
  ═══════════════════════════════════════════════════════════ */

  var usbPort    = null;
  var usbReader  = null;
  var usbWriter  = null;

  async function usbConnect(options) {
    if (!navigator.serial) {
      emit('no-serial');
      return;
    }

    var baudRate = (options && options.baudRate) ? options.baudRate : 500000;

    try {
      usbPort = await navigator.serial.requestPort();
      await usbPort.open({ baudRate: baudRate });

      connected  = true;
      activeMode = 'usb';
      diag.mode  = 'usb';
      resetDiag();

      usbWriter = usbPort.writable.getWriter();

      emit('connected', { mode: 'usb', baudRate: baudRate });

      /* Handshake then start streaming */
      await usbSendCmd('I');
      await new Promise(function (r) { setTimeout(r, 100); });
      await usbSendCmd('S');

      emit('streaming');

      usbReadLoop();

    } catch (err) {
      connected = false;
      emit('connect-error', err.message);
    }
  }

  async function usbDisconnect() {
    connected = false;

    if (usbWriter) {
      try {
        await usbSendCmd('P');
        usbWriter.releaseLock();
      } catch (_) {}
      usbWriter = null;
    }

    if (usbReader) {
      try { await usbReader.cancel(); } catch (_) {}
      usbReader = null;
    }

    if (usbPort) {
      try { await usbPort.close(); } catch (_) {}
      usbPort = null;
    }

    activeMode = null;
    emit('disconnected');
  }

  async function usbSendCmd(char) {
    if (!usbWriter) return;
    await usbWriter.write(new Uint8Array([char.charCodeAt(0)]));
  }

  async function usbReadLoop() {
    var textDecoder = new TextDecoder();
    usbReader = usbPort.readable.getReader();

    try {
      while (true) {
        var result = await usbReader.read();
        if (result.done) break;

        var bytes = result.value;

        if (testMode) {
          /* Text mode — forward raw bytes as UTF-8 text */
          var text = textDecoder.decode(bytes, { stream: true });
          if (onRawTextCb) onRawTextCb(text);
        } else {
          /* Binary mode — parse frame by frame */
          for (var i = 0; i < bytes.length; i++) {
            parseByte(bytes[i]);
          }
        }
      }
    } catch (err) {
      if (connected) emit('read-error', err.message);
    } finally {
      usbReader.releaseLock();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     WEBSOCKET TRANSPORT (WiFi)
  ═══════════════════════════════════════════════════════════ */

  var ws               = null;
  var wsReconnectTimer = null;
  var wsReconnectDelay = 2000;  /* ms before reconnect attempt */
  var wsMaxReconnects  = 5;
  var wsReconnectCount = 0;
  var wsPingTimer      = null;
  var wsPingSentAt     = 0;

  /*
   * WebSocket receive handler.
   * The ESP32 sends binary frames (ArrayBuffer) for sample data
   * and text frames (string) for command responses and info.
   */
  function wsOnMessage(event) {
    if (typeof event.data === 'string') {
      /* Text frame — command response or info packet */
      if (testMode && onRawTextCb) {
        onRawTextCb(event.data + '\n');
      }
      return;
    }

    /* Binary frame — one or more measurement frames */
    if (event.data instanceof ArrayBuffer) {
      var bytes = new Uint8Array(event.data);
      if (testMode) {
        /* During test mode, try to decode as text */
        var text = new TextDecoder().decode(bytes);
        if (onRawTextCb) onRawTextCb(text);
        return;
      }
      for (var i = 0; i < bytes.length; i++) {
        parseByte(bytes[i]);
      }
      return;
    }

    /* Blob (some browsers) — convert to ArrayBuffer then parse */
    if (event.data instanceof Blob) {
      var reader = new FileReader();
      reader.onload = function () {
        var bytes2 = new Uint8Array(reader.result);
        for (var j = 0; j < bytes2.length; j++) {
          parseByte(bytes2[j]);
        }
      };
      reader.readAsArrayBuffer(event.data);
    }
  }

  function wsConnect(options) {
    var host = (options && options.host) ? options.host : '192.168.4.1';
    var port = (options && options.port) ? options.port : 81;
    var url  = 'ws://' + host + ':' + port;

    emit('ws-connecting', url);

    /*
     * Close any existing socket cleanly before opening a new one.
     * This handles the case where the user clicks Connect again
     * without disconnecting first.
     */
    if (ws) {
      ws.onclose = null;   /* suppress reconnect logic */
      ws.close();
      ws = null;
    }

    ws = new WebSocket(url);

    /*
     * Binary type must be set to 'arraybuffer' before the first
     * message arrives. 'blob' is the default in most browsers
     * but ArrayBuffer is easier to work with synchronously.
     */
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      connected        = true;
      activeMode       = 'websocket';
      diag.mode        = 'websocket';
      wsReconnectCount = 0;
      wsReconnectDelay = 2000;
      resetDiag();

      emit('connected', { mode: 'websocket', host: host, port: port });

      /* Send handshake then start streaming */
      wsSendCmd('I');
      setTimeout(function () { wsSendCmd('S'); }, 100);
      emit('streaming');

      /* Start periodic latency pings */
      startPingTimer();
    };

    ws.onmessage = wsOnMessage;

    ws.onerror = function (err) {
      /* onerror is always followed by onclose — handle there */
    };

    ws.onclose = function (event) {
      var wasConnected = connected;
      connected  = false;
      activeMode = null;

      stopPingTimer();

      if (wasConnected) {
        emit('disconnected');
      }

      /*
       * Auto-reconnect if the close was unexpected (not triggered
       * by the user calling disconnect() which sets ws.onclose=null).
       */
      if (wsReconnectCount < wsMaxReconnects) {
        wsReconnectCount++;
        emit('ws-reconnecting', {
          attempt: wsReconnectCount,
          maxAttempts: wsMaxReconnects,
          delayMs: wsReconnectDelay
        });

        wsReconnectTimer = setTimeout(function () {
          wsConnect(options);
        }, wsReconnectDelay);

        /* Exponential back-off: 2s, 4s, 8s, 16s, 32s */
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 32000);
      } else {
        emit('connect-error', 'WebSocket closed after ' + wsMaxReconnects + ' reconnect attempts.');
      }
    };
  }

  function wsDisconnect() {
    connected  = false;
    activeMode = null;

    stopPingTimer();

    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }

    wsReconnectCount = 0;
    wsReconnectDelay = 2000;

    if (ws) {
      /*
       * Null out onclose BEFORE calling close() so the reconnect
       * logic in onclose does not fire when we close intentionally.
       */
      ws.onclose = null;
      ws.onmessage = null;
      try {
        wsSendCmd('P');
        ws.close(1000, 'user disconnect');
      } catch (_) {}
      ws = null;
    }

    emit('disconnected');
  }

  function wsSendCmd(char) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(char);
  }

  /* ── WebSocket latency ping ──────────────────────────────── */
  /*
   * Every 5 seconds, sends a ping frame and measures the RTT.
   * The ESP32 firmware echoes any unrecognised single character
   * back as a text frame — we send a zero byte as our ping token.
   * A more robust approach would be a dedicated ping command, but
   * the WebSocket protocol has its own ping/pong frames which the
   * browser handles automatically and which are not exposed to JS.
   * Instead we measure the time from sending 'I' to receiving the
   * info JSON response as a proxy for RTT.
   */
  function startPingTimer() {
    stopPingTimer();
    wsPingTimer = setInterval(function () {
      if (!connected || activeMode !== 'websocket') return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      wsPingSentAt = Date.now();

      /* Send I command — the info response acts as our echo */
      wsSendCmd('I');

      /* Measure RTT when the response comes back */
      var origOnMessage = ws.onmessage;
      ws.onmessage = function (event) {
        if (typeof event.data === 'string' && event.data.includes('EElab77')) {
          var rtt = Date.now() - wsPingSentAt;
          diag.latencyMs = rtt;
          if (onLatencyCb) onLatencyCb(rtt);
          /* Restore the normal handler */
          ws.onmessage = wsOnMessage;
        } else {
          /* Not our ping response — pass to normal handler */
          wsOnMessage(event);
          ws.onmessage = wsOnMessage;
        }
      };
    }, 5000);
  }

  function stopPingTimer() {
    if (wsPingTimer) {
      clearInterval(wsPingTimer);
      wsPingTimer = null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SERIAL TEST (both transports)
  ═══════════════════════════════════════════════════════════ */

  async function runSerialTest() {
    if (!connected) return false;

    testMode = true;

    if (activeMode === 'usb') {
      await usbSendCmd('P');
      await new Promise(function (r) { setTimeout(r, 50); });
      await usbSendCmd('T');
    } else {
      wsSendCmd('P');
      setTimeout(function () { wsSendCmd('T'); }, 50);
    }

    /* Resume streaming after 3 seconds */
    setTimeout(async function () {
      testMode = false;
      if (!connected) return;

      if (activeMode === 'usb') {
        await usbSendCmd('S');
      } else {
        wsSendCmd('S');
      }
      emit('streaming');
    }, 3000);

    return true;
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════ */

  /*
   * connect(mode, options)
   *
   * mode = 'usb'
   *   options.baudRate  — baud rate for USB serial (default 500000)
   *
   * mode = 'websocket'
   *   options.host      — ESP32 IP address (default '192.168.4.1')
   *   options.port      — WebSocket port   (default 81)
   */
  async function connect(mode, options) {
    /* Disconnect any existing connection first */
    if (connected) await disconnect();

    if (mode === 'usb') {
      await usbConnect(options);
    } else if (mode === 'websocket') {
      wsConnect(options);
    } else {
      emit('connect-error', 'Unknown transport mode: ' + mode);
    }
  }

  async function disconnect() {
    if (activeMode === 'usb') {
      await usbDisconnect();
    } else if (activeMode === 'websocket') {
      wsDisconnect();
    }
  }

  async function sendCmd(char) {
    if (activeMode === 'usb') {
      await usbSendCmd(char);
    } else if (activeMode === 'websocket') {
      wsSendCmd(char);
    }
  }

  function isConnected() { return connected; }
  function getMode()     { return activeMode; }
  function getDiag()     { return diag; }

  /* ── Expose ──────────────────────────────────────────────── */
  window.EEScopeTransport = {
    connect:       connect,
    disconnect:    disconnect,
    sendCmd:       sendCmd,
    runSerialTest: runSerialTest,
    isConnected:   isConnected,
    getMode:       getMode,
    getDiag:       getDiag,

    /* Callback setters */
    set onSample(fn)  { onSampleCb  = fn; },
    set onRawText(fn) { onRawTextCb = fn; },
    set onStatus(fn)  { onStatusCb  = fn; },
    set onLatency(fn) { onLatencyCb = fn; }
  };

}());
