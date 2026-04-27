/**
 * eelab-shared.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Utility functions used by multiple instrument pages.
 * Load this file before any instrument-specific scripts.
 *
 * Exposes: window.EELab
 *   addCheck(container, icon, cls, text, sub)  — diagnostic row builder
 *   setBadge(id, text, extraClass)             — badge text + class setter
 *   log(elementId, msg, cls, maxLines)         — timestamped log appender
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Diagnostic check row ────────────────────────────────── */
  /*
   * Appends a styled check-row to `container`.
   * icon     — e.g. '✓', '✗', '⚠'
   * cls      — 'pass' | 'warn' | 'fail'
   * text     — primary message
   * sub      — optional secondary line (smaller, muted)
   */
  function addCheck(container, icon, cls, text, sub) {
    var row = document.createElement('div');
    row.className = 'diag-check';
    row.innerHTML =
      '<div class="diag-check__icon diag-check__icon--' + cls + '">' + icon + '</div>' +
      '<div>' +
        '<div class="diag-check__text">' + text + '</div>' +
        (sub ? '<div class="diag-check__sub">' + sub + '</div>' : '') +
      '</div>';
    container.appendChild(row);
  }

  /* ── Badge helper ────────────────────────────────────────── */
  function setBadge(id, text, extraClass) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'badge' + (extraClass ? ' ' + extraClass : '');
  }

  /* ── Log appender ────────────────────────────────────────── */
  /*
   * Prepends a timestamped line to the element with `elementId`.
   * cls      — optional CSS modifier (e.g. 'ok', 'warn', 'err')
   * maxLines — trim the log to this length (default 80)
   */
  function log(elementId, msg, cls, maxLines) {
    var el = document.getElementById(elementId);
    if (!el) return;
    var limit = maxLines || 80;
    var line  = document.createElement('div');
    line.className   = 'log__line' + (cls ? ' log__line--' + cls : '');
    line.textContent = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
    el.prepend(line);
    if (el.children.length > limit) {
      el.removeChild(el.lastElementChild);
    }
  }

  /* ── Expose ──────────────────────────────────────────────── */
  window.EELab = {
    addCheck: addCheck,
    setBadge: setBadge,
    log:      log
  };

}());
