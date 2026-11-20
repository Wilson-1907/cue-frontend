/* Public announcements from CUE admin → website visitors */
(function () {
  'use strict';
  if (window.__CUE_PUBLIC_NOTICES__) return;
  window.__CUE_PUBLIC_NOTICES__ = true;

  var API = (window.CUE_CONFIG && window.CUE_CONFIG.API_BASE)
    || (window.AP && window.AP.CONFIG && window.AP.CONFIG.API_BASE)
    || (function () {
      var host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000/api/v1';
      return location.origin.replace(/\/$/, '') + '/api/v1';
    })();
  var DISMISS_KEY = 'cue_notice_dismissed';
  var IS_NOTICES_PAGE = /(^|\/)notices\.html?$/i.test(location.pathname);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function dismissedIds() {
    try {
      return JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function dismiss(id) {
    var ids = dismissedIds();
    if (ids.indexOf(id) === -1) ids.push(id);
    try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify(ids)); } catch (_) {}
    var row = document.querySelector('[data-notice-id="' + id + '"]');
    if (row) row.remove();
    var host = document.getElementById('cuePublicNotices');
    if (host && !host.children.length) host.remove();
  }

  function mountBanner(items) {
    var skipped = dismissedIds();
    items = (items || []).filter(function (n) {
      return skipped.indexOf(n.id) === -1;
    });
    if (!items.length) return;

    var host = document.getElementById('cuePublicNotices');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cuePublicNotices';
      var nav = document.querySelector('.container-fluid.position-relative.p-0')
        || document.querySelector('nav.navbar')
        || document.body.firstElementChild;
      if (nav && nav.parentNode) {
        nav.parentNode.insertBefore(host, nav);
      } else {
        document.body.insertBefore(host, document.body.firstChild);
      }
    }

    host.innerHTML = items.slice(0, 2).map(function (n) {
      var sev = String(n.severity || 'INFO').toLowerCase();
      var cls = 'cue-public-notices' + (sev === 'warning' || sev === 'critical' ? ' ' + sev : '');
      var icon = sev === 'critical' ? 'bi-shield-exclamation'
        : sev === 'warning' ? 'bi-exclamation-triangle' : 'bi-megaphone';
      var pin = n.is_pinned ? '<span class="cue-notice-pin">Pinned</span>' : '';
      return '<div class="' + cls + '" data-notice-id="' + esc(n.id) + '">' +
        '<div class="cue-notice-inner">' +
          '<div class="cue-notice-icon"><i class="bi ' + icon + '"></i></div>' +
          '<div class="cue-notice-body">' +
            '<p class="cue-notice-title">' + esc(n.title) + pin + '</p>' +
            '<p class="cue-notice-msg">' + esc(n.message) + '</p>' +
            '<div class="cue-notice-meta">' +
              '<span>CUE announcement · ' + esc(timeAgo(n.created_at)) + '</span>' +
              '<a class="cue-notice-all" href="notices.html">All notices</a>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="cue-notice-dismiss" data-dismiss="' + esc(n.id) + '" aria-label="Dismiss">&times;</button>' +
        '</div>' +
      '</div>';
    }).join('');

    host.querySelectorAll('[data-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        dismiss(Number(btn.getAttribute('data-dismiss')));
      });
    });
  }

  function mountPage(items) {
    var list = document.getElementById('cueNoticesList');
    var empty = document.getElementById('cueNoticesEmpty');
    if (!list) return;

    if (!items || !items.length) {
      list.innerHTML = '';
      if (empty) empty.classList.remove('d-none');
      return;
    }
    if (empty) empty.classList.add('d-none');

    list.innerHTML = items.map(function (n) {
      var sev = String(n.severity || 'INFO').toLowerCase();
      var badge = sev === 'critical' ? 'danger' : sev === 'warning' ? 'warning' : 'primary';
      var icon = sev === 'critical' ? 'bi-shield-exclamation'
        : sev === 'warning' ? 'bi-exclamation-triangle' : 'bi-megaphone';
      var pin = n.is_pinned
        ? '<span class="badge bg-secondary ms-2">Pinned</span>'
        : '';
      return '<article class="cue-notice-card">' +
        '<div class="d-flex gap-3 align-items-start">' +
          '<div class="cue-notice-page-icon text-' + badge + '"><i class="bi ' + icon + '"></i></div>' +
          '<div class="flex-grow-1">' +
            '<div class="d-flex flex-wrap align-items-center gap-2 mb-1">' +
              '<h2 class="h5 mb-0">' + esc(n.title) + '</h2>' +
              '<span class="badge bg-' + badge + '">' + esc(String(n.severity || 'INFO')) + '</span>' +
              pin +
            '</div>' +
            '<p class="mb-2 text-body">' + esc(n.message) + '</p>' +
            '<div class="small text-muted">' + esc(timeAgo(n.created_at)) +
              (n.created_at ? ' · ' + esc(new Date(n.created_at).toLocaleString()) : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  function load() {
    var bases = [API.replace(/\/$/, ''), 'http://127.0.0.1:8000/api/v1', 'http://localhost:8000/api/v1']
      .filter(function (b, i, a) { return a.indexOf(b) === i; });
    var limit = IS_NOTICES_PAGE ? 30 : 5;

    function tryBase(i) {
      if (i >= bases.length) {
        if (IS_NOTICES_PAGE) mountPage([]);
        return;
      }
      fetch(bases[i] + '/notifications/public/?limit=' + limit)
        .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok || !r.j || r.j.success === false) throw new Error('fail');
          var data = r.j.data || r.j;
          var items = Array.isArray(data) ? data : (data.results || []);
          if (IS_NOTICES_PAGE) mountPage(items);
          else mountBanner(items);
        })
        .catch(function () { tryBase(i + 1); });
    }
    tryBase(0);
  }

  if (!document.getElementById('cue-public-notices-css')) {
    var style = document.createElement('style');
    style.id = 'cue-public-notices-css';
    style.textContent =
      '.cue-public-notices{position:relative;z-index:1020;background:linear-gradient(90deg,#0b1220,#0f766e 120%);color:#fff}' +
      '.cue-public-notices.warning{background:linear-gradient(90deg,#7c2d12,#b45309)}' +
      '.cue-public-notices.critical{background:linear-gradient(90deg,#7f1d1d,#b91c1c)}' +
      '.cue-public-notices .cue-notice-inner{max-width:1140px;margin:0 auto;padding:.75rem 1rem;display:flex;gap:.75rem;align-items:flex-start}' +
      '.cue-public-notices .cue-notice-icon{width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.12);display:grid;place-items:center;flex-shrink:0;font-size:1.1rem}' +
      '.cue-public-notices .cue-notice-body{flex:1;min-width:0}' +
      '.cue-public-notices .cue-notice-title{font-weight:700;margin:0 0 .15rem;font-size:.95rem;overflow-wrap:anywhere}' +
      '.cue-public-notices .cue-notice-pin{display:inline-block;margin-left:.5rem;font-size:.65rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:rgba(255,255,255,.2);padding:.15rem .4rem;border-radius:4px;vertical-align:middle}' +
      '.cue-public-notices .cue-notice-msg{margin:0;opacity:.9;font-size:.88rem;line-height:1.4;overflow-wrap:anywhere}' +
      '.cue-public-notices .cue-notice-meta{opacity:.85;font-size:.75rem;margin-top:.35rem;display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center}' +
      '.cue-public-notices .cue-notice-all{color:#fff;font-weight:600;text-decoration:underline;text-underline-offset:2px}' +
      '.cue-public-notices .cue-notice-dismiss{background:transparent;border:0;color:#fff;opacity:.7;font-size:1.4rem;line-height:1;padding:.25rem .45rem;cursor:pointer;flex-shrink:0;min-width:40px;min-height:40px}' +
      '.cue-public-notices .cue-notice-dismiss:hover{opacity:1}' +
      '.cue-public-notices+.cue-public-notices{border-top:1px solid rgba(255,255,255,.12)}' +
      '.cue-notice-card{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:1.15rem 1.2rem;margin-bottom:1rem;box-shadow:0 8px 24px rgba(15,23,42,.04);overflow-wrap:anywhere}' +
      '.cue-notice-page-icon{width:44px;height:44px;border-radius:12px;background:rgba(15,118,110,.08);display:grid;place-items:center;font-size:1.2rem;flex-shrink:0}' +
      '.cue-notices-hero{background:linear-gradient(135deg,#0b1220 0%,#0f766e 100%);color:#fff}' +
      '@media (max-width:575.98px){.cue-public-notices .cue-notice-inner{padding:.7rem .85rem;gap:.55rem}.cue-public-notices .cue-notice-icon{width:34px;height:34px;font-size:.95rem}.cue-notice-page-icon{width:38px;height:38px}}';
    document.head.appendChild(style);
  }

  if (!document.querySelector('link[href*="bootstrap-icons"]')) {
    var bi = document.createElement('link');
    bi.rel = 'stylesheet';
    bi.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css';
    document.head.appendChild(bi);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
