/* ============================================================
   CUE — main.js (corrected for CUE Django backend)
   ------------------------------------------------------------
   - JWT auth via window.Auth (js/auth.js)
   - Auto-redirect to login when no token
   - API client unwraps {success, message, data}
   - 401 → refresh → retry once → else redirect to login
   - WebSocket connects to /ws/stream/?token=<jwt>
     and subscribes to a named channel group
   - Page controllers registered:
       dashboard, live-monitoring, analytics, notifications,
       user-management, activity-logs, settings, profile,
       devices, leak-detection, valve-control, finance
   ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     0. AUTH GATE — redirect before doing anything else
     Public pages never auto-redirect to login/admin.
     ============================================================ */
  var IS_PUBLIC_PAGE = /(^|\/)(index|home|login|forgot-password|register|contact|about|notices)\.html?$/i.test(location.pathname)
    || /\/$/.test(location.pathname);
  var IS_LOGIN_PAGE = /(^|\/)login\.html?$/i.test(location.pathname);
  var HAS_TOKEN = !!localStorage.getItem('ap_access');

  if (!IS_PUBLIC_PAGE && !HAS_TOKEN) {
    var _depth = (location.pathname.match(/\//g) || []).length;
    location.replace(_depth > 1 ? '../login.html' : 'login.html');
    return;
  }
  if (IS_PUBLIC_PAGE && !IS_LOGIN_PAGE) {
    return;
  }

  /* ============================================================
     1. CONFIG
     ============================================================ */
  var CONFIG = {
    API_BASE: (function () {
      if (window.CUE_CONFIG && window.CUE_CONFIG.API_BASE) return String(window.CUE_CONFIG.API_BASE).replace(/\/$/, '');
      var host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000/api/v1';
      return location.origin.replace(/\/$/, '') + '/api/v1';
    })(),
    WS_BASE: (function () {
      if (window.CUE_CONFIG && window.CUE_CONFIG.WS_BASE) return String(window.CUE_CONFIG.WS_BASE);
      var host = location.hostname || 'localhost';
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      if (host === 'localhost' || host === '127.0.0.1') return proto + host + ':8000/ws/stream/';
      return proto + location.host + '/ws/stream/';
    })(),
    THEME_KEY: 'ap_theme',
    REQUEST_TIMEOUT: 15000,
  };

  /* ============================================================
     2. THEME STORE
     ============================================================ */
  var ThemeStore = {
    get: function () { try { return localStorage.getItem(CONFIG.THEME_KEY) || 'light'; } catch (e) { return 'light'; } },
    set: function (v) { try { localStorage.setItem(CONFIG.THEME_KEY, v); } catch (e) {} },
  };

  /* ============================================================
     3. FORMAT HELPERS
     ============================================================ */
  var fmt = {
    num: function (v, d) {
      if (v == null || isNaN(v)) return '—';
      return Number(v).toFixed(d == null ? 1 : d);
    },
    int: function (v) {
      if (v == null || isNaN(v)) return '—';
      return Number(v).toLocaleString();
    },
    date: function (iso) { return iso ? new Date(iso).toLocaleDateString() : '—'; },
    datetime: function (iso) { return iso ? new Date(iso).toLocaleString() : '—'; },
    timeAgo: function (iso) {
      if (!iso) return '—';
      var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 0) return 'now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    },
    initials: function (name) {
      if (!name) return '—';
      return String(name).trim().split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    },
  };

  /* ============================================================
     4. DOM HELPERS
     ============================================================ */
  function el(id) { return document.getElementById(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = (v == null ? '—' : v); }
  function setHtml(id, v) { var e = el(id); if (e) e.innerHTML = v; }
  function setBadge(id, text, variant) {
    var e = el(id); if (!e) return;
    e.className = 'status-badge ' + (variant || 'secondary');
    e.textContent = (text == null ? '—' : text);
  }
  function setError(id, msg) {
    setHtml(id, '<div class="text-center text-danger small py-4">' + escapeHtml(msg || 'Failed to load') + '</div>');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toArray(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    return x.results || x.items || x.data || x.devices ||
           x.notifications || x.sensors || x.events || [];
  }
  function pagedCount(x) {
    if (!x) return 0;
    if (x.pagination && x.pagination.count != null) return x.pagination.count;
    if (x.count != null) return x.count;
    return toArray(x).length;
  }
  function pageNumber(x) {
    if (x && x.pagination && x.pagination.page != null) return x.pagination.page;
    return 1;
  }
  function pageSize(x) {
    if (x && x.pagination && x.pagination.page_size != null) return x.pagination.page_size;
    return 20;
  }

  /* ============================================================
     5. TOASTS
     ============================================================ */
  var toast = {
    _container: function () {
      var c = el('ap-toast-container');
      if (!c) {
        c = document.createElement('div');
        c.id = 'ap-toast-container';
        c.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem;max-width:340px;';
        document.body.appendChild(c);
      }
      return c;
    },
    show: function (message, type, timeout) {
      var colors = { info: 'primary', success: 'success', warning: 'warning', error: 'danger' };
      var d = document.createElement('div');
      d.className = 'alert alert-' + (colors[type] || 'primary') + ' shadow mb-0 small';
      d.textContent = message;
      this._container().appendChild(d);
      setTimeout(function () { d.remove(); }, timeout || 4000);
    },
    success: function (m) { this.show(m, 'success'); },
    error:   function (m) { this.show(m, 'error', 6000); },
    warn:    function (m) { this.show(m, 'warning'); },
    info:    function (m) { this.show(m, 'info'); },
  };

  /* ============================================================
     6. API CLIENT (JWT + auto-refresh)
     ============================================================ */
  var Api = (function () {
    var TOKEN_KEY = 'ap_access';
    var REFRESH_KEY = 'ap_refresh';

    function buildUrl(path, query) {
      var base = CONFIG.API_BASE.replace(/\/$/, '');
      var url = base + path;
      if (query) {
        var qs = [];
        Object.keys(query).forEach(function (k) {
          var v = query[k];
          if (v !== undefined && v !== null && v !== '') {
            qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
          }
        });
        if (qs.length) url += (url.indexOf('?') === -1 ? '?' : '&') + qs.join('&');
      }
      return url;
    }

    function parseEnvelope(json) {
      if (json && typeof json === 'object' && 'success' in json) {
        if (json.success === false) {
          var err = new Error(json.message || 'Request failed');
          err.errors = json.errors || {};
          throw err;
        }
        return json.data;
      }
      return json;
    }

    function refreshToken() {
      var r = localStorage.getItem(REFRESH_KEY);
      if (!r) return Promise.reject(new Error('No refresh token'));
      return fetch(CONFIG.API_BASE + '/auth/token/refresh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: r }),
      }).then(function (res) {
        return res.json().then(function (j) {
          if (!res.ok || !j.access) throw new Error('Session expired');
          localStorage.setItem(TOKEN_KEY, j.access);
          if (j.refresh) localStorage.setItem(REFRESH_KEY, j.refresh);
          return j.access;
        });
      });
    }

    function forceLogout() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      var depth = (location.pathname.match(/\//g) || []).length;
      location.replace(depth > 1 ? '../login.html' : 'login.html');
    }

    function doRequest(method, path, opts, isRetry) {
      opts = opts || {};
      var url = buildUrl(path, opts.query);
      var headers = { 'Content-Type': 'application/json' };
      var token = localStorage.getItem(TOKEN_KEY);
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, CONFIG.REQUEST_TIMEOUT);

      return fetch(url, {
        method: method,
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      }).then(function (res) {
        clearTimeout(timer);
        if (res.status === 401 && !isRetry) {
          return refreshToken()
            .then(function () { return doRequest(method, path, opts, true); })
            .catch(function () { forceLogout(); throw new Error('Session expired'); });
        }
        return res.text().then(function (text) {
          var json = {};
          try { json = text ? JSON.parse(text) : {}; } catch (e) {}
          if (!res.ok) {
            var err = new Error((json && json.message) || ('HTTP ' + res.status));
            err.status = res.status;
            err.errors = (json && json.errors) || {};
            throw err;
          }
          return parseEnvelope(json);
        });
      }, function (e) {
        clearTimeout(timer);
        throw e;
      });
    }

    return {
      get:   function (p, o) { return doRequest('GET', p, o); },
      post:  function (p, b, o) { o = o || {}; o.body = b; return doRequest('POST', p, o); },
      patch: function (p, b, o) { o = o || {}; o.body = b; return doRequest('PATCH', p, o); },
      del:   function (p, o) { return doRequest('DELETE', p, o); },
    };
  })();

  /* ============================================================
     7. WS CLIENT — /ws/stream/?token=<jwt> + subscribe group
     ============================================================ */
  function WSClient(group, options) {
    options = options || {};
    this.group = group;
    this.onMessage = options.onMessage || function () {};
    this.onStatus  = options.onStatus  || function () {};
    this.reconnect = options.reconnect !== false;
    this.attempts  = 0;
    this.maxDelay  = 30000;
    this.closedByUser = false;
    this.connect();
  }
  WSClient.prototype.connect = function () {
    var self = this;
    var token = localStorage.getItem('ap_access') || '';
    var url = CONFIG.WS_BASE + '?token=' + encodeURIComponent(token);
    try { this.ws = new WebSocket(url); }
    catch (e) { self.onStatus('ERROR'); return; }

    this.ws.onopen = function () {
      self.attempts = 0;
      self.onStatus('OPEN');
      try { self.ws.send(JSON.stringify({ action: 'subscribe', group: self.group })); } catch (e) {}
    };
    this.ws.onmessage = function (e) {
      var data; try { data = JSON.parse(e.data); } catch (_) { return; }
      if (data.event) self.onMessage({ type: data.event, data: data.payload || {} });
      else self.onMessage(data);
    };
    this.ws.onclose = function () {
      self.onStatus('CLOSED');
      if (self.reconnect && !self.closedByUser) self.schedule();
    };
    this.ws.onerror = function () { try { self.ws.close(); } catch (_) {} };
  };
  WSClient.prototype.schedule = function () {
    var self = this;
    var delay = Math.min(1000 * Math.pow(2, this.attempts++), this.maxDelay);
    setTimeout(function () { self.connect(); }, delay);
  };
  WSClient.prototype.close = function () {
    this.closedByUser = true;
    try { this.ws && this.ws.close(); } catch (_) {}
  };

  /* ============================================================
     8. SHELL — theme, sidebar, logout, topbar
     ============================================================ */
  function currentPage() {
    return document.body.getAttribute('data-page')
        || (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var icon = el('themeIcon');
    if (icon) icon.className = theme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-fill';
  }
  function initTheme() { applyTheme(ThemeStore.get()); }

  function initShell() {
    if (!IS_PUBLIC_PAGE) document.body.classList.add('ap-app-shell');

    var toggle = el('themeToggle');
    if (toggle) toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      ThemeStore.set(next);
      window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: next } }));
    });

    var sidebar  = el('ap-sidebar');
    var backdrop = el('ap-backdrop');
    var sToggle  = el('sidebarToggle');
    if (sToggle && sidebar) {
      sToggle.addEventListener('click', function () {
        if (window.innerWidth < 992) {
          sidebar.classList.toggle('show');
          if (backdrop) backdrop.classList.toggle('show');
        } else {
          var app = el('ap-app');
          if (app) app.classList.toggle('collapsed');
        }
      });
    }
    if (backdrop && sidebar) {
      backdrop.addEventListener('click', function () {
        sidebar.classList.remove('show');
        backdrop.classList.remove('show');
      });
    }
    // Close drawer after navigating on phones/tablets
    if (sidebar) {
      sidebar.querySelectorAll('a.ap-nav-item').forEach(function (link) {
        link.addEventListener('click', function () {
          if (window.innerWidth < 992) {
            sidebar.classList.remove('show');
            if (backdrop) backdrop.classList.remove('show');
          }
        });
      });
    }

    ['logoutBtn', 'logoutDropdown'].forEach(function (id) {
      var node = el(id);
      if (node) node.addEventListener('click', function (e) {
        e.preventDefault();
        if (window.Auth) window.Auth.logout();
        else {
          localStorage.removeItem('ap_access');
          localStorage.removeItem('ap_refresh');
          location.replace('../login.html');
        }
      });
    });

    // Session gate + topbar identity from /auth/me/
    if (localStorage.getItem('ap_access') && !IS_PUBLIC_PAGE) {
      Api.get('/auth/me/').then(function (u) {
        if (!u || u.is_active === false || u.can_access_dashboard === false) {
          localStorage.removeItem('ap_access');
          localStorage.removeItem('ap_refresh');
          localStorage.removeItem('ap_user');
          location.replace('login.html');
          return;
        }
        try { localStorage.setItem('ap_user', JSON.stringify(u)); } catch (_) {}
        var name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username || '—';
        setText('topbarUserName', name);
        var av = el('topbarAvatar');
        if (av) av.textContent = fmt.initials(name);
      }).catch(function () {
        localStorage.removeItem('ap_access');
        localStorage.removeItem('ap_refresh');
        localStorage.removeItem('ap_user');
        location.replace('login.html');
      });
    }
  }

  /* ============================================================
     9. ROUTER
     ============================================================ */
  var PAGES = {};
  function register(page, initFn) { PAGES[page] = initFn; }

  /* ============================================================
     10. SHARED BADGE
     ============================================================ */
  function statusBadge(status) {
    var s = (status || '').toUpperCase();
    var v = 'secondary';
    if (['SUCCESS','ONLINE','CONNECTED','RESOLVED','HEALTHY','OK','NORMAL','ACTIVE','EXECUTED','CONFIRMED','OPEN'].indexOf(s) >= 0) v = 'success';
    else if (['WARNING','DEGRADED','PENDING','SUSPECTED','RECEIVED','UNDER_INVESTIGATION'].indexOf(s) >= 0) v = 'warning';
    else if (['FAILED','CRITICAL','OFFLINE','DISCONNECTED','ERROR','EXPIRED','CLOSED'].indexOf(s) >= 0) v = 'danger';
    return '<span class="status-badge ' + v + '">' + escapeHtml(s || '—') + '</span>';
  }

  /* ============================================================
     11. PAGE: dashboard
     ============================================================ */
  register('dashboard', function () {
    var flowChart = null, usageChart = null, ws = null;
    var pollTimer = null, trendTimer = null, trendInFlight = false, lastTrendAt = 0;
    var flowRange = 'live';
    var chartRange = null;
    var FLOW_COLORS = { INLET: '#3b82f6', OUTLET: '#22c55e', OTHER: '#f59e0b' };
    var TREND_MS = { live: 2000, day: 15000, week: 60000, month: 60000 };

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function formatTrendLabel(iso, range) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      if (range === 'month') {
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
      if (range === 'week') {
        return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: range === 'live' ? '2-digit' : undefined });
    }

    function markLive(note) {
      setText('kpiFlowNote', note || ('Live · ' + new Date().toLocaleTimeString()));
      setText('dashboardLastUpdated', 'Live · ' + new Date().toLocaleTimeString());
    }

    function loadOverview(silent) {
      Api.get('/dashboard/overview/').then(function (d) {
        var flow = d.current_water_flow || {};
        setText('kpiFlow', fmt.num(flow.value));
        setText('kpiFlowUnit', flow.unit || 'L/min');
        markLive('Live reading');

        var cons = d.todays_consumption || {};
        setText('kpiConsumption', fmt.num(cons.value));
        setText('kpiConsumptionUnit', cons.unit || 'L');
        setText('kpiConsumptionNote', 'Since midnight');

        var health = (d.system_health || 'UNKNOWN').toString().toUpperCase();
        var hv = health === 'HEALTHY' ? 'success' : health === 'DEGRADED' ? 'warning' : 'danger';
        setBadge('kpiHealthBadge', health, hv);
        var dev = d.devices || {};
        setText('kpiHealthNote', dev.total != null ? (dev.connected || 0) + '/' + dev.total + ' devices online' : '');

        var alerts = d.active_alerts != null ? d.active_alerts : 0;
        setText('kpiAlerts', alerts);
        setText('kpiAlertsNote', (d.unread_notifications || 0) + ' unread');

        setText('dashboardSubtitle',
          'System ' + health.toLowerCase() + ' · ' + alerts + ' active alert' + (alerts === 1 ? '' : 's') + ' · auto-updating');
      }).catch(function (err) {
        console.error('[dashboard] overview failed:', err);
        if (!silent) toast.error('Failed to load dashboard overview');
      });
    }

    function buildChartModel(payload) {
      var seriesIn = [];
      var count = 0;

      if (payload && Array.isArray(payload.series) && payload.series.length) {
        seriesIn = payload.series.filter(function (s) { return (s.data || []).length; });
        count = payload.count || 0;
      } else {
        var rows = Array.isArray(payload) ? payload : (payload && (payload.data || payload.results)) || [];
        seriesIn = rows.length ? [{ name: 'Flow', position: 'OTHER', data: rows.map(function (r) {
          return { timestamp: r.timestamp || r.reading_timestamp, flow_rate: r.flow_rate };
        })}] : [];
        count = rows.length;
      }

      var tsSet = {};
      seriesIn.forEach(function (s) {
        (s.data || []).forEach(function (p) {
          if (p.timestamp) tsSet[p.timestamp] = true;
        });
      });
      var timestamps = Object.keys(tsSet).sort();
      var labels = timestamps.map(function (t) { return formatTrendLabel(t, flowRange); });
      var chartSeries = seriesIn.map(function (s) {
        var byTs = {};
        (s.data || []).forEach(function (p) { byTs[p.timestamp] = Number(p.flow_rate) || 0; });
        return {
          name: s.name || s.sensor || s.position || 'Flow',
          data: timestamps.map(function (t) { return byTs[t] != null ? byTs[t] : null; }),
        };
      });
      var colors = seriesIn.map(function (s) {
        return FLOW_COLORS[s.position] || FLOW_COLORS.OTHER;
      });

      return {
        seriesIn: seriesIn,
        count: count,
        timestamps: timestamps,
        labels: labels,
        chartSeries: chartSeries,
        colors: colors,
        bucket: (payload && payload.bucket) || flowRange,
      };
    }

    function renderFlowChart(payload, forceRemount) {
      var model = buildChartModel(payload);
      var target = el('flowChart');
      if (!target) return;

      if (!model.seriesIn.length || !model.timestamps.length) {
        if (flowChart) { try { flowChart.destroy(); } catch (_) {} flowChart = null; chartRange = null; }
        setHtml('flowChart', '<div class="text-center text-muted small py-5">Waiting for live sensor data…</div>');
        setText('flowTrendRange', 'Listening…');
        return;
      }

      setText('flowTrendRange',
        (flowRange.charAt(0).toUpperCase() + flowRange.slice(1)) +
        ' · auto · ' + model.seriesIn.length + ' sensor' + (model.seriesIn.length === 1 ? '' : 's') +
        ' · ' + (model.count || model.timestamps.length) + ' pts · ' + model.bucket);

      var c = themeColors();
      var options = {
        chart: {
          type: 'area',
          height: 320,
          toolbar: { show: false },
          animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 350 } },
          zoom: { enabled: false },
        },
        series: model.chartSeries,
        xaxis: {
          categories: model.labels,
          labels: {
            style: { colors: c.text },
            rotate: flowRange === 'month' || flowRange === 'week' ? -45 : 0,
            hideOverlappingLabels: true,
            showDuplicates: false,
          },
          tickAmount: Math.min(12, model.labels.length),
        },
        yaxis: { title: { text: 'L/min' }, labels: { style: { colors: c.text } } },
        stroke: { curve: 'smooth', width: 2 },
        colors: model.colors,
        dataLabels: { enabled: false },
        legend: { position: 'top', labels: { colors: c.text } },
        tooltip: { shared: true, y: { formatter: function (v) { return (v == null ? '—' : v) + ' L/min'; } } },
        grid: { borderColor: c.grid },
        theme: { mode: c.mode },
        fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } },
      };

      var remount = forceRemount || !flowChart || chartRange !== flowRange;
      if (remount) {
        if (flowChart) {
          try { flowChart.destroy(); } catch (_) {}
          flowChart = null;
        }
        target.innerHTML = '';
        flowChart = new ApexCharts(target, options);
        flowChart.render();
        chartRange = flowRange;
        return;
      }

      // Soft live update — no flicker / no page refresh
      flowChart.updateOptions({
        xaxis: options.xaxis,
        colors: options.colors,
        theme: options.theme,
        grid: options.grid,
        legend: options.legend,
      }, false, false);
      flowChart.updateSeries(options.series, true);
    }

    function scheduleTrendPolling() {
      if (trendTimer) { clearInterval(trendTimer); trendTimer = null; }
      var ms = TREND_MS[flowRange] || 15000;
      trendTimer = setInterval(function () { loadFlowTrend(true); }, ms);
    }

    function setFlowRange(next) {
      flowRange = next || 'live';
      document.querySelectorAll('#flowTrendRangeBtns [data-flow-range]').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-flow-range') === flowRange);
      });
      scheduleTrendPolling();
      loadFlowTrend(false);
    }

    function loadFlowTrend(silent) {
      if (trendInFlight) return;
      trendInFlight = true;
      Api.get('/dashboard/flow-trend/', { query: { range: flowRange } }).then(function (payload) {
        renderFlowChart(payload, false);
        lastTrendAt = Date.now();
        markLive();
      }).catch(function (err) {
        console.error('[dashboard] flow-trend failed:', err);
        if (!silent) setError('flowChart', 'Could not load flow trend');
      }).then(function () { trendInFlight = false; });
    }

    document.querySelectorAll('#flowTrendRangeBtns [data-flow-range]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setFlowRange(btn.getAttribute('data-flow-range'));
      });
    });

    function renderUsage(rows) {
      rows = Array.isArray(rows) ? rows : (rows.data || rows.results || []);
      if (!rows.length) {
        setHtml('usageChart', '<div class="text-center text-muted small py-5">No data</div>');
        return;
      }
      var labels = rows.map(function (r) { return r.date || ''; });
      var series = rows.map(function (r) { return Number(r.consumption) || 0; });
      var c = themeColors();
      var options = {
        chart: { type: 'donut', height: 320 },
        series: series,
        labels: labels,
        colors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f43f5e'],
        legend: { position: 'bottom', labels: { colors: c.text } },
        dataLabels: { enabled: true, formatter: function (v) { return Number(v).toFixed(0) + '%'; } },
        theme: { mode: c.mode },
      };
      var target = el('usageChart');
      if (!target) return;
      if (usageChart) usageChart.updateOptions(options);
      else { usageChart = new ApexCharts(target, options); usageChart.render(); }
    }

    function loadConsumption() {
      Api.get('/dashboard/consumption-overview/').then(renderUsage)
        .catch(function (err) { console.error('[dashboard] consumption failed:', err); setError('usageChart', 'Could not load consumption'); });
    }

    function loadActivity() {
      Api.get('/dashboard/recent-activity/').then(function (data) {
        var rows = toArray(data);
        var tbody = el('activityTableBody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No recent activity</td></tr>';
          return;
        }
        tbody.innerHTML = rows.slice(0, 5).map(function (r) {
          return '<tr>' +
            '<td>' + escapeHtml(r.action || r.description || r.category || '—') + '</td>' +
            '<td>' + escapeHtml(r.device_name || r.device || '—') + '</td>' +
            '<td>' + statusBadge(r.category || 'INFO') + '</td>' +
            '<td class="text-muted small">' + fmt.timeAgo(r.created_at || r.timestamp) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[dashboard] activity failed:', err); setError('activityTableBody', 'Could not load activity'); });
    }

    function loadConnectivity() {
      Api.get('/monitoring/connectivity/').then(function (data) {
        var rows = (data && data.devices) || toArray(data);
        var box = el('deviceConnectivityList');
        if (!box) return;
        if (!rows.length) { box.innerHTML = '<div class="p-4 text-center text-muted small">No devices</div>'; return; }
        box.innerHTML = rows.map(function (d) {
          return '<div class="d-flex align-items-center justify-content-between p-3 border-bottom" style="border-color:var(--border-color)!important;">' +
            '<div class="d-flex align-items-center gap-2">' +
              '<i class="bi bi-cpu text-primary"></i>' +
              '<div>' +
                '<div class="fw-semibold small">' + escapeHtml(d.device_name || d.device_identifier || '—') + '</div>' +
                '<div class="text-muted" style="font-size:.72rem;">' + fmt.timeAgo(d.last_communication) + '</div>' +
              '</div>' +
            '</div>' +
            statusBadge(d.connection_status) +
          '</div>';
        }).join('');
      }).catch(function (err) { console.error('[dashboard] connectivity failed:', err); setError('deviceConnectivityList', 'Could not load devices'); });
    }

    function connectWS() {
      ws = new WSClient('dashboard', {
        onMessage: function (evt) {
          var type = evt.type, data = evt.data || {};
          if (type === 'flow_reading_updated') {
            var rate = data.inlet_lpm != null ? data.inlet_lpm : data.flow_rate;
            setText('kpiFlow', fmt.num(rate));
            markLive('Live from sensor');
            // Keep chart streaming without a page refresh
            if (flowRange === 'live' && Date.now() - lastTrendAt > 900) {
              loadFlowTrend(true);
            }
          }
          if (type === 'new_notification') {
            var dot = el('topbarUnreadDot'); if (dot) dot.classList.remove('d-none');
          }
        },
        onStatus: function (s) {
          if (s === 'OPEN') markLive('Live · connected');
        },
      });
    }

    window.addEventListener('themeChanged', function () {
      loadFlowTrend(true);
      if (usageChart) loadConsumption();
    });

    // Initial paint + continuous auto-update (no manual refresh needed)
    loadOverview(true);
    setFlowRange('live');
    loadConsumption();
    loadActivity();
    loadConnectivity();
    connectWS();

    pollTimer = setInterval(function () {
      loadOverview(true);
      loadConnectivity();
      if (flowRange !== 'live') loadFlowTrend(true);
    }, 10000);

    window.addEventListener('beforeunload', function () {
      if (pollTimer) clearInterval(pollTimer);
      if (trendTimer) clearInterval(trendTimer);
      if (ws) ws.close();
    });
  });

  /* ============================================================
     12. PAGE: live-monitoring
     ============================================================ */
  register('live-monitoring', function () {
    var liveChart = null, historyChart = null, ws = null, liveTimer = null;
    var liveSamples = [];
    var LIVE_MAX = 60, LIVE_MS = 2000;

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadLive() {
      Api.get('/monitoring/live/').then(function (d) {
        // {pipeline_id, current_flow_rate, consumption_today, volume_unit?, sensors:[...]}
        setText('lm-flow-rate', fmt.num(d.current_flow_rate));
        setText('lm-volume', fmt.num(d.consumption_today));
        setText('lm-volume-unit', d.volume_unit || 'L');
        setText('lm-volume-updated', 'Since midnight');

        var sensors = d.sensors || [];
        var freshCount = sensors.filter(function (s) {
          if (s.fresh === true) return true;
          var ts = s.last_reading && s.last_reading.reading_timestamp;
          if (!ts) return false;
          return (Date.now() - new Date(ts).getTime()) <= 45000;
        }).length;

        // Prefer sensor reading time over wall clock so frozen data is obvious
        var newestTs = null;
        sensors.forEach(function (s) {
          var ts = s.last_reading && s.last_reading.reading_timestamp;
          if (ts && (!newestTs || new Date(ts) > newestTs)) newestTs = new Date(ts);
        });
        setText(
          'lm-flow-updated',
          newestTs
            ? ('Reading ' + newestTs.toLocaleTimeString() + (freshCount ? '' : ' · STALE'))
            : ('Updated ' + new Date().toLocaleTimeString())
        );

        setBadge('lm-device-status', freshCount > 0 ? 'ONLINE' : 'OFFLINE', freshCount > 0 ? 'success' : 'danger');
        setText('lm-device-detail', sensors.length ? sensors.length + ' sensor(s)' : 'No sensors');

        var sensorStatus = !sensors.length ? 'UNKNOWN' : (freshCount === sensors.length ? 'ONLINE' : (freshCount > 0 ? 'DEGRADED' : 'OFFLINE'));
        setBadge('lm-sensor-status', sensorStatus, sensorStatus === 'ONLINE' ? 'success' : sensorStatus === 'DEGRADED' ? 'warning' : 'danger');
        setText('lm-sensor-detail', freshCount + '/' + sensors.length + ' reporting');

        setText('lm-live-indicator', (freshCount ? 'Live' : 'Stale') + ' · ' + new Date().toLocaleTimeString());
        if (freshCount) pushLivePoint(d.current_flow_rate);
        renderSensors(sensors);
      }).catch(function (err) { console.error('[live] live failed:', err); setText('lm-live-indicator', 'Live data unavailable'); });
    }

    function ensureLiveChart() {
      var target = el('liveFlowChart');
      if (!target || liveChart) return;
      var c = themeColors();
      liveChart = new ApexCharts(target, {
        chart: { type: 'line', height: 320, animations: { dynamicAnimation: { speed: 300 } }, toolbar: { show: false } },
        series: [{ name: 'Flow', data: [] }],
        stroke: { curve: 'smooth', width: 2 },
        colors: ['#3b82f6'],
        xaxis: { type: 'datetime', labels: { datetimeUTC: false, style: { colors: c.text } } },
        yaxis: { title: { text: 'L/min' }, min: 0, labels: { style: { colors: c.text } } },
        dataLabels: { enabled: false },
        tooltip: { x: { format: 'HH:mm:ss' } },
        grid: { strokeDashArray: 4, borderColor: c.grid },
        theme: { mode: c.mode },
        noData: { text: 'Waiting for readings…' },
      });
      liveChart.render();
    }

    function pushLivePoint(v) {
      if (v == null) return;
      ensureLiveChart();
      if (!liveChart) return;
      liveSamples.push({ x: Date.now(), y: Number(v) });
      if (liveSamples.length > LIVE_MAX) liveSamples.shift();
      liveChart.updateSeries([{ name: 'Flow', data: liveSamples.slice() }]);
    }

    function renderSensors(sensors) {
      var box = el('sensorReadingsList');
      if (!box) return;
      if (!sensors || !sensors.length) {
        box.innerHTML = '<div class="p-4 text-center text-muted small">No sensors reporting</div>';
        return;
      }
      box.innerHTML = sensors.map(function (s) {
        var last = s.last_reading || {};
        var ts = last.reading_timestamp ? new Date(last.reading_timestamp) : null;
        var online = s.fresh === true || (ts && (Date.now() - ts.getTime()) <= 45000);
        var variant = online ? 'success' : 'danger';
        return '<div class="d-flex align-items-center justify-content-between p-3 border-bottom" style="border-color:var(--border-color)!important;">' +
          '<div class="d-flex align-items-center gap-2">' +
            '<i class="bi bi-broadcast text-primary"></i>' +
            '<div>' +
              '<div class="fw-semibold small">' + escapeHtml(s.sensor || '—') + '</div>' +
              '<div class="text-muted" style="font-size:.72rem;">' + escapeHtml(s.position || '') + (ts ? (' · ' + ts.toLocaleTimeString()) : '') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="text-end">' +
            '<div class="fw-semibold small">' + (last.flow_rate != null ? fmt.num(last.flow_rate) + ' L/min' : '—') + '</div>' +
            '<div class="text-muted" style="font-size:.68rem;">' +
              (Number(last.flow_rate) > 0.05 ? 'flowing' : 'no flow') +
              (last.pulse_count != null ? (' · pulses ' + last.pulse_count) : '') +
            '</div>' +
            '<span class="status-badge ' + variant + '">' + (online ? 'ONLINE' : 'STALE') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function loadHistory() {
      var interval = (el('historyRange') && el('historyRange').value) || 'minute';
      var now = new Date();
      var start = new Date(now);
      if (interval === 'minute') start.setHours(now.getHours() - 1);
      else if (interval === 'hour') start.setHours(now.getHours() - 24);
      else start.setDate(now.getDate() - 30);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

      // /monitoring/history/ takes start & end (ISO datetime strings)
      Api.get('/monitoring/history/', {
        query: {
          start: start.toISOString(),
          end: now.toISOString(),
          page_size: 500,
        },
      }).then(function (data) {
        var rows = toArray(data);
        // backend returns FlowReading objects: {flow_rate, volume, reading_timestamp}
        var labels = rows.map(function (r) { return new Date(r.reading_timestamp).toLocaleTimeString(); });
        var values = rows.map(function (r) { return Number(r.flow_rate) || 0; });
        var c = themeColors();
        var options = {
          chart: { type: 'area', height: 300, toolbar: { show: false } },
          series: [{ name: 'Flow', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          yaxis: { title: { text: 'L/min' }, labels: { style: { colors: c.text } } },
          stroke: { curve: 'smooth', width: 2 },
          colors: ['#22c55e'],
          dataLabels: { enabled: false },
          tooltip: { y: { formatter: function (v) { return v + ' L/min'; } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
          noData: { text: 'No data' },
        };
        var target = el('historyFlowChart');
        if (!target) return;
        if (historyChart) { historyChart.updateOptions(options); historyChart.updateSeries(options.series); }
        else { historyChart = new ApexCharts(target, options); historyChart.render(); }
      }).catch(function (err) { console.error('[live] history failed:', err); setError('historyFlowChart', 'Could not load historical flow'); });
    }

    function loadRecentReadings() {
      Api.get('/monitoring/history/', { query: { page_size: 10 } }).then(function (data) {
        var rows = toArray(data);
        var tbody = el('readingsTableBody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No readings yet</td></tr>';
          return;
        }
        rows = rows.slice(0, 10);
        tbody.innerHTML = rows.map(function (r) {
          return '<tr>' +
            '<td class="text-muted small">' + (r.reading_timestamp ? new Date(r.reading_timestamp).toLocaleTimeString() : '—') + '</td>' +
            '<td>' + (r.flow_rate != null ? fmt.num(r.flow_rate) + ' L/min' : '—') + '</td>' +
            '<td>' + (r.volume != null ? fmt.num(r.volume) + ' L' : '—') + '</td>' +
            '<td>' + statusBadge('OK') + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[live] readings failed:', err); setError('readingsTableBody', 'Could not load readings'); });
    }

    function connectWS() {
      ws = new WSClient('monitoring', {
        onMessage: function (evt) {
          var type = evt.type, data = evt.data || {};
          if (type === 'flow_reading_updated') {
            setText('lm-flow-rate', fmt.num(data.flow_rate));
            setText('lm-flow-updated', 'Live · ' + new Date().toLocaleTimeString());
            setText('lm-live-indicator', 'Live · ' + new Date().toLocaleTimeString());
            pushLivePoint(data.flow_rate);
          }
        },
        onStatus: function (s) {
          if (s === 'OPEN') setText('lm-live-indicator', 'Live · connected');
          if (s === 'CLOSED') setText('lm-live-indicator', 'Reconnecting…');
        },
      });
    }

    window.addEventListener('themeChanged', function () { loadHistory(); });

    var refresh = el('refreshBtn');
    if (refresh) refresh.addEventListener('click', function () { loadLive(); loadHistory(); loadRecentReadings(); });
    var range = el('historyRange');
    if (range) range.addEventListener('change', loadHistory);

    ensureLiveChart();
    loadLive();
    loadHistory();
    loadRecentReadings();
    connectWS();

    liveTimer = setInterval(loadLive, LIVE_MS);
    window.addEventListener('beforeunload', function () {
      if (liveTimer) clearInterval(liveTimer);
      if (ws) ws.close();
    });
  });

  /* ============================================================
     13. PAGE: analytics
     ============================================================ */
  register('analytics', function () {
    var trendChart = null, breakdownChart = null, leakChart = null;

    (function initDates() {
      var now = new Date(), start = new Date();
      start.setDate(now.getDate() - 30);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      var s = el('anStartDate'); if (s) s.value = ymd(start);
      var e = el('anEndDate');   if (e) e.value = ymd(now);
    })();

    function filters() {
      var s = el('anStartDate') && el('anStartDate').value;
      var e = el('anEndDate')   && el('anEndDate').value;
      return { start_date: s || undefined, end_date: e || undefined };
    }
    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadSummary() {
      Api.get('/analytics/summary/', { query: filters() }).then(function (d) {
        // backend: {total_consumption, average_daily_usage, leak_events, period:{start,end}}
        setText('an-total', fmt.num(d.total_consumption, 1));
        setText('an-unit', d.unit || 'L');
        setText('an-total-note', 'Across selected range');
        setText('an-avg', fmt.num(d.average_daily_usage, 1));
        setText('an-avg-note', 'Litres per day');
        setText('an-leaks', fmt.int(d.leak_events));
        setText('an-leaks-note', d.leak_events ? 'Review below' : 'No leak events');
      }).catch(function (err) { console.error('[analytics] summary failed:', err); toast.error('Failed to load summary'); });
    }

    function loadTrend() {
      Api.get('/analytics/consumption-trends/', { query: filters() }).then(function (rows) {
        // backend returns [{date, consumption}]
        rows = Array.isArray(rows) ? rows : toArray(rows);
        var labels = rows.map(function (r) { return r.date || ''; });
        var values = rows.map(function (r) { return Number(r.consumption) || 0; });
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 320, toolbar: { show: false } },
          series: [{ name: 'Consumption', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          yaxis: { title: { text: 'L' }, labels: { style: { colors: c.text } } },
          colors: ['#3b82f6'],
          plotOptions: { bar: { columnWidth: '55%', borderRadius: 4 } },
          dataLabels: { enabled: false },
          tooltip: { y: { formatter: function (v) { return v + ' L'; } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
        };
        var target = el('anTrendChart');
        if (target) {
          if (trendChart) { trendChart.updateOptions(options); trendChart.updateSeries(options.series); }
          else { trendChart = new ApexCharts(target, options); trendChart.render(); }
        }
        if (labels.length && values.length) {
          var maxIdx = 0;
          for (var i = 1; i < values.length; i++) if (values[i] > values[maxIdx]) maxIdx = i;
          setBadge('an-peak', String(labels[maxIdx]), 'info');
          setText('an-peak-note', fmt.num(values[maxIdx]) + ' L');
        }
      }).catch(function (err) { console.error('[analytics] trend failed:', err); setError('anTrendChart', 'Could not load consumption trend'); });
    }

    function loadBreakdown() {
      Api.get('/analytics/usage-breakdown/', { query: filters() }).then(function (rows) {
        // backend returns [{pipeline_id, pipeline, consumption}]
        rows = Array.isArray(rows) ? rows : toArray(rows);
        var labels = rows.map(function (r) { return r.pipeline || ('Pipeline ' + r.pipeline_id); });
        var series = rows.map(function (r) { return Number(r.consumption) || 0; });
        var c = themeColors();
        var options = {
          chart: { type: 'donut', height: 320 },
          series: series, labels: labels,
          colors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'],
          legend: { position: 'bottom', labels: { colors: c.text } },
          dataLabels: { enabled: true, formatter: function (v) { return Number(v).toFixed(0) + '%'; } },
          theme: { mode: c.mode },
        };
        var target = el('anBreakdownChart');
        if (target) {
          if (breakdownChart) breakdownChart.updateOptions(options);
          else { breakdownChart = new ApexCharts(target, options); breakdownChart.render(); }
        }
      }).catch(function (err) { console.error('[analytics] breakdown failed:', err); setError('anBreakdownChart', 'Could not load usage breakdown'); });
    }

    function loadLeakChartAndTable() {
      Api.get('/analytics/leak-events/', { query: filters() }).then(function (d) {
        // backend: {total, by_status:{}, by_severity:{}, events:[LeakEvent]}
        var events = (d && d.events) || [];
        // Chart: bucket by date
        var buckets = {};
        events.forEach(function (r) {
          var dt = (r.started_at || r.detected_at || r.created_at || '').slice(0, 10);
          if (dt) buckets[dt] = (buckets[dt] || 0) + 1;
        });
        var labels = Object.keys(buckets).sort();
        var values = labels.map(function (k) { return buckets[k]; });
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 280, toolbar: { show: false } },
          series: [{ name: 'Leak events', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          colors: ['#ef4444'],
          plotOptions: { bar: { columnWidth: '50%', borderRadius: 4 } },
          dataLabels: { enabled: false },
          yaxis: { title: { text: 'events' }, labels: { style: { colors: c.text } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
        };
        var target = el('anLeakChart');
        if (target) {
          if (leakChart) { leakChart.updateOptions(options); leakChart.updateSeries(options.series); }
          else { leakChart = new ApexCharts(target, options); leakChart.render(); }
        }
        // Table
        var tbody = el('anLeakTableBody');
        var countEl = el('anLeakCount');
        if (countEl) countEl.textContent = ((d && d.total) || events.length) + ' event(s)';
        if (!tbody) return;
        if (!events.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No leak events</td></tr>';
          return;
        }
        tbody.innerHTML = events.slice(0, 20).map(function (r) {
          var sev = (r.severity || 'MEDIUM').toUpperCase();
          return '<tr>' +
            '<td><code>#' + escapeHtml(r.id) + '</code></td>' +
            '<td class="text-muted small">' + fmt.datetime(r.started_at || r.created_at) + '</td>' +
            '<td>' + statusBadge(sev) + '</td>' +
            '<td>' + (r.flow_difference != null ? fmt.num(r.flow_difference) + ' L/min' : '—') + '</td>' +
            '<td>' + statusBadge(r.detection_status || 'SUSPECTED') + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) {
        console.error('[analytics] leak-events failed:', err);
        setError('anLeakChart', 'Could not load leak events');
        setError('anLeakTableBody', 'Could not load leak events');
      });
    }

    function refreshAll() { loadSummary(); loadTrend(); loadBreakdown(); loadLeakChartAndTable(); }

    window.addEventListener('themeChanged', refreshAll);
    var apply = el('anApplyBtn'); if (apply) apply.addEventListener('click', refreshAll);
    refreshAll();
  });

  /* ============================================================
     14. PAGE: notifications
     ============================================================ */
  register('notifications', function () {
    var state = {
      page: 1, pageSize: 20, search: '', severity: '', status: '', type: '', audience: '',
      items: [], total: 0,
    };
    var ws = null, searchTimer = null;

    function loadList() {
      var listEl = el('notifList');
      if (listEl) listEl.innerHTML = '<div class="p-5 text-center text-muted small">Loading notifications…</div>';
      Api.get('/notifications/', {
        query: {
          page: state.page, page_size: state.pageSize,
          search: state.search || undefined,
          severity: state.severity || undefined,
          is_read: state.status === 'READ' ? true : state.status === 'UNREAD' ? false : undefined,
          notification_type: state.type || undefined,
          audience: state.audience || undefined,
        },
      }).then(function (data) {
        var rows = toArray(data);
        var total = pagedCount(data);
        state.items = rows; state.total = total;
        renderList(rows);
        renderPagination(total);
        updateSummary(rows, total);
      }).catch(function (err) {
        console.error('[notif] load failed:', err);
        setError('notifList', 'Could not load notifications');
      });
    }

    function updateSummary(rows, total) {
      var unread = rows.filter(function (n) { return !n.is_read; }).length;
      var publicLive = rows.filter(function (n) {
        return n.audience === 'PUBLIC' && n.is_active !== false;
      }).length;
      var critical = rows.filter(function (n) {
        return String(n.severity || '').toUpperCase() === 'CRITICAL';
      }).length;
      setText('notifSummary', total + ' in view · ' + unread + ' unread · publish to operators or the public website');
      setText('notifKpiTotal', fmt.int(total));
      setText('notifKpiUnread', fmt.int(unread));
      setText('notifKpiPublic', fmt.int(publicLive));
      setText('notifKpiCritical', fmt.int(critical));
      var dot = el('topbarUnreadDot');
      if (dot) {
        if (unread > 0) dot.classList.remove('d-none');
        else dot.classList.add('d-none');
      }
    }

    function severityIcon(sev) {
      var s = (sev || 'INFO').toUpperCase();
      if (s === 'CRITICAL') return { icon: 'bi-shield-exclamation', bg: 'bg-red-light text-red', chip: 'critical' };
      if (s === 'WARNING') return { icon: 'bi-exclamation-triangle', bg: 'bg-orange-light text-orange', chip: 'warning' };
      return { icon: 'bi-info-circle', bg: 'bg-blue-light text-blue', chip: 'info' };
    }

    function renderList(rows) {
      var listEl = el('notifList');
      if (!listEl) return;
      if (!rows.length) {
        listEl.innerHTML = '<div class="p-5 text-center text-muted">No notifications match your filters.</div>';
        return;
      }
      listEl.innerHTML = rows.map(function (n) {
        var isRead = !!n.is_read;
        var sev = String(n.severity || 'INFO').toUpperCase();
        var meta = severityIcon(sev);
        var audience = (n.audience || 'INTERNAL').toUpperCase();
        var cls = 'notif-item'
          + (isRead ? '' : ' is-unread')
          + (audience === 'PUBLIC' ? ' is-public' : '')
          + (sev === 'CRITICAL' ? ' is-critical' : sev === 'WARNING' ? ' is-warning' : '');
        var actions = '';
        if (!isRead) {
          actions += '<button class="btn btn-sm btn-outline-primary" data-action="mark-read" data-id="' + n.id + '">Mark read</button> ';
        }
        if (audience === 'PUBLIC' && n.is_active !== false) {
          actions += '<button class="btn btn-sm btn-outline-secondary" data-action="deactivate" data-id="' + n.id + '">Unpublish</button>';
        }
        return '<article class="' + cls + '">' +
          '<div class="kpi-icon ' + meta.bg + ' flex-shrink-0"><i class="bi ' + meta.icon + '"></i></div>' +
          '<div class="notif-item-body">' +
            '<div class="d-flex justify-content-between gap-3 align-items-start">' +
              '<h3 class="notif-item-title">' + escapeHtml(n.title || n.notification_type || 'Notice') +
                (n.is_pinned ? ' <i class="bi bi-pin-angle-fill text-warning" title="Pinned"></i>' : '') +
              '</h3>' +
              '<span class="text-muted small text-nowrap">' + fmt.timeAgo(n.created_at) + '</span>' +
            '</div>' +
            (n.message ? '<p class="notif-item-msg">' + escapeHtml(n.message) + '</p>' : '') +
            '<div class="notif-meta">' +
              '<span class="notif-chip ' + (audience === 'PUBLIC' ? 'public' : 'internal') + '">' +
                (audience === 'PUBLIC' ? 'Public' : 'Internal') + '</span>' +
              '<span class="notif-chip ' + meta.chip + '">' + escapeHtml(sev) + '</span>' +
              '<span class="notif-chip">' + escapeHtml(n.notification_type || 'SYSTEM') + '</span>' +
              (n.created_by_username ? '<span class="notif-chip">by ' + escapeHtml(n.created_by_username) + '</span>' : '') +
              (!isRead ? '<span class="badge bg-primary rounded-pill">New</span>' : '') +
              (n.is_active === false ? '<span class="notif-chip">Inactive</span>' : '') +
            '</div>' +
            (actions ? '<div class="mt-2 d-flex gap-2 flex-wrap">' + actions + '</div>' : '') +
          '</div>' +
        '</article>';
      }).join('');

      listEl.querySelectorAll('[data-action="mark-read"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          Api.patch('/notifications/' + btn.getAttribute('data-id') + '/read/', {}).then(function () {
            toast.success('Marked as read'); loadList();
          }).catch(function (err) { toast.error(err.message || 'Could not mark as read'); });
        });
      });
      listEl.querySelectorAll('[data-action="deactivate"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          Api.post('/notifications/' + btn.getAttribute('data-id') + '/deactivate/', {}).then(function () {
            toast.success('Removed from public site'); loadList();
          }).catch(function (err) { toast.error(err.message || 'Could not unpublish'); });
        });
      });
    }

    function renderPagination(total) {
      var info = el('notifPageInfo'), pag = el('notifPagination');
      if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + '–' + to + ' of ' + total;

      var html = '<li class="page-item ' + (state.page === 1 ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page - 1) + '">Previous</a></li>';
      for (var p = 1; p <= pages; p++) {
        if (pages > 7 && Math.abs(p - state.page) > 2 && p !== 1 && p !== pages) {
          if (p === 2 || p === pages - 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
          continue;
        }
        html += '<li class="page-item ' + (p === state.page ? 'active' : '') + '"><a class="page-link" href="#" data-page="' + p + '">' + p + '</a></li>';
      }
      html += '<li class="page-item ' + (state.page === pages ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page + 1) + '">Next</a></li>';
      pag.innerHTML = html;
      pag.querySelectorAll('[data-page]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var p = Number(a.getAttribute('data-page'));
          if (!p || p === state.page || p < 1 || p > pages) return;
          state.page = p; loadList();
        });
      });
    }

    function markAllRead() {
      var btn = el('markAllReadBtn'); if (btn) btn.disabled = true;
      Api.post('/notifications/mark-all-read/', {}).then(function () {
        toast.success('All marked as read'); loadList();
      }).catch(function (err) { toast.error(err.message || 'Failed'); })
        .finally(function () { if (btn) btn.disabled = false; });
    }

    function publishNotice() {
      var title = (el('notifTitle') && el('notifTitle').value || '').trim();
      var message = (el('notifMessage') && el('notifMessage').value || '').trim();
      if (!title || !message) {
        toast.warn('Title and message are required');
        return;
      }
      var btn = el('notifPublishBtn');
      if (btn) btn.disabled = true;
      Api.post('/notifications/create/', {
        title: title,
        message: message,
        audience: (el('notifAudience') && el('notifAudience').value) || 'PUBLIC',
        severity: (el('notifSeverity') && el('notifSeverity').value) || 'INFO',
        is_pinned: !!(el('notifPinned') && el('notifPinned').checked),
      }).then(function () {
        toast.success('Notification published');
        if (el('notifTitle')) el('notifTitle').value = '';
        if (el('notifMessage')) el('notifMessage').value = '';
        if (el('notifPinned')) el('notifPinned').checked = false;
        var box = el('notifCompose');
        if (box && window.bootstrap) {
          var c = bootstrap.Collapse.getOrCreateInstance(box, { toggle: false });
          c.hide();
        }
        state.page = 1;
        loadList();
      }).catch(function (err) {
        toast.error(err.message || 'Publish failed');
      }).finally(function () {
        if (btn) btn.disabled = false;
      });
    }

    function connectWS() {
      ws = new WSClient('notifications', {
        onMessage: function (evt) {
          if (evt.type === 'new_notification') {
            toast.info((evt.data && evt.data.title) || 'New notification');
            if (state.page === 1) loadList();
          }
        },
      });
    }

    var search = el('notifSearch');
    if (search) search.addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.search = e.target.value.trim();
        state.page = 1;
        loadList();
      }, 350);
    });
    [
      ['notifSeverityFilter', 'severity'],
      ['notifStatusFilter', 'status'],
      ['notifCategoryFilter', 'type'],
      ['notifAudienceFilter', 'audience'],
    ].forEach(function (pair) {
      var node = el(pair[0]);
      if (node) node.addEventListener('change', function (e) {
        state[pair[1]] = e.target.value;
        state.page = 1;
        loadList();
      });
    });
    var mAll = el('markAllReadBtn'); if (mAll) mAll.addEventListener('click', markAllRead);
    var pub = el('notifPublishBtn'); if (pub) pub.addEventListener('click', publishNotice);

    loadList();
    connectWS();
  });

  /* ============================================================
     15. PAGE: user-management (in-app — /auth/users/)
     ============================================================ */
  register('user-management', function () {
    var state = { search: '', role: '', status: '', users: [] };
    var modal = null;

    function fullName(u) {
      return ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username;
    }

    function loadUsers() {
      var tbody = el('umTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading users…</td></tr>';
      Api.get('/auth/users/', {
        query: {
          search: state.search || undefined,
          role: state.role || undefined,
          status: state.status || undefined,
        },
      }).then(function (data) {
        var rows = (data && data.users) || toArray(data);
        var summary = (data && data.summary) || {};
        state.users = rows;
        setText('umTotal', fmt.int(summary.total != null ? summary.total : rows.length));
        setText('umActive', fmt.int(summary.active != null ? summary.active : rows.filter(function (u) { return u.is_active; }).length));
        setText('umAdmins', fmt.int(summary.admins != null ? summary.admins : rows.filter(function (u) { return u.role === 'ADMIN'; }).length));
        setText('umInactive', fmt.int(summary.inactive != null ? summary.inactive : rows.filter(function (u) { return !u.is_active; }).length));
        setText('umPageInfo', rows.length + ' account' + (rows.length !== 1 ? 's' : ''));
        renderUsers(rows);
      }).catch(function (err) {
        toast.error(err.message || 'Could not load users');
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">' + escapeHtml(err.message || 'Failed') + '</td></tr>';
      });
    }

    function renderUsers(rows) {
      var tbody = el('umTableBody'); if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No users found</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (u) {
        var name = fullName(u);
        return '<tr>' +
          '<td><div class="d-flex align-items-center gap-2">' +
            '<div class="bg-primary text-white rounded-circle d-flex align-items-center justify-content-center" style="width:32px;height:32px;font-size:.75rem;font-weight:bold;">' +
              escapeHtml(fmt.initials(name)) + '</div>' +
            '<div><div class="fw-semibold">' + escapeHtml(name) + '</div>' +
            '<div class="small text-muted">@' + escapeHtml(u.username) + ' · ' + escapeHtml(u.email || '—') + '</div></div>' +
          '</div></td>' +
          '<td>' + statusBadge(u.role || 'VIEWER') + '</td>' +
          '<td>' + statusBadge(u.is_active ? 'ACTIVE' : 'INACTIVE') + '</td>' +
          '<td class="small text-muted">' + (u.last_login ? fmt.timeAgo(u.last_login) : 'Never') + '</td>' +
          '<td class="text-nowrap">' +
            '<button class="btn btn-sm btn-outline-primary me-1" data-act="edit" data-id="' + u.id + '">Edit</button>' +
            (u.is_active
              ? '<button class="btn btn-sm btn-outline-danger" data-act="deactivate" data-id="' + u.id + '">Deactivate</button>'
              : '<button class="btn btn-sm btn-outline-success" data-act="activate" data-id="' + u.id + '">Activate</button>') +
          '</td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = Number(btn.getAttribute('data-id'));
          var act = btn.getAttribute('data-act');
          var user = state.users.find(function (x) { return x.id === id; });
          if (!user) return;
          if (act === 'edit') openModal(user);
          if (act === 'deactivate' || act === 'activate') {
            Api.patch('/auth/users/' + id + '/', { is_active: act === 'activate' }).then(function () {
              toast.success(act === 'activate' ? 'User activated' : 'User deactivated');
              loadUsers();
            }).catch(function (err) { toast.error(err.message || 'Update failed'); });
          }
        });
      });
    }

    function openModal(user) {
      var form = el('userForm'); if (!form) return;
      form.reset();
      el('userFormId').value = user ? user.id : '';
      el('userFormTitle').textContent = user ? 'Edit User' : 'Add New User';
      form.elements.full_name.value = user ? fullName(user) : '';
      form.elements.username.value = user ? (user.username || '') : '';
      form.elements.email.value = user ? (user.email || '') : '';
      form.elements.role.value = user ? (user.role || 'VIEWER') : 'VIEWER';
      form.elements.password.value = '';
      form.elements.password.required = !user;
      if (!modal && window.bootstrap) {
        modal = new bootstrap.Modal(el('userFormModal'));
      }
      if (modal) modal.show();
      else if (el('userFormModal')) el('userFormModal').classList.add('show');
    }

    function saveUser(e) {
      e.preventDefault();
      var form = el('userForm');
      var id = el('userFormId').value;
      var full = (form.elements.full_name.value || '').trim();
      var parts = full.split(/\s+/);
      var payload = {
        username: form.elements.username.value.trim(),
        email: form.elements.email.value.trim(),
        first_name: parts[0] || '',
        last_name: parts.slice(1).join(' ') || '',
        role: form.elements.role.value,
      };
      var pwd = form.elements.password.value;
      if (pwd) payload.password = pwd;
      if (!id && !pwd) { toast.warn('Password is required for new users'); return; }

      var req = id
        ? Api.patch('/auth/users/' + id + '/', payload)
        : Api.post('/auth/users/', payload);
      var submit = el('userFormSubmit');
      if (submit) submit.disabled = true;
      req.then(function () {
        toast.success(id ? 'User updated' : 'User created');
        if (modal) modal.hide();
        loadUsers();
      }).catch(function (err) {
        toast.error(err.message || 'Save failed');
      }).finally(function () {
        if (submit) submit.disabled = false;
      });
    }

    var addBtn = el('addUserBtn');
    if (addBtn) addBtn.addEventListener('click', function () { openModal(null); });
    var form = el('userForm');
    if (form) form.addEventListener('submit', saveUser);
    var search = el('umSearch');
    if (search) search.addEventListener('input', function (e) {
      state.search = e.target.value.trim();
      loadUsers();
    });
    var roleF = el('umRoleFilter');
    if (roleF) roleF.addEventListener('change', function (e) { state.role = e.target.value; loadUsers(); });
    var stF = el('umStatusFilter');
    if (stF) stF.addEventListener('change', function (e) { state.status = e.target.value; loadUsers(); });

    loadUsers();
  });

  /* ============================================================
     16. PAGE: activity-logs
     ============================================================ */
  register('activity-logs', function () {
    var state = { page: 1, pageSize: 20, startDate: '', endDate: '', category: '', userId: '', rows: [], total: 0 };

    (function initDates() {
      var now = new Date(), start = new Date();
      start.setDate(now.getDate() - 7);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      var s = el('alStartDate'); if (s) s.value = ymd(start);
      var e = el('alEndDate');   if (e) e.value = ymd(now);
      state.startDate = ymd(start); state.endDate = ymd(now);
    })();

    function loadUsersForFilter() {
      var sel = el('alUserFilter'); if (!sel) return;
      Api.get('/auth/users/').then(function (data) {
        var rows = (data && data.users) || toArray(data);
        rows.forEach(function (u) {
          var opt = document.createElement('option');
          opt.value = String(u.id);
          opt.textContent = u.username || ('User #' + u.id);
          sel.appendChild(opt);
        });
      }).catch(function () {
        Api.get('/activity-logs/', { query: { page_size: 100 } }).then(function (data) {
          var seen = {};
          toArray(data).forEach(function (r) {
            if (!r.user || seen[r.user]) return;
            seen[r.user] = true;
            var opt = document.createElement('option');
            opt.value = String(r.user);
            opt.textContent = r.username || ('User #' + r.user);
            sel.appendChild(opt);
          });
        }).catch(function () {});
      });
    }

    function humanAction(action) {
      return String(action || '')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }

    function actionStatus(action) {
      var a = String(action || '').toUpperCase();
      if (/FAIL|ERROR|DENIED/.test(a)) return 'FAILED';
      if (/PENDING|REQUESTED/.test(a)) return 'PENDING';
      if (/LOGIN|LOGOUT|EXECUTED|SUCCESS|OPEN|CLOSE|CREATED|UPDATED/.test(a)) return 'OK';
      return 'RECORDED';
    }

    function loadLogs() {
      var tbody = el('alTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading activity…</td></tr>';

      var query = {
        page: state.page,
        page_size: state.pageSize,
        category: state.category || undefined,
        user: state.userId || undefined,
        ordering: '-created_at',
      };
      if (state.startDate) query['created_at__gte'] = state.startDate;
      if (state.endDate) query['created_at__lte'] = state.endDate + 'T23:59:59Z';

      Api.get('/activity-logs/', { query: query }).then(function (data) {
        var rows = toArray(data);
        var total = pagedCount(data);
        state.rows = rows; state.total = total;
        renderTable(rows);
        renderPagination(total);
        setText('alCount', total + ' event' + (total !== 1 ? 's' : ''));
        setText('alSubtitle', 'Audit trail · ' + total + ' recorded event' + (total !== 1 ? 's' : ''));
      }).catch(function (err) {
        console.error('[activity] load failed:', err);
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-4">' +
            escapeHtml(err.message || 'Could not load activity logs') + '</td></tr>';
        }
      });
    }

    function renderTable(rows) {
      var tbody = el('alTableBody'); if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-5">No activity for this filter range.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        var ts = r.created_at || r.timestamp;
        var name = r.username || r.user_name || 'System';
        var category = (r.category || 'SYSTEM').toUpperCase();
        var desc = r.description || humanAction(r.action) || '—';
        var isSystem = !r.user;
        var avatar = isSystem
          ? '<div class="bg-secondary text-white rounded-circle d-flex align-items-center justify-content-center" style="width:28px;height:28px;"><i class="bi bi-cpu" style="font-size:.7rem;"></i></div>'
          : '<div class="bg-primary text-white rounded-circle d-flex align-items-center justify-content-center" style="width:28px;height:28px;font-size:.7rem;font-weight:bold;">' + escapeHtml(fmt.initials(name)) + '</div>';
        return '<tr>' +
          '<td class="text-muted small text-nowrap">' + (ts ? fmt.datetime(ts) : '—') + '</td>' +
          '<td><div class="d-flex align-items-center gap-2">' + avatar +
            '<div><div class="fw-semibold">' + escapeHtml(name) + '</div>' +
            (r.device_name ? '<div class="small text-muted">' + escapeHtml(r.device_name) + '</div>' : '') +
          '</div></div></td>' +
          '<td>' + statusBadge(category) + '</td>' +
          '<td><div>' + escapeHtml(desc) + '</div>' +
            (r.action && r.description ? '<div class="small text-muted">' + escapeHtml(humanAction(r.action)) + '</div>' : '') +
          '</td>' +
          '<td>' + statusBadge(actionStatus(r.action)) + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderPagination(total) {
      var info = el('alPageInfo'), pag = el('alPagination'); if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + ' to ' + to + ' of ' + total + ' entries';

      var html = '<li class="page-item ' + (state.page === 1 ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page - 1) + '">Previous</a></li>';
      for (var p = 1; p <= pages; p++) {
        if (pages > 7 && Math.abs(p - state.page) > 2 && p !== 1 && p !== pages) {
          if (p === 2 || p === pages - 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
          continue;
        }
        html += '<li class="page-item ' + (p === state.page ? 'active' : '') + '"><a class="page-link" href="#" data-page="' + p + '">' + p + '</a></li>';
      }
      html += '<li class="page-item ' + (state.page === pages ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page + 1) + '">Next</a></li>';
      pag.innerHTML = html;

      pag.querySelectorAll('[data-page]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var p = Number(a.getAttribute('data-page'));
          if (!p || p === state.page || p < 1 || p > pages) return;
          state.page = p; loadLogs();
        });
      });
    }

    function applyFilters() {
      state.startDate = (el('alStartDate') && el('alStartDate').value) || '';
      state.endDate   = (el('alEndDate')   && el('alEndDate').value)   || '';
      state.category  = (el('alCategoryFilter') && el('alCategoryFilter').value) || '';
      state.userId    = (el('alUserFilter')     && el('alUserFilter').value)     || '';
      state.page = 1; loadLogs();
    }
    function resetFilters() {
      var now = new Date(), start = new Date();
      start.setDate(now.getDate() - 7);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      if (el('alStartDate')) el('alStartDate').value = ymd(start);
      if (el('alEndDate'))   el('alEndDate').value   = ymd(now);
      if (el('alCategoryFilter')) el('alCategoryFilter').value = '';
      if (el('alUserFilter'))     el('alUserFilter').value = '';
      state.startDate = ymd(start); state.endDate = ymd(now);
      state.category = ''; state.userId = ''; state.page = 1;
      loadLogs();
    }

    var ap = el('alApplyBtn'); if (ap) ap.addEventListener('click', applyFilters);
    var rs = el('alResetBtn'); if (rs) rs.addEventListener('click', resetFilters);

    loadUsersForFilter();
    loadLogs();
  });

  /* ============================================================
     17. PAGE: settings
     Backend SystemSettings fields:
       normal_flow_rate_threshold, maximum_flow_rate, sensor_difference_tolerance,
       leak_trigger_flow_difference, leak_trigger_percentage, leak_detection_duration,
       automatic_leak_detection, automatic_valve_shutdown, device_heartbeat_timeout
     ============================================================ */
  register('settings', function () {
    function loadAll() {
      setText('settingsSubtitle', 'Loading settings…');
      Promise.all([
        Api.get('/settings/').catch(function () { return null; }),
        Api.get('/settings/thresholds/').catch(function () { return null; }),
        Api.get('/settings/leak-detection/').catch(function () { return null; }),
        Api.get('/settings/automation/').catch(function () { return null; }),
      ]).then(function (results) {
        var merged = Object.assign({}, results[0] || {}, results[1] || {}, results[2] || {}, results[3] || {});
        fillForm(merged);
        setText('settingsSubtitle', 'Loaded ' + new Date().toLocaleTimeString());
        var api = el('settingsApiUrl'); if (api) api.value = CONFIG.API_BASE;
      }).catch(function (err) { console.error('[settings] load failed:', err); toast.error('Failed to load settings'); });
    }

    function fillForm(obj) {
      var form = el('settingsForm'); if (!form) return;
      Array.prototype.forEach.call(form.elements, function (field) {
        if (!field.name) return;
        if (field.type === 'checkbox') field.checked = !!obj[field.name];
        else if (obj[field.name] != null) field.value = obj[field.name];
      });
    }

    function collectForm() {
      var form = el('settingsForm'); if (!form) return {};
      var out = {};
      Array.prototype.forEach.call(form.elements, function (field) {
        if (!field.name) return;
        if (field.type === 'checkbox') out[field.name] = !!field.checked;
        else if (field.type === 'number') out[field.name] = field.value === '' ? null : Number(field.value);
        else if (field.name === 'settingsApiUrl') return;
        else out[field.name] = field.value;
      });
      return out;
    }

    function saveAll() {
      var btn = el('settingsSaveBtn'), txt = el('settingsSaveText'), sp = el('settingsSaveSpinner');
      var payload = collectForm();

      // Split payload across the three PATCH endpoints based on which keys they accept
      var thresholdKeys = ['normal_flow_rate_threshold', 'maximum_flow_rate', 'sensor_difference_tolerance'];
      var leakKeys = ['leak_trigger_flow_difference', 'leak_trigger_percentage', 'leak_detection_duration', 'automatic_leak_detection'];
      var autoKeys = ['automatic_valve_shutdown', 'device_heartbeat_timeout'];

      var t = {}, l = {}, a = {};
      Object.keys(payload).forEach(function (k) {
        if (thresholdKeys.indexOf(k) >= 0) t[k] = payload[k];
        else if (leakKeys.indexOf(k) >= 0) l[k] = payload[k];
        else if (autoKeys.indexOf(k) >= 0) a[k] = payload[k];
      });

      var calls = [];
      if (Object.keys(t).length) calls.push(Api.patch('/settings/thresholds/', t));
      if (Object.keys(l).length) calls.push(Api.patch('/settings/leak-detection/', l));
      if (Object.keys(a).length) calls.push(Api.patch('/settings/automation/', a));

      if (!calls.length) { toast.info('No changes to save'); return; }

      btn.disabled = true; if (txt) txt.textContent = 'Saving…'; if (sp) sp.classList.remove('d-none');
      Promise.all(calls).then(function () {
        toast.success('Settings saved'); loadAll();
      }).catch(function (err) {
        var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
        toast.error(d || err.message || 'Save failed');
      }).finally(function () {
        btn.disabled = false; if (txt) txt.textContent = 'Save Changes'; if (sp) sp.classList.add('d-none');
      });
    }

    var sv = el('settingsSaveBtn'); if (sv) sv.addEventListener('click', saveAll);
    var rl = el('settingsReloadBtn'); if (rl) rl.addEventListener('click', loadAll);
    loadAll();
  });

  /* ============================================================
     18. PAGE: profile
     ============================================================ */
  register('profile', function () {
    function loadProfile() {
      Api.get('/auth/me/').then(function (u) {
        var name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username || '—';
        setText('profileAvatar', fmt.initials(name));
        setText('profileName', name);
        setText('profileEmail', u.email || '—');

        var role = (u.role || 'VIEWER').toUpperCase();
        var roleLabel = role === 'ADMIN' ? 'Administrator' : role === 'OPERATOR' ? 'Operator' : 'Viewer';
        var roleBadge = el('profileRole');
        if (roleBadge) {
          roleBadge.className = 'status-badge ' + (role === 'ADMIN' ? 'warning' : role === 'OPERATOR' ? 'info' : 'secondary');
          roleBadge.textContent = roleLabel;
        }

        setText('profileMemberSince',
          u.date_joined ? new Date(u.date_joined).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '—');
        setText('profileLastLogin', u.last_login ? fmt.timeAgo(u.last_login) : '—');

        var active = u.is_active !== false;
        var statusEl = el('profileStatus');
        if (statusEl) {
          statusEl.className = 'fw-bold small ' + (active ? 'text-success' : 'text-danger');
          statusEl.textContent = active ? 'Active' : 'Inactive';
        }

        var form = el('profileForm');
        if (form) {
          if (form.first_name) form.first_name.value = u.first_name || '';
          if (form.last_name)  form.last_name.value  = u.last_name  || '';
          if (form.email)      form.email.value      = u.email      || '';
          // The template may not have first_name/last_name; fall back to full_name if present
          if (form.full_name && !form.first_name) {
            form.full_name.value = ((u.first_name || '') + ' ' + (u.last_name || '')).trim();
          }
        }
      }).catch(function (err) { console.error('[profile] load failed:', err); toast.error('Failed to load profile'); });
    }

    function saveProfile(e) {
      e.preventDefault();
      var form = e.target, btn = el('profileSaveBtn'), txt = el('profileSaveText'), sp = el('profileSaveSpinner');
      var payload = {
        first_name: (form.first_name ? form.first_name.value : '').trim(),
        last_name:  (form.last_name  ? form.last_name.value  : '').trim(),
        email:      (form.email      ? form.email.value      : '').trim(),
      };
      // If template only has full_name, split it
      if (!form.first_name && form.full_name) {
        var parts = form.full_name.value.trim().split(/\s+/);
        payload.first_name = parts[0] || '';
        payload.last_name = parts.slice(1).join(' ') || '';
      }
      btn.disabled = true; if (txt) txt.textContent = 'Saving…'; if (sp) sp.classList.remove('d-none');
      Api.patch('/auth/me/', payload).then(function () { toast.success('Profile updated'); loadProfile(); })
        .catch(function (err) {
          var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
          toast.error(d || err.message || 'Could not save profile');
        }).finally(function () {
          btn.disabled = false; if (txt) txt.textContent = 'Save Changes'; if (sp) sp.classList.add('d-none');
        });
    }

    function changePassword(e) {
      e.preventDefault();
      var form = e.target, btn = el('passwordSubmitBtn'), txt = el('passwordSubmitText'), sp = el('passwordSubmitSpinner');
      // Backend expects old_password + new_password
      var oldPwd = form.old_password ? form.old_password.value
                 : form.current_password ? form.current_password.value
                 : '';
      var newPwd = form.new_password.value;
      var confirm = form.confirm_password.value;
      if (!oldPwd || !newPwd || !confirm) { toast.error('Fill in all password fields'); return; }
      if (newPwd.length < 8) { toast.error('New password must be at least 8 characters'); return; }
      if (newPwd !== confirm) { toast.error('New passwords do not match'); return; }

      btn.disabled = true; if (txt) txt.textContent = 'Updating…'; if (sp) sp.classList.remove('d-none');
      Api.post('/auth/password/change/', { old_password: oldPwd, new_password: newPwd })
        .then(function () { toast.success('Password updated'); form.reset(); })
        .catch(function (err) {
          var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
          toast.error(d || err.message || 'Could not update password');
        }).finally(function () {
          btn.disabled = false; if (txt) txt.textContent = 'Update Password'; if (sp) sp.classList.add('d-none');
        });
    }

    var pf = el('profileForm'); if (pf) pf.addEventListener('submit', saveProfile);
    var pw = el('passwordForm'); if (pw) pw.addEventListener('submit', changePassword);
    loadProfile();
  });

  /* ============================================================
     19. PAGE: devices
     ============================================================ */
  register('devices', function () {
    var state = { search: '', type: '', status: '', rows: [], selectedId: null };
    var pollTimer = null;

    function flowTxt(v) {
      return v == null || isNaN(v) ? '—' : fmt.num(v, 2) + ' L/min';
    }

    function loadDevices(keepSelection) {
      var tbody = el('devTableBody');
      if (tbody && !keepSelection) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Loading devices…</td></tr>';
      }
      Api.get('/devices/', {
        query: {
          search: state.search || undefined,
          device_type: state.type || undefined,
          effective_status: state.status || undefined,
        },
      }).then(function (data) {
        var rows = (data && data.devices) || toArray(data);
        var summary = (data && data.summary) || {};
        state.rows = rows;
        updateSummary(summary, rows);
        renderTable(rows);
        setText('devPageInfo', rows.length + ' device' + (rows.length !== 1 ? 's' : '') +
          ' · heartbeat timeout ' + (summary.heartbeat_timeout_seconds || 120) + 's');
        var sel = state.selectedId
          ? rows.find(function (r) { return r.id === state.selectedId; })
          : rows[0];
        if (sel) {
          state.selectedId = sel.id;
          renderDetail(sel);
        }
      }).catch(function (err) {
        console.error('[devices] load failed:', err);
        setError('devTableBody', 'Could not load devices');
      });
    }

    function updateSummary(summary, rows) {
      setText('devTotal', fmt.int(summary.total != null ? summary.total : rows.length));
      setText('devTotalNote', (summary.offline != null ? summary.offline : 0) + ' offline');
      setText('devConnected', fmt.int(summary.connected != null ? summary.connected : 0));
      setText('devConnectedNote', 'within heartbeat window');
      var latest = summary.last_communication;
      setText('devLastComm', latest ? fmt.timeAgo(latest) : '—');
      setText('devLastCommNote', latest ? new Date(latest).toLocaleString() : 'No telemetry yet');
      var warn = summary.hardware_warnings != null ? summary.hardware_warnings : 0;
      setText('devWarnings', fmt.int(warn));
      setText('devWarningsNote', warn ? 'Open hardware / disconnect alerts' : 'No open hardware alerts');
    }

    function renderTable(rows) {
      var tbody = el('devTableBody'); if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No devices registered</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (d) {
        var active = state.selectedId === d.id ? ' table-active' : '';
        return '<tr class="' + active + '" data-id="' + d.id + '" style="cursor:pointer;">' +
          '<td><div class="fw-semibold">' + escapeHtml(d.device_name) + '</div>' +
            '<div class="small text-muted"><code>' + escapeHtml(d.device_identifier) + '</code>' +
            (d.location ? ' · ' + escapeHtml(d.location) : '') + '</div></td>' +
          '<td>' + statusBadge(d.connection_status) +
            '<div class="small text-muted">' + escapeHtml(d.device_type || '—') + '</div></td>' +
          '<td class="small">S1 ' + flowTxt(d.inlet_flow_lpm) +
            '<br>S2 ' + flowTxt(d.outlet_flow_lpm) + '</td>' +
          '<td>' + (d.valve_state ? statusBadge(d.valve_state) : '<span class="text-muted">—</span>') + '</td>' +
          '<td>' + statusBadge(d.health) +
            '<div class="small text-muted">' + escapeHtml(d.health_note || '') + '</div></td>' +
          '<td class="text-muted small">' + fmt.timeAgo(d.last_communication) +
            (d.heartbeat_age_seconds != null ? '<div>' + d.heartbeat_age_seconds + 's ago</div>' : '') +
          '</td>' +
          '<td><button class="btn btn-sm btn-outline-primary" data-action="view" data-id="' + d.id + '">Details</button></td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('tr[data-id]').forEach(function (tr) {
        tr.addEventListener('click', function (e) {
          if (e.target.closest('button')) return;
          selectDevice(Number(tr.getAttribute('data-id')));
        });
      });
      tbody.querySelectorAll('[data-action="view"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          selectDevice(Number(btn.getAttribute('data-id')));
        });
      });
    }

    function selectDevice(id) {
      state.selectedId = id;
      var row = state.rows.find(function (r) { return r.id === id; });
      if (row) {
        renderTable(state.rows);
        renderDetail(row);
      }
      Api.get('/devices/' + id + '/health/').then(function (h) {
        if (state.selectedId !== id) return;
        renderDetail(h);
      }).catch(function () {});
    }

    function renderDetail(d) {
      var box = el('devDetailBody'); if (!box) return;
      var sensors = d.sensors || [];
      var valves = d.valves || [];
      var sensorHtml = sensors.length
        ? sensors.map(function (s) {
            return '<tr><td>' + escapeHtml(s.sensor_name) +
              ' <span class="text-muted">(' + escapeHtml(s.sensor_position) + ')</span></td>' +
              '<td>' + statusBadge(s.status) + '</td>' +
              '<td>' + flowTxt(s.flow_rate_lpm) + '</td>' +
              '<td class="small text-muted">' +
                (s.last_reading_at ? fmt.timeAgo(s.last_reading_at) : 'no reading') +
              '</td></tr>';
          }).join('')
        : '<tr><td colspan="4" class="text-muted">No sensors linked</td></tr>';
      var valveHtml = valves.length
        ? valves.map(function (v) {
            return '<div class="d-flex justify-content-between border-bottom py-2">' +
              '<span>' + escapeHtml(v.valve_name) + '</span>' +
              '<span>' + statusBadge(v.current_status) + ' · ' + escapeHtml(v.control_mode || '') + '</span></div>';
          }).join('')
        : '<div class="text-muted small">No valve linked</div>';

      box.innerHTML =
        '<div class="mb-3">' +
          '<div class="fw-bold fs-5">' + escapeHtml(d.device_name || 'Device') + '</div>' +
          '<code>' + escapeHtml(d.device_identifier || '') + '</code>' +
        '</div>' +
        '<dl class="row small mb-3">' +
          '<dt class="col-5">Connection</dt><dd class="col-7">' + statusBadge(d.connection_status) + '</dd>' +
          '<dt class="col-5">Health</dt><dd class="col-7">' + statusBadge(d.health) +
            '<div class="text-muted">' + escapeHtml(d.health_note || '') + '</div></dd>' +
          '<dt class="col-5">Location</dt><dd class="col-7">' + escapeHtml(d.location || '—') + '</dd>' +
          '<dt class="col-5">Firmware</dt><dd class="col-7">' + escapeHtml(d.firmware_version || 'Not reported') + '</dd>' +
          '<dt class="col-5">Type</dt><dd class="col-7">' + escapeHtml(d.device_type || '—') + '</dd>' +
          '<dt class="col-5">Heartbeat</dt><dd class="col-7">' +
            (d.heartbeat_age_seconds != null ? d.heartbeat_age_seconds + 's ago' : '—') +
            ' <span class="text-muted">(timeout ' + (d.heartbeat_timeout_seconds || 120) + 's)</span></dd>' +
          '<dt class="col-5">Last telemetry</dt><dd class="col-7">' +
            (d.last_communication ? fmt.datetime(d.last_communication) : '—') + '</dd>' +
          '<dt class="col-5">Active</dt><dd class="col-7">' + (d.is_active ? 'Yes' : 'No') + '</dd>' +
        '</dl>' +
        '<h6 class="fw-semibold">Sensors (' + sensors.length + ')</h6>' +
        '<div class="table-responsive mb-3"><table class="table table-sm mb-0">' +
          '<thead><tr><th>Name</th><th>Status</th><th>Flow</th><th>Reading</th></tr></thead>' +
          '<tbody>' + sensorHtml + '</tbody></table></div>' +
        '<h6 class="fw-semibold">Valves</h6>' + valveHtml;
    }

    function registerDevice() {
      var form = el('registerDeviceForm'); if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        var payload = {
          device_name: fd.get('device_name'),
          device_identifier: fd.get('device_id'),
          device_type: fd.get('device_type') || 'ARDUINO_ESP',
          location: fd.get('location') || '',
          firmware_version: fd.get('firmware_version') || '',
        };
        var btn = el('registerDeviceSubmit'), txt = el('registerDeviceSubmitText'), sp = el('registerDeviceSpinner');
        btn.disabled = true; if (txt) txt.textContent = 'Registering…'; if (sp) sp.classList.remove('d-none');

        Api.post('/iot/devices/register/', payload).then(function (data) {
          var modal = bootstrap.Modal.getInstance(el('registerDeviceModal'));
          if (modal) modal.hide();
          var key = (data && data.api_key) || '';
          toast.success('Device registered');
          if (key) {
            window.prompt('API key (copy & store securely — shown once):', key);
          }
          form.reset();
          loadDevices();
        }).catch(function (err) {
          toast.error(err.message || 'Registration failed');
        }).finally(function () {
          btn.disabled = false; if (txt) txt.textContent = 'Register'; if (sp) sp.classList.add('d-none');
        });
      });
    }

    var s = el('devSearch');
    if (s) s.addEventListener('input', function (e) {
      clearTimeout(window._devTimer);
      window._devTimer = setTimeout(function () {
        state.search = e.target.value.trim();
        loadDevices();
      }, 350);
    });
    var t = el('devTypeFilter');
    if (t) t.addEventListener('change', function (e) { state.type = e.target.value; loadDevices(); });
    var st = el('devStatusFilter');
    if (st) st.addEventListener('change', function (e) { state.status = e.target.value; loadDevices(); });
    var rb = el('registerDeviceBtn');
    if (rb) rb.addEventListener('click', function () {
      new bootstrap.Modal(el('registerDeviceModal')).show();
    });
    var rf = el('devRefreshBtn');
    if (rf) rf.addEventListener('click', function () { loadDevices(true); });

    registerDevice();
    loadDevices();
    pollTimer = setInterval(function () { loadDevices(true); }, 10000);
    window.addEventListener('beforeunload', function () {
      if (pollTimer) clearInterval(pollTimer);
    });
  });

  /* ============================================================
     20. PAGE: leak-detection
     ============================================================ */
  register('leak-detection', function () {
    var flowChart = null;

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadOverview() {
      Api.get('/leaks/overview/').then(function (d) {
        // {active_events, confirmed_events, suspected_events, system_status}
        var status = (d.system_status || 'NORMAL').toUpperCase();
        var variant = status === 'NORMAL' ? 'success' : 'danger';
        setBadge('ld-pipeline-status', status, variant);
        setText('ld-pipeline-note', 'Across all pipelines');
        setText('ld-active', d.active_events || 0);
        setText('ld-active-note',
          (d.confirmed_events || 0) + ' confirmed · ' + (d.suspected_events || 0) + ' suspected');
      }).catch(function (err) { console.error('[leaks] overview failed:', err); });
    }

    function loadPipeline() {
      Api.get('/leaks/pipeline/').then(function (d) {
        // {pipeline:{...}, inlet_sensor:{...}, outlet_sensor:{...}, sections:[...], condition}
        var name = d.pipeline ? d.pipeline.name : '—';
        setText('ldPipelineName', name);
        var diag = el('ldPipelineDiagram');
        if (diag) {
          if (!d.pipeline) {
            diag.innerHTML = '<div class="text-center text-muted small py-4">No pipeline configured</div>';
          } else {
            diag.innerHTML =
              '<div class="p-3">' +
                '<div class="d-flex justify-content-between align-items-center">' +
                  '<div class="text-center">' +
                    '<i class="bi bi-broadcast text-primary" style="font-size:1.5rem;"></i>' +
                    '<div class="fw-semibold small mt-1">' + escapeHtml((d.inlet_sensor && d.inlet_sensor.name) || '—') + '</div>' +
                    '<div class="text-muted" style="font-size:.7rem;">INLET</div>' +
                  '</div>' +
                  '<div class="flex-grow-1 text-center text-muted small"><hr></div>' +
                  '<div class="text-center">' +
                    '<i class="bi bi-broadcast text-success" style="font-size:1.5rem;"></i>' +
                    '<div class="fw-semibold small mt-1">' + escapeHtml((d.outlet_sensor && d.outlet_sensor.name) || '—') + '</div>' +
                    '<div class="text-muted" style="font-size:.7rem;">OUTLET</div>' +
                  '</div>' +
                '</div>' +
              '</div>';
          }
        }
      }).catch(function (err) { console.error('[leaks] pipeline failed:', err); });

      Api.get('/leaks/pipeline/comparison/').then(function (d) {
        // {inlet_flow_rate, outlet_flow_rate, flow_difference, difference_percentage, is_leak_candidate}
        setText('ld-diff', fmt.num(d.flow_difference));
        setText('ld-diff-note', 'Inlet ' + fmt.num(d.inlet_flow_rate) + ' · Outlet ' + fmt.num(d.outlet_flow_rate) + ' L/min');

        // Build flow chart from a single point for now; richer chart needs history
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 220, toolbar: { show: false } },
          series: [{ name: 'Flow', data: [Number(d.inlet_flow_rate) || 0, Number(d.outlet_flow_rate) || 0] }],
          xaxis: { categories: ['Inlet', 'Outlet'], labels: { style: { colors: c.text } } },
          colors: ['#3b82f6', '#22c55e'],
          plotOptions: { bar: { columnWidth: '50%', borderRadius: 4 } },
          dataLabels: { enabled: true },
          yaxis: { title: { text: 'L/min' }, labels: { style: { colors: c.text } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
        };
        var target = el('ldFlowChart');
        if (target) {
          if (flowChart) { flowChart.updateOptions(options); flowChart.updateSeries(options.series); }
          else { flowChart = new ApexCharts(target, options); flowChart.render(); }
        }
      }).catch(function (err) { console.error('[leaks] comparison failed:', err); });
    }

    function loadEvents() {
      var severity = (el('ldSeverityFilter') && el('ldSeverityFilter').value) || '';
      var status = (el('ldStatusFilter') && el('ldStatusFilter').value) || '';
      var search = (el('ldSearch') && el('ldSearch').value) || '';
      Api.get('/leaks/events/', { query: { severity: severity || undefined, detection_status: status || undefined, search: search || undefined } })
        .then(function (data) {
          var rows = toArray(data);
          var tbody = el('ldEventsBody'); if (!tbody) return;
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No leak events</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map(function (r) {
            return '<tr>' +
              '<td><code>#' + escapeHtml(r.id) + '</code></td>' +
              '<td class="text-muted small">' + fmt.datetime(r.started_at) + '</td>' +
              '<td>' + fmt.num(r.flow_difference) + ' L/min</td>' +
              '<td>' + statusBadge(r.severity) + '</td>' +
              '<td class="small">' + escapeHtml(r.description || '—') + '</td>' +
              '<td>' + statusBadge(r.detection_status) + '</td>' +
              '<td class="text-end"><button class="btn btn-sm btn-outline-primary" data-action="view" data-id="' + r.id + '">View</button></td>' +
            '</tr>';
          }).join('');
          tbody.querySelectorAll('[data-action="view"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var id = btn.getAttribute('data-id');
              Api.get('/leaks/events/' + id + '/').then(function (e) {
                var body = el('ldEventModalBody');
                if (body) {
                  body.innerHTML =
                    '<dl class="row small mb-0">' +
                      '<dt class="col-5">Status</dt><dd class="col-7">' + statusBadge(e.detection_status) + '</dd>' +
                      '<dt class="col-5">Severity</dt><dd class="col-7">' + statusBadge(e.severity) + '</dd>' +
                      '<dt class="col-5">Inlet flow</dt><dd class="col-7">' + fmt.num(e.inlet_flow_rate) + ' L/min</dd>' +
                      '<dt class="col-5">Outlet flow</dt><dd class="col-7">' + fmt.num(e.outlet_flow_rate) + ' L/min</dd>' +
                      '<dt class="col-5">Difference</dt><dd class="col-7">' + fmt.num(e.flow_difference) + ' L/min (' + fmt.num(e.difference_percentage) + '%)</dd>' +
                      '<dt class="col-5">Started</dt><dd class="col-7">' + fmt.datetime(e.started_at) + '</dd>' +
                      '<dt class="col-5">Resolved</dt><dd class="col-7">' + (e.resolved_at ? fmt.datetime(e.resolved_at) : '—') + '</dd>' +
                    '</dl>';
                }
                new bootstrap.Modal(el('ldEventModal')).show();
              }).catch(function () { toast.error('Could not load event'); });
            });
          });
        }).catch(function (err) { console.error('[leaks] events failed:', err); setError('ldEventsBody', 'Could not load leak events'); });
    }

    var rf = el('ldRefreshBtn'); if (rf) rf.addEventListener('click', function () { loadOverview(); loadPipeline(); loadEvents(); });
    ['ldSeverityFilter', 'ldStatusFilter'].forEach(function (id) {
      var n = el(id); if (n) n.addEventListener('change', loadEvents);
    });
    var s = el('ldSearch');
    if (s) s.addEventListener('input', function () {
      clearTimeout(window._ldTimer);
      window._ldTimer = setTimeout(loadEvents, 350);
    });

    loadOverview();
    loadPipeline();
    loadEvents();
  });

  /* ============================================================
     21. PAGE: valve-control
     ============================================================ */
  register('valve-control', function () {
    var currentValve = null;
    var pollTimer = null;

    function loadValves() {
      Api.get('/valves/').then(function (data) {
        var rows = toArray(data);
        if (!rows.length) {
          toast.info('No valves configured');
          setBadge('vc-conn-badge', 'NO DEVICE', 'secondary');
          setText('vc-conn-note', 'Register a kit device first');
          return;
        }
        currentValve = rows[0];
        renderValve(currentValve);
        enrichDevice(currentValve);
        loadActivities();
      }).catch(function (err) {
        console.error('[valves] load failed:', err);
        toast.error(err.message || 'Could not load valves');
      });
    }

    function connVariant(status) {
      var s = String(status || 'UNKNOWN').toUpperCase();
      if (s === 'CONNECTED') return 'success';
      if (s === 'DISCONNECTED') return 'danger';
      return 'warning';
    }

    function renderValve(v) {
      setBadge('vc-state-badge', v.current_status || 'UNKNOWN',
        v.current_status === 'OPEN' ? 'success' : v.current_status === 'CLOSED' ? 'danger' : 'secondary');
      setText('vc-state-note', 'Last update ' + fmt.timeAgo(v.last_updated));

      setBadge('vc-mode-badge', v.control_mode || 'MANUAL', v.control_mode === 'AUTOMATIC' ? 'success' : 'secondary');
      setText('vc-mode-note', v.control_mode === 'AUTOMATIC' ? 'Rules-driven' : 'Operator-driven');

      var conn = v.connection_status || 'UNKNOWN';
      // Prefer live telemetry age over a stale stored flag
      if (v.device_last_communication) {
        var ageMs = Date.now() - new Date(v.device_last_communication).getTime();
        if (!isNaN(ageMs) && ageMs <= 120000) conn = 'CONNECTED';
        else if (!isNaN(ageMs) && ageMs > 120000) conn = 'DISCONNECTED';
      }
      setBadge('vc-conn-badge', conn, connVariant(conn));
      setText('vc-conn-note',
        (v.device_name || 'Device') +
        (v.device_last_communication ? ' · last seen ' + fmt.timeAgo(v.device_last_communication) : ' · awaiting PC Uno agent')
      );

      var details = el('vcDetailsBody');
      if (details) {
        details.innerHTML =
          '<dl class="row small mb-0">' +
            '<dt class="col-5">Valve name</dt><dd class="col-7">' + escapeHtml(v.valve_name || '—') + '</dd>' +
            '<dt class="col-5">Identifier</dt><dd class="col-7"><code>' + escapeHtml(v.valve_identifier || '—') + '</code></dd>' +
            '<dt class="col-5">State</dt><dd class="col-7">' + statusBadge(v.current_status) + '</dd>' +
            '<dt class="col-5">Mode</dt><dd class="col-7">' + statusBadge(v.control_mode) + '</dd>' +
            '<dt class="col-5">IoT device</dt><dd class="col-7">' + escapeHtml(v.device_name || '—') +
              ' <code class="small">' + escapeHtml(v.device_identifier || '') + '</code></dd>' +
            '<dt class="col-5">Connection</dt><dd class="col-7">' + statusBadge(conn) + '</dd>' +
            '<dt class="col-5">Last telemetry</dt><dd class="col-7">' +
              (v.device_last_communication ? fmt.datetime(v.device_last_communication) : '—') + '</dd>' +
            '<dt class="col-5">Location</dt><dd class="col-7">' + escapeHtml(v.device_location || '—') + '</dd>' +
            '<dt class="col-5">Last update</dt><dd class="col-7">' + fmt.datetime(v.last_updated) + '</dd>' +
          '</dl>';
      }
    }

    function enrichDevice(v) {
      if (!v || !v.device) return;
      Api.get('/devices/' + v.device + '/').then(function (d) {
        if (!currentValve || currentValve.id !== v.id) return;
        currentValve.connection_status = d.connection_status || currentValve.connection_status;
        currentValve.device_last_communication = d.last_communication || currentValve.device_last_communication;
        currentValve.device_name = d.device_name || currentValve.device_name;
        currentValve.device_identifier = d.device_identifier || currentValve.device_identifier;
        currentValve.device_location = d.location || currentValve.device_location;
        currentValve.device_is_active = d.is_active;
        renderValve(currentValve);
      }).catch(function () { /* keep serializer fields */ });

      Api.get('/devices/' + v.device + '/health/').then(function (h) {
        if (!h) return;
        var healthy = !!h.healthy;
        setBadge('vc-conn-badge',
          healthy ? 'CONNECTED' : (h.connection_status || currentValve.connection_status || 'UNKNOWN'),
          healthy ? 'success' : 'danger');
        setText('vc-conn-note',
          (currentValve.device_name || h.device || 'Kit') +
          (healthy ? ' · IoT healthy' : ' · IoT degraded') +
          (h.last_communication ? ' · ' + fmt.timeAgo(h.last_communication) : '')
        );
      }).catch(function () {});
    }

    function loadActivities() {
      Api.get('/valves/activities/').then(function (data) {
        var rows = toArray(data);
        var tbody = el('vcActivityBody'); if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No valve activity</td></tr>';
          setBadge('vc-cmd-badge', 'NONE', 'secondary');
          setText('vc-cmd-note', 'No commands yet');
          return;
        }
        setText('vcActivityCount', rows.length + ' entries');
        var latest = rows[0];
        setBadge('vc-cmd-badge', latest.execution_status || latest.command_type || '—',
          latest.execution_status === 'EXECUTED' ? 'success'
            : latest.execution_status === 'FAILED' ? 'danger'
            : latest.execution_status === 'PENDING' || latest.execution_status === 'RECEIVED' ? 'warning' : 'secondary');
        setText('vc-cmd-note',
          (latest.command_type || 'Command') + ' · ' + fmt.timeAgo(latest.requested_at) +
          (latest.execution_status === 'PENDING' || latest.execution_status === 'RECEIVED'
            ? ' · waiting for PC Uno agent'
            : ''));
        tbody.innerHTML = rows.slice(0, 20).map(function (r) {
          return '<tr>' +
            '<td class="text-muted small">' + fmt.datetime(r.requested_at) + '</td>' +
            '<td>' + escapeHtml(r.command_type) + '</td>' +
            '<td>' + escapeHtml(r.requested_by_username || 'System') + '</td>' +
            '<td>' + statusBadge(r.execution_status) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[valves] activities failed:', err); });
    }

    function sendCommand(type) {
      if (!currentValve) { toast.error('No valve selected'); return; }
      var path = '/valves/' + currentValve.id + '/' + type + '/';
      Api.post(path, {}).then(function (cmd) {
        toast.success('Command submitted — waiting for hardware');
        setBadge('vc-cmd-badge', cmd.execution_status || 'PENDING', 'warning');
        setText('vc-cmd-note', 'Issued ' + fmt.timeAgo(cmd.requested_at || new Date().toISOString()));
        loadActivities();
        setTimeout(loadValves, 1500);
      }).catch(function (err) {
        toast.error(err.message || 'Command failed');
        setBadge('vc-cmd-badge', 'FAILED', 'danger');
      });
    }

    var op = el('vcOpenBtn'); if (op) op.addEventListener('click', function () { sendCommand('open'); });
    var cl = el('vcCloseBtn'); if (cl) cl.addEventListener('click', function () { sendCommand('close'); });
    var au = el('vcAutoBtn'); if (au) au.addEventListener('click', function () { sendCommand('auto'); });
    var mn = el('vcManualBtn'); if (mn) mn.addEventListener('click', function () { sendCommand('manual'); });
    var rf = el('vcRefreshBtn'); if (rf) rf.addEventListener('click', loadValves);

    loadValves();
    pollTimer = setInterval(loadValves, 10000);
    window.addEventListener('beforeunload', function () {
      if (pollTimer) clearInterval(pollTimer);
    });
  });

  /* ============================================================
     22. PAGE: water-usage
     ============================================================ */
  register('water-usage', function () {
    var hourlyChart = null, dailyChart = null, weeklyChart = null;

    function ymd(d) {
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }
    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }
    function rangeFor(period) {
      var end = new Date();
      var start = new Date();
      if (period === 'week') start.setDate(end.getDate() - 6);
      else if (period === 'month') start.setDate(end.getDate() - 29);
      else if (period === 'custom') {
        var s = el('wuStartDate') && el('wuStartDate').value;
        var e = el('wuEndDate') && el('wuEndDate').value;
        return { start_date: s || ymd(start), end_date: e || ymd(end) };
      } else {
        start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      }
      return { start_date: ymd(start), end_date: ymd(end) };
    }

    function renderBar(targetId, chartRefName, labels, values, title) {
      var c = themeColors();
      var options = {
        chart: { type: 'bar', height: 300, toolbar: { show: false } },
        series: [{ name: title || 'Consumption', data: values }],
        xaxis: { categories: labels, labels: { style: { colors: c.text } } },
        yaxis: { title: { text: 'L' }, labels: { style: { colors: c.text } } },
        colors: ['#0ea5e9'],
        plotOptions: { bar: { columnWidth: '55%', borderRadius: 4 } },
        dataLabels: { enabled: false },
        grid: { borderColor: c.grid },
        theme: { mode: c.mode },
        tooltip: { y: { formatter: function (v) { return Number(v).toFixed(1) + ' L'; } } },
      };
      var target = el(targetId);
      if (!target) return;
      if (chartRefName === 'hourly') {
        if (hourlyChart) { hourlyChart.updateOptions(options); hourlyChart.updateSeries(options.series); }
        else { hourlyChart = new ApexCharts(target, options); hourlyChart.render(); }
      } else if (chartRefName === 'daily') {
        if (dailyChart) { dailyChart.updateOptions(options); dailyChart.updateSeries(options.series); }
        else { dailyChart = new ApexCharts(target, options); dailyChart.render(); }
      } else {
        if (weeklyChart) { weeklyChart.updateOptions(options); weeklyChart.updateSeries(options.series); }
        else { weeklyChart = new ApexCharts(target, options); weeklyChart.render(); }
      }
    }

    function loadKpis() {
      var today = ymd(new Date());
      var weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
      var monthStart = new Date(); monthStart.setDate(monthStart.getDate() - 29);

      Promise.all([
        Api.get('/analytics/summary/', { query: { start_date: today, end_date: today } }),
        Api.get('/analytics/summary/', { query: { start_date: ymd(weekStart), end_date: today } }),
        Api.get('/analytics/summary/', { query: { start_date: ymd(monthStart), end_date: today } }),
        Api.get('/analytics/consumption-trends/', { query: { start_date: ymd(monthStart), end_date: today } }),
      ]).then(function (results) {
        var d = results[0], w = results[1], m = results[2], trends = results[3];
        setText('wu-today', fmt.num(d.total_consumption, 1));
        setText('wu-today-note', 'Litres today');
        setText('wu-week', fmt.num(w.total_consumption, 1));
        setText('wu-week-note', 'Last 7 days');
        setText('wu-month', fmt.num(m.total_consumption, 1));
        setText('wu-month-note', 'Last 30 days');

        trends = Array.isArray(trends) ? trends : toArray(trends);
        if (trends.length) {
          var maxIdx = 0;
          for (var i = 1; i < trends.length; i++) {
            if (Number(trends[i].consumption) > Number(trends[maxIdx].consumption)) maxIdx = i;
          }
          setBadge('wu-peak', String(trends[maxIdx].date || '—'), 'info');
          setText('wu-peak-note', fmt.num(trends[maxIdx].consumption, 1) + ' L');
        } else {
          setBadge('wu-peak', '—', 'secondary');
          setText('wu-peak-note', 'No peak data yet');
        }
      }).catch(function (err) {
        console.error('[water-usage] kpi failed:', err);
        setText('wu-today-note', 'Could not load');
        setText('wu-week-note', 'Could not load');
        setText('wu-month-note', 'Could not load');
        setText('wu-peak-note', 'Could not load');
        toast.error(err.message || 'Water usage KPIs failed');
      });
    }

    function loadHourly() {
      Api.get('/dashboard/flow-trend/', { query: { range: 'day' } }).then(function (payload) {
        var points = (payload && payload.points) || (Array.isArray(payload) ? payload : []);
        var buckets = {};
        points.forEach(function (p) {
          var ts = p.timestamp || '';
          var hour = ts.slice(11, 13) || '00';
          var key = hour + ':00';
          // approximate litres from L/min over sample spacing (~1 min average)
          buckets[key] = (buckets[key] || 0) + (Number(p.flow_rate) || 0);
        });
        var labels = Object.keys(buckets).sort();
        var values = labels.map(function (k) { return Math.round(buckets[k] * 10) / 10; });
        if (!labels.length) {
          labels = ['00:00']; values = [0];
        }
        renderBar('wuHourlyChart', 'hourly', labels, values, 'Hourly flow volume');
      }).catch(function (err) {
        console.error('[water-usage] hourly failed:', err);
        setError('wuHourlyChart', 'Could not load hourly consumption');
      });
    }

    function loadDailyAndTable() {
      var weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
      var today = ymd(new Date());
      Api.get('/analytics/consumption-trends/', {
        query: { start_date: ymd(weekStart), end_date: today },
      }).then(function (rows) {
        rows = Array.isArray(rows) ? rows : toArray(rows);
        var labels = rows.map(function (r) { return r.date; });
        var values = rows.map(function (r) { return Number(r.consumption) || 0; });
        renderBar('wuDailyChart', 'daily', labels.length ? labels : ['—'], values.length ? values : [0], 'Daily');
        var tbody = el('wuTableBody');
        if (tbody) {
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-4">No consumption data yet</td></tr>';
            setText('wu-table-count', '0 days');
          } else {
            setText('wu-table-count', rows.length + ' days');
            tbody.innerHTML = rows.slice().reverse().map(function (r) {
              return '<tr><td>' + escapeHtml(r.date) + '</td><td class="fw-semibold">' +
                fmt.num(r.consumption, 1) + '</td><td>L</td></tr>';
            }).join('');
          }
        }
      }).catch(function (err) {
        console.error('[water-usage] daily failed:', err);
        setError('wuDailyChart', 'Could not load daily consumption');
      });
    }

    function loadWeekly() {
      var monthStart = new Date(); monthStart.setDate(monthStart.getDate() - 29);
      var today = ymd(new Date());
      Api.get('/analytics/consumption-trends/', {
        query: { start_date: ymd(monthStart), end_date: today },
      }).then(function (rows) {
        rows = Array.isArray(rows) ? rows : toArray(rows);
        // bucket into weeks
        var weeks = {};
        rows.forEach(function (r) {
          var d = new Date(r.date + 'T00:00:00');
          if (isNaN(d.getTime())) return;
          var onejan = new Date(d.getFullYear(), 0, 1);
          var week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
          var key = 'W' + week;
          weeks[key] = (weeks[key] || 0) + (Number(r.consumption) || 0);
        });
        var labels = Object.keys(weeks);
        var values = labels.map(function (k) { return Math.round(weeks[k] * 10) / 10; });
        renderBar('wuWeeklyChart', 'weekly', labels.length ? labels : ['—'], values.length ? values : [0], 'Weekly');
      }).catch(function (err) {
        console.error('[water-usage] weekly failed:', err);
        setError('wuWeeklyChart', 'Could not load weekly consumption');
      });
    }

    function loadAll() {
      loadKpis();
      loadHourly();
      loadDailyAndTable();
      loadWeekly();
    }

    var period = el('wuPeriod');
    if (period) period.addEventListener('change', function () {
      var custom = period.value === 'custom';
      if (el('wuStartDate')) el('wuStartDate').classList.toggle('d-none', !custom);
      if (el('wuEndDate')) el('wuEndDate').classList.toggle('d-none', !custom);
    });
    var apply = el('wuApplyBtn');
    if (apply) apply.addEventListener('click', loadAll);

    loadAll();
    setInterval(loadAll, 60000);
  });

  /* ============================================================
     22b. PAGE: finance (private — staff/operator only)
     ============================================================ */
  register('finance', function () {
    function money(v) {
      if (v == null || isNaN(v)) return '—';
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fillSettings(s) {
      if (!s) return;
      var sms = el('finSmsCost'); if (sms) sms.value = s.sms_cost;
      var w = el('finWaterCost'); if (w) w.value = s.water_cost_per_liter;
      var m = el('finMaintDefault'); if (m) m.value = s.maintenance_default_cost;
      var k = el('finKitCost'); if (k) k.value = s.kit_unit_cost;
      var a1 = el('finAutoSms'); if (a1) a1.checked = !!s.auto_record_sms;
      var a2 = el('finAutoLeak'); if (a2) a2.checked = !!s.auto_record_leak_loss;
    }

    function render(data) {
      var cur = data.currency || 'KES';
      setText('fin-income', money(data.income));
      setText('fin-expense', money(data.expense));
      setText('fin-net', money(data.net));
      setText('fin-auto', money(data.auto_expense));
      setText('fin-manual', money(data.manual_expense));
      ['fin-cur1', 'fin-cur2', 'fin-cur3'].forEach(function (id) { setText(id, cur); });

      if (data.tips && data.tips.length) {
        setText('finTips', data.tips.join(' '));
      }

      var cats = data.by_category || [];
      var catEl = el('finCatList');
      if (catEl) {
        if (!cats.length) {
          catEl.innerHTML = '<div class="text-muted">No expenses in this period.</div>';
        } else {
          catEl.innerHTML = cats.map(function (c) {
            return '<div class="d-flex justify-content-between border-bottom py-2">' +
              '<span>' + escapeHtml(c.category) + ' <span class="text-muted">(' + c.count + ')</span></span>' +
              '<strong>' + money(c.total) + ' ' + cur + '</strong></div>';
          }).join('');
        }
      }

      var rows = data.recent || [];
      setText('finLedgerCount', rows.length + ' recent');
      var tbody = el('finLedgerBody');
      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No entries yet</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        var canDel = r.source === 'MANUAL';
        return '<tr>' +
          '<td class="small text-muted">' + fmt.datetime(r.occurred_at) + '</td>' +
          '<td>' + statusBadge(r.entry_type) + '</td>' +
          '<td class="small">' + escapeHtml(r.category) + '</td>' +
          '<td>' + escapeHtml(r.title) +
            (r.notes ? '<div class="small text-muted">' + escapeHtml(r.notes).slice(0, 80) + '</div>' : '') +
          '</td>' +
          '<td class="fw-semibold">' + money(r.amount) + ' ' + escapeHtml(r.currency || cur) + '</td>' +
          '<td>' + statusBadge(r.source) + '</td>' +
          '<td>' + (canDel
            ? '<button class="btn btn-sm btn-outline-danger fin-del" data-id="' + r.id + '">Delete</button>'
            : '<span class="text-muted small">auto</span>') + '</td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('.fin-del').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          Api.del('/finance/entries/' + id + '/').then(function () {
            toast.success('Entry deleted');
            load();
          }).catch(function (err) { toast.error(err.message || 'Delete failed'); });
        });
      });

      fillSettings(data.settings);
    }

    function load() {
      var days = (el('finPeriod') && el('finPeriod').value) || 30;
      Api.get('/finance/summary/', { query: { days: days } }).then(render).catch(function (err) {
        toast.error(err.message || 'Finance load failed (staff/operator only)');
        setHtml('finLedgerBody', '<tr><td colspan="7" class="text-center text-danger py-4">' +
          escapeHtml(err.message || 'Access denied') + '</td></tr>');
      });
    }

    var rf = el('finRefreshBtn'); if (rf) rf.addEventListener('click', load);
    var per = el('finPeriod'); if (per) per.addEventListener('change', load);

    var mb = el('finMaintBtn');
    if (mb) mb.addEventListener('click', function () {
      var title = (el('finMaintTitle') && el('finMaintTitle').value || '').trim();
      if (!title) { toast.warn('Enter a maintenance title'); return; }
      var amount = el('finMaintAmount') && el('finMaintAmount').value;
      var body = {
        title: title,
        notes: (el('finMaintNotes') && el('finMaintNotes').value) || '',
      };
      if (amount !== '' && amount != null) body.amount = amount;
      Api.post('/finance/maintenance/', body).then(function () {
        toast.success('Maintenance logged');
        if (el('finMaintTitle')) el('finMaintTitle').value = '';
        if (el('finMaintAmount')) el('finMaintAmount').value = '';
        if (el('finMaintNotes')) el('finMaintNotes').value = '';
        load();
      }).catch(function (err) { toast.error(err.message || 'Failed'); });
    });

    var eb = el('finEntryBtn');
    if (eb) eb.addEventListener('click', function () {
      var title = (el('finEntryTitle') && el('finEntryTitle').value || '').trim();
      var amount = el('finEntryAmount') && el('finEntryAmount').value;
      if (!title || !amount) { toast.warn('Title and amount required'); return; }
      Api.post('/finance/entries/', {
        entry_type: el('finEntryType').value,
        category: el('finEntryCat').value,
        title: title,
        amount: amount,
      }).then(function () {
        toast.success('Entry added');
        el('finEntryTitle').value = '';
        el('finEntryAmount').value = '';
        load();
      }).catch(function (err) { toast.error(err.message || 'Failed'); });
    });

    var ss = el('finSaveSettings');
    if (ss) ss.addEventListener('click', function () {
      Api.patch('/finance/settings/', {
        sms_cost: el('finSmsCost').value,
        water_cost_per_liter: el('finWaterCost').value,
        maintenance_default_cost: el('finMaintDefault').value,
        kit_unit_cost: el('finKitCost').value,
        auto_record_sms: !!(el('finAutoSms') && el('finAutoSms').checked),
        auto_record_leak_loss: !!(el('finAutoLeak') && el('finAutoLeak').checked),
      }).then(function () {
        toast.success('Rates saved');
        load();
      }).catch(function (err) { toast.error(err.message || 'Save failed'); });
    });

    load();
  });

  /* ============================================================
     23. BOOTSTRAP
     ============================================================ */
  function loadMsingiWidget() {
    if (window.__MSINGI_BOOTSTRAPPED__) return;
    // Keep finance page private — no public chatbot surface here
    if (currentPage() === 'finance') return;
    // App shell: mark body so contact FABs stay off the operator UI
    if (!IS_PUBLIC_PAGE) document.body.classList.add('ap-app-shell');
    var current = document.querySelector('script[src*="main.js"]');
    var src = 'js/msingi-widget.js';
    if (current && current.src) {
      src = current.src.replace(/main\.js[^/]*$/i, 'msingi-widget.js');
    }
    var s = document.createElement('script');
    s.src = src + (src.indexOf('?') >= 0 ? '&' : '?') + 'v=1';
    s.defer = true;
    document.body.appendChild(s);
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initShell();

    var page = currentPage();
    var init = PAGES[page];
    if (typeof init === 'function') {
      try { init(); }
      catch (e) { console.error('[main.js] page init failed for "' + page + '":', e); }
    } else {
      console.warn('[main.js] no controller registered for page:', page);
    }

    loadMsingiWidget();
  });

  /* ============================================================
     24. DEBUG
     ============================================================ */
  window.AP = { Api: Api, fmt: fmt, toast: toast, WSClient: WSClient, CONFIG: CONFIG };
})();