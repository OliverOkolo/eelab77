/**
 * nav.js — EElab77
 * ─────────────────────────────────────────────────────────────
 * Runs on every page. Handles two things:
 *   1. Marks the correct nav link as active based on the
 *      current page filename.
 *   2. Mobile menu open/close toggle.
 *
 * No dependencies. Load this last on every page.
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── Active link ─────────────────────────────────────────── */
  function setActiveLink() {
    const filename = window.location.pathname.split('/').pop() || 'index.html';

    document.querySelectorAll('.nav__link').forEach(function (link) {
      const href = link.getAttribute('href');
      if (href === filename) {
        link.classList.add('is-active');
      } else {
        link.classList.remove('is-active');
      }
    });
  }

  /* ── Mobile menu ─────────────────────────────────────────── */
  function setupMobileMenu() {
    const toggle  = document.querySelector('.nav__mobile-toggle');
    const linksEl = document.querySelector('.nav__links');

    if (!toggle || !linksEl) return;

    let isOpen = false;

    toggle.addEventListener('click', function () {
      isOpen = !isOpen;

      if (isOpen) {
        linksEl.style.display         = 'flex';
        linksEl.style.flexDirection   = 'column';
        linksEl.style.position        = 'absolute';
        linksEl.style.top             = 'var(--nav-height)';
        linksEl.style.left            = '0';
        linksEl.style.right           = '0';
        linksEl.style.background      = 'var(--color-bg-raised)';
        linksEl.style.borderBottom    = '1px solid var(--color-border)';
        linksEl.style.padding         = '12px 16px';
        linksEl.style.zIndex          = 'var(--z-dropdown)';
      } else {
        linksEl.removeAttribute('style');
      }
    });

    /* Close menu when a link is clicked */
    linksEl.querySelectorAll('.nav__link').forEach(function (link) {
      link.addEventListener('click', function () {
        isOpen = false;
        linksEl.removeAttribute('style');
      });
    });

    /* Close menu when clicking outside */
    document.addEventListener('click', function (e) {
      if (isOpen && !toggle.contains(e.target) && !linksEl.contains(e.target)) {
        isOpen = false;
        linksEl.removeAttribute('style');
      }
    });
  }

  /* ── Init ─────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    setActiveLink();
    setupMobileMenu();
  });

}());
