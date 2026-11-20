/* CUE frontend — auto-select local API on localhost, Render everywhere else */
window.CUE_CONFIG = (function () {
  var host = (typeof location !== 'undefined' && location.hostname) || '';
  var local = host === 'localhost' || host === '127.0.0.1';
  if (local) {
    return {
      API_BASE: 'http://127.0.0.1:8000/api/v1',
      WS_BASE: 'ws://127.0.0.1:8000/ws/stream/',
    };
  }
  return {
    API_BASE: 'https://cue-backend-rd5t.onrender.com/api/v1',
    WS_BASE: 'wss://cue-backend-rd5t.onrender.com/ws/stream/',
  };
})();
