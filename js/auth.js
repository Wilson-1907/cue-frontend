/* ============================================================
   CUE — auth.js
   Secure login → JWT → /auth/me/ gate → operator dashboard
   ============================================================ */
(function () {
  'use strict';

  var API_BASE = (function () {
    if (window.CUE_CONFIG && window.CUE_CONFIG.API_BASE) return String(window.CUE_CONFIG.API_BASE).replace(/\/$/, '');
    var host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000/api/v1';
    return location.origin.replace(/\/$/, '') + '/api/v1';
  })();
  var TOKEN_KEY   = 'ap_access';
  var REFRESH_KEY = 'ap_refresh';
  var USER_KEY    = 'ap_user';

  function siblingUrl(name) {
    return location.pathname.replace(/\/[^/]*\.html?$/i, '/' + name);
  }
  function dashboardUrl() { return siblingUrl('dashboard.html'); }
  function loginUrl()     { return siblingUrl('login.html'); }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function fetchMe(access) {
    return fetch(API_BASE + '/auth/me/', {
      headers: { 'Authorization': 'Bearer ' + access },
    }).then(function (res) {
      return res.json().then(function (json) {
        return { ok: res.ok, status: res.status, body: json };
      });
    });
  }

  function assertDashboardAccess(user) {
    if (!user) return 'Unable to verify your account.';
    if (user.is_active === false) {
      return 'This account is deactivated. Contact an administrator.';
    }
    if (user.can_access_dashboard === false) {
      return 'Your account is not authorized for the operator dashboard.';
    }
    return null;
  }

  window.Auth = {
    getAccess:  function () { return localStorage.getItem(TOKEN_KEY); },
    getRefresh: function () { return localStorage.getItem(REFRESH_KEY); },

    setTokens: function (access, refresh) {
      localStorage.setItem(TOKEN_KEY, access);
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    },

    setUser: function (user) {
      try { localStorage.setItem(USER_KEY, JSON.stringify(user || {})); } catch (_) {}
    },

    getUser: function () {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; }
    },

    clear: clearSession,

    isLoggedIn: function () { return !!this.getAccess(); },

    requireLogin: function () {
      if (!this.getAccess()) location.replace(loginUrl());
    },

    logout: function () {
      var self    = this;
      var refresh = this.getRefresh();
      var p = refresh
        ? fetch(API_BASE + '/auth/logout/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + self.getAccess(),
            },
            body: JSON.stringify({ refresh: refresh }),
          }).catch(function () {})
        : Promise.resolve();

      p.finally(function () {
        self.clear();
        location.replace(loginUrl());
      });
    },

    /** Verify token is still valid and user may use the dashboard. */
    verifySession: function () {
      var access = this.getAccess();
      if (!access) return Promise.reject(new Error('Not signed in'));
      var self = this;
      return fetchMe(access).then(function (res) {
        if (!res.ok || !res.body || res.body.success === false) {
          self.clear();
          throw new Error((res.body && res.body.message) || 'Session expired');
        }
        var user = res.body.data || {};
        var deny = assertDashboardAccess(user);
        if (deny) {
          self.clear();
          throw new Error(deny);
        }
        self.setUser(user);
        return user;
      });
    },
  };

  var form = document.getElementById('loginForm');
  if (!form) return;

  function ensureErrorBox() {
    var box = document.getElementById('loginError');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'loginError';
    box.className = 'alert alert-danger d-none small py-2';
    form.insertBefore(box, form.firstChild);
    return box;
  }

  var errBox = ensureErrorBox();
  var btn = form.querySelector('button[type="submit"]');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('d-none');
  }
  function clearError() {
    errBox.classList.add('d-none');
    errBox.textContent = '';
  }
  function setLoading(on) {
    if (!btn) return;
    btn.disabled = on;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = on ? 'Signing in…' : btn.dataset.label;
  }
  function fieldValue() {
    var userEl = form.username
      || document.getElementById('username')
      || document.getElementById('loginEmail');
    var passEl = form.password
      || document.getElementById('password')
      || document.getElementById('loginPassword');
    return {
      username: userEl ? String(userEl.value || '').trim() : '',
      password: passEl ? String(passEl.value || '') : '',
    };
  }

  // If a token already exists, only enter dashboard after /auth/me/ succeeds
  if (Auth.isLoggedIn()) {
    setLoading(true);
    Auth.verifySession()
      .then(function () { location.replace(dashboardUrl()); })
      .catch(function (err) {
        setLoading(false);
        if (err && err.message) showError(err.message);
      });
  }

  document.querySelectorAll('.toggle-password-btn').forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      var input = document.getElementById(toggle.getAttribute('data-target'));
      var icon = toggle.querySelector('i');
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      if (icon) {
        icon.classList.toggle('fa-eye', !show);
        icon.classList.toggle('fa-eye-slash', show);
      }
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();

    var creds = fieldValue();
    if (!creds.username || !creds.password) {
      showError('Please enter both username and password.');
      return;
    }

    setLoading(true);

    fetch(API_BASE + '/auth/login/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, status: res.status, body: json };
        }).catch(function () {
          return { ok: false, status: res.status, body: null };
        });
      })
      .then(function (res) {
        if (res.status === 429) {
          throw new Error('Too many login attempts. Wait a minute and try again.');
        }
        if (!res.ok || !res.body || !res.body.success) {
          var msg = (res.body && res.body.message) || 'Login failed.';
          if (res.status === 401) msg = 'Invalid username or password.';
          throw new Error(msg);
        }
        var data = res.body.data || {};
        if (!data.access) throw new Error('Login failed — no access token.');
        Auth.setTokens(data.access, data.refresh);
        if (data.user) Auth.setUser(data.user);

        // Second gate: confirm account is still allowed into the dashboard
        return Auth.verifySession().then(function () {
          location.replace(dashboardUrl());
        });
      })
      .catch(function (err) {
        showError(err.message || 'Login failed.');
        setLoading(false);
      });
  });
})();
