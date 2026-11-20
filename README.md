# CUE Frontend

Public site + operator dashboard UI for CUE.

## Pair with backend

Backend repo: https://github.com/Wilson-1907/cue-backend

1. Deploy **cue-backend** on Render and copy its URL  
2. Edit [`js/config.js`](js/config.js):

```js
window.CUE_CONFIG = {
  API_BASE: 'https://YOUR-CUE-API.onrender.com/api/v1',
  WS_BASE: 'wss://YOUR-CUE-API.onrender.com/ws/stream/',
};
```

3. Deploy this repo on Render → **New → Static Site** (or Blueprint)

## Local

```powershell
cd cue-frontend
python -m http.server 5500
```

Open http://127.0.0.1:5500/ — set `config.js` to `http://127.0.0.1:8000/api/v1` if the API runs locally.

## Pages

- `/` / `index.html` — landing  
- `login.html` — operator login  
- `dashboard.html` — app shell  
- `notices.html`, `about.html`, `contact.html` — public  
