/* CUE Assistance floating chat (text + voice) + bottom contact FABs */
(function () {
  'use strict';

  if (window.__MSINGI_BOOTSTRAPPED__) return;
  window.__MSINGI_BOOTSTRAPPED__ = true;

  var PHONE_DISPLAY = '0701519479';
  var PHONE_E164 = '254701519479';
  var API_BASE = (window.CUE_CONFIG && window.CUE_CONFIG.API_BASE)
    || (window.AP && window.AP.CONFIG && window.AP.CONFIG.API_BASE)
    || (function () {
      var host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000/api/v1';
      return location.origin.replace(/\/$/, '') + '/api/v1';
    })();
  var BRAND = 'CUE Assistance';

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function ensureCss() {
    if (document.getElementById('msingi-widget-css')) return;
    var link = document.createElement('link');
    link.id = 'msingi-widget-css';
    link.rel = 'stylesheet';
    var scripts = document.getElementsByTagName('script');
    var src = '';
    for (var i = scripts.length - 1; i >= 0; i--) {
      if ((scripts[i].src || '').indexOf('msingi-widget.js') !== -1) {
        src = scripts[i].src.replace(/js\/msingi-widget\.js.*$/, 'css/msingi-widget.css');
        break;
      }
    }
    link.href = src || 'css/msingi-widget.css';
    document.head.appendChild(link);
  }

  var _audioEl = null;
  var _ttsToken = 0;

  function stopSpeech() {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
    if (_audioEl) {
      try { _audioEl.pause(); } catch (_) {}
      _audioEl = null;
    }
  }

  function speakBrowser(text) {
    if (!window.speechSynthesis || !text) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'sw-KE';
      u.rate = 1.05;
      var voices = window.speechSynthesis.getVoices() || [];
      var sw = voices.find(function (v) {
        return /^sw/i.test(v.lang) || /swahili/i.test(v.name);
      });
      if (sw) u.voice = sw;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }

  function shortForTts(text) {
    var t = String(text || '').trim();
    if (t.length <= 280) return t;
    return t.slice(0, 277).replace(/\s+\S*$/, '') + '…';
  }

  /**
   * Fast voice: speak immediately with the browser, then optionally upgrade
   * to Msingi TTS if it returns quickly. Never block the chat on remote TTS.
   */
  function speakSwahili(text) {
    if (!text) return;
    stopSpeech();
    var token = ++_ttsToken;
    var clip = shortForTts(text);
    speakBrowser(clip);

    var tokenJwt = localStorage.getItem('ap_access') || '';
    var headers = { 'Content-Type': 'application/json' };
    if (tokenJwt) headers.Authorization = 'Bearer ' + tokenJwt;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 3500);

    fetch(API_BASE.replace(/\/$/, '') + '/msingi/speak/', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ text: clip }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('tts');
        return res.blob();
      })
      .then(function (blob) {
        if (token !== _ttsToken) return;
        // Remote audio ready — switch from browser voice
        try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
        var url = URL.createObjectURL(blob);
        _audioEl = new Audio(url);
        _audioEl.play().catch(function () {});
        _audioEl.onended = function () {
          try { URL.revokeObjectURL(url); } catch (_) {}
        };
      })
      .catch(function () {
        clearTimeout(timer);
        // Keep browser speech already playing
      });
  }

  function createUI() {
    ensureCss();

    var stack = el(
      '<div class="ms-fab-stack" id="msingiRoot">' +
        '<div class="ms-chat-panel" id="msingiPanel" role="dialog" aria-label="CUE Assistance">' +
          '<div class="ms-chat-head">' +
            '<div class="ms-chat-avatar">C</div>' +
            '<div><h3>CUE Assistance</h3><p>Msaidizi · Kiswahili & English · maandishi & sauti</p></div>' +
            '<button type="button" class="ms-chat-close" id="msingiClose" aria-label="Funga">✕</button>' +
          '</div>' +
          '<div class="ms-chat-body" id="msingiBody"></div>' +
          '<div class="ms-chat-foot">' +
            '<textarea id="msingiInput" rows="1" placeholder="Ask anything… / Uliza…"></textarea>' +
            '<button type="button" class="ms-icon-btn mic" id="msingiMic" title="Voice / Sauti"><i class="bi bi-mic-fill"></i></button>' +
            '<button type="button" class="ms-icon-btn send" id="msingiSend" title="Send"><i class="bi bi-send-fill"></i></button>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="ms-chat-launcher" id="msingiLaunch" aria-expanded="false" title="CUE Assistance">' +
          '<i class="bi bi-chat-dots-fill"></i>' +
        '</button>' +
      '</div>'
    );

    // Open Gmail compose in the browser (mailto only opens a local mail app)
    function gmailCompose(to) {
      var su = encodeURIComponent('CUE inquiry');
      var body = encodeURIComponent(
        'Habari CUE team,\n\nMy name is: \nPhone: \n\nI would like help with: \n\nAsante.'
      );
      return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(to) +
        '&su=' + su + '&body=' + body;
    }
    var mail1 = gmailCompose('itswanjiru@gmail.com');
    var mail2 = gmailCompose('brianziro44@gmail.com');

    var bar = el(
      '<div class="ms-contact-bar" id="msingiContactBar" aria-label="Quick contact">' +
        '<a class="wa" href="https://wa.me/' + PHONE_E164 + '" target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp"><i class="bi bi-whatsapp"></i></a>' +
        '<a class="call" href="tel:' + PHONE_DISPLAY + '" title="Call" aria-label="Call"><i class="bi bi-telephone-fill"></i></a>' +
        '<a class="sms" href="sms:' + PHONE_DISPLAY + '" title="SMS" aria-label="SMS"><i class="bi bi-chat-left-text-fill"></i></a>' +
        '<a class="mail" href="' + mail1 + '" target="_blank" rel="noopener" title="Gmail: itswanjiru@gmail.com" aria-label="Email itswanjiru@gmail.com"><i class="bi bi-envelope-fill"></i></a>' +
        '<a class="mail2" href="' + mail2 + '" target="_blank" rel="noopener" title="Gmail: brianziro44@gmail.com" aria-label="Email brianziro44@gmail.com"><i class="bi bi-envelope-at-fill"></i></a>' +
      '</div>'
    );

    document.body.appendChild(stack);
    document.body.appendChild(bar);

    if (!document.querySelector('link[href*="bootstrap-icons"]')) {
      var bi = document.createElement('link');
      bi.rel = 'stylesheet';
      bi.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css';
      document.head.appendChild(bi);
    }

    return {
      panel: document.getElementById('msingiPanel'),
      body: document.getElementById('msingiBody'),
      input: document.getElementById('msingiInput'),
      send: document.getElementById('msingiSend'),
      mic: document.getElementById('msingiMic'),
      launch: document.getElementById('msingiLaunch'),
      close: document.getElementById('msingiClose'),
    };
  }

  function addMsg(body, role, text, meta) {
    var div = document.createElement('div');
    div.className = 'ms-msg ' + role;
    div.textContent = text;
    if (meta) {
      var m = document.createElement('span');
      m.className = 'ms-meta';
      m.textContent = meta;
      div.appendChild(m);
    }
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function askCue(message) {
    var token = localStorage.getItem('ap_access') || '';
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    var bases = [
      API_BASE.replace(/\/$/, ''),
      'http://127.0.0.1:8000/api/v1',
      'http://localhost:8000/api/v1',
    ].filter(function (b, i, arr) { return arr.indexOf(b) === i; });

    function tryBase(i) {
      if (i >= bases.length) {
        return Promise.reject(new Error('Ombi limeshindikana'));
      }
      return fetch(bases[i] + '/msingi/chat/', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ message: message }),
      }).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok || json.success === false) {
            throw new Error((json && json.message) || 'Ombi limeshindikana');
          }
          return (json && json.data) || json;
        });
      }).catch(function () {
        return tryBase(i + 1);
      });
    }
    return tryBase(0);
  }

  function boot() {
    var ui = createUI();
    var listening = false;
    var recognition = null;

    addMsg(
      ui.body,
      'bot',
      'Habari! Mimi ni CUE Assistance. Niulize kwa maandishi au bonyeza maikrofoni — ninaweza kujibu maswali rahisi kuhusu CUE, namba, barua pepe, na dashibodi.',
      'karibu'
    );

    function openPanel(open) {
      ui.panel.classList.toggle('open', open);
      ui.launch.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) ui.input.focus();
    }

    ui.launch.addEventListener('click', function () {
      openPanel(!ui.panel.classList.contains('open'));
    });
    ui.close.addEventListener('click', function () { openPanel(false); });

    function submitText(text) {
      var msg = (text || '').trim();
      if (!msg) return;
      addMsg(ui.body, 'user', msg);
      ui.input.value = '';
      addMsg(ui.body, 'bot', '…', 'inasubiri');
      var pending = ui.body.lastChild;

      askCue(msg)
        .then(function (data) {
          var reply = (data && data.reply) || 'Samahani, sijapata jibu.';
          pending.textContent = reply;
          var meta = document.createElement('span');
          meta.className = 'ms-meta';
          meta.textContent = BRAND;
          pending.appendChild(meta);
          speakSwahili(reply);
        })
        .catch(function () {
          pending.textContent =
            'Samahani, sijaweza kuunganisha sasa. Hakikisha seva ya CUE inaendesha — au piga ' + PHONE_DISPLAY + '.';
          speakSwahili(pending.textContent);
        });
    }

    ui.send.addEventListener('click', function () { submitText(ui.input.value); });
    ui.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitText(ui.input.value);
      }
    });

    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      recognition = new SR();
      recognition.lang = 'en-KE';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = function (ev) {
        var said = ev.results[0][0].transcript;
        submitText(said);
      };
      recognition.onerror = function () {
        listening = false;
        ui.mic.classList.remove('listening');
      };
      recognition.onend = function () {
        listening = false;
        ui.mic.classList.remove('listening');
      };
    } else {
      ui.mic.title = 'Voice not supported in this browser';
      ui.mic.disabled = true;
      ui.mic.style.opacity = '0.5';
    }

    ui.mic.addEventListener('click', function () {
      if (!recognition) return;
      if (listening) {
        try { recognition.stop(); } catch (_) {}
        return;
      }
      openPanel(true);
      listening = true;
      ui.mic.classList.add('listening');
      try {
        recognition.lang = 'en-KE';
        recognition.start();
      } catch (_) {
        try {
          recognition.lang = 'sw-KE';
          recognition.start();
        } catch (e2) {
          listening = false;
          ui.mic.classList.remove('listening');
        }
      }
    });

    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = function () {
        window.speechSynthesis.getVoices();
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
