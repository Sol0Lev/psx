// TweetStation — server statico + meta tag della Player Card di X. Nessuna dipendenza.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { convertJob, safeName, ACCEPTED_EXT } from './convert.mjs';
import { attachNetplay } from './netplay.mjs';
import { createCards } from './cards.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const GAMES = path.join(ROOT, 'games');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

export function loadCatalog(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'games.json'), 'utf8')).games;
}

export function catalogWithStatus(games, gamesDir = GAMES) {
  return games.map((g) => {
    let bytes = 0, available = g.files.length > 0;
    for (const f of g.files) {
      try { bytes += fs.statSync(path.join(gamesDir, g.id, f)).size; } catch { available = false; }
    }
    return { ...g, available, bytes };
  });
}

// Account X associato alle card (TWITTER_SITE per cambiarlo)
const CARD_SITE = process.env.TWITTER_SITE || '';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function cardVersion(rel = 'card.png') {
  try { return Math.floor(fs.statSync(path.join(PUBLIC, rel)).mtimeMs / 1000).toString(36); } catch { return '0'; }
}
// anteprima del gioco (public/cards/<id>.png, tools/make-cards.mjs) se c'è, altrimenti quella generale
function cardImage(game, publicUrl) {
  const rel = game && /^[\w-]+$/.test(game.id) && fs.existsSync(path.join(PUBLIC, 'cards', `${game.id}.png`)) ? `cards/${game.id}.png` : 'card.png';
  return `${publicUrl}/${rel}?v=${cardVersion(rel)}`;
}

export function cardMeta(game, publicUrl) {
  const id = game ? game.id : '';
  const title = game ? `Play ${game.title} right inside X` : 'PSX — a PS1 right inside X';
  const desc = 'A 32-bit console in your feed. Tap to power on. Touch, keyboard and gamepad.';
  const player = `${publicUrl}/play/${encodeURIComponent(id || 'psx')}`;
  // X tiene in memoria le immagini per indirizzo: la data del file nell'indirizzo fa riscaricare quella nuova
  const image = cardImage(game, publicUrl);
  return [
    ['name', 'twitter:card', 'player'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', desc],
    ['name', 'twitter:image', image],
    ['name', 'twitter:image:alt', game ? `${game.title} on PSX` : 'PSX, a PS1 inside X'],
    ['name', 'twitter:player', player],
    ['name', 'twitter:player:width', '600'],
    ['name', 'twitter:player:height', '600'],
    ['property', 'og:type', 'website'],
    ['property', 'og:title', title],
    ['property', 'og:description', desc],
    ['property', 'og:image', image],
    ['property', 'og:url', `${publicUrl}/r/${encodeURIComponent(id || 'psx')}`],
    // account X che pubblica: nelle regole delle Player Card è obbligatorio (Tweetboy lo mette)
    ['name', 'twitter:site', CARD_SITE],
  ].filter(([, , v]) => v).map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`).join('\n');
}

// Content-Security-Policy della pagina: script solo nostri (EmulatorJS è copiato in public/ejs) + blob/wasm che l'emulatore crea.
// Niente frame-ancestors: la pagina DEVE poter stare nell'iframe di X.
export function csp(nonce) {
  return [
    "default-src 'self'",
    // 'unsafe-eval': il codice Emscripten di EmulatorJS esegue stringhe (provato: senza, il core non parte)
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
    "worker-src 'self' blob:",
    "connect-src 'self' blob: data:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com data:",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

// Header di sicurezza su ogni risposta
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
};
// robots.txt: fuori i motori di ricerca, dentro il lettore delle card di X.
// (Niente X-Robots-Tag noindex: rischia di far scartare l'anteprima anche a X.)
const ROBOTS = 'User-agent: Twitterbot\nAllow: /\n\nUser-agent: *\nDisallow: /\n';

function renderIndex(game, publicUrl, nonce) {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const boot = `<script nonce="${nonce}">window.TS_GAME=${JSON.stringify(game ? game.id : null)};</script>`;
  return html.replace('<!--CARD_META-->', cardMeta(game, publicUrl) + '\n' + boot);
}

// Cache del browser: l'emulatore (EmulatorJS 4.2.3, non cambia) per 7 giorni, copertine 1 giorno;
// pagina, app.js e style.css sempre ricontrollati (no-cache + ETag: se non sono cambiati arriva un 304 vuoto).
export function staticCache(p) {
  if (p.startsWith('/ejs/')) return 'public, max-age=604800';
  if (p.startsWith('/covers/')) return 'public, max-age=86400';
  return 'no-cache';
}

function sendFile(req, res, file, type, cache = 'no-cache') {
  let st;
  try { st = fs.statSync(file); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  // ETag (dimensione + data): chi ha già il file riceve 304 senza corpo invece di riscaricarlo tutto
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = { 'Content-Type': type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': cache, ETag: etag };
  if (!req.headers.range && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    if (start < 0) start = 0;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeFile(fs.createReadStream(file, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  pipeFile(fs.createReadStream(file), res);
}

// Un errore di lettura (file sparito, disco) non deve far cadere il server: si chiude solo quella risposta.
function pipeFile(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(obj)); };
const MAX_UPLOAD = 4 * 1024 ** 3; // 4 GB per file

// Chiave per l'upload: da UPLOAD_TOKEN, altrimenti generata una volta e salvata in .upload-key (ignorato da git).
// Mai stampata: si legge dal file.
export function loadUploadKey(root = ROOT) {
  if (process.env.UPLOAD_TOKEN) return process.env.UPLOAD_TOKEN;
  const f = path.join(root, '.upload-key');
  try { const k = fs.readFileSync(f, 'utf8').trim(); if (k.length >= 24) return k; } catch {}
  const k = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(f, k + '\n', { mode: 0o600 });
  return k;
}

// protocollo con cui il visitatore è arrivato al proxy (Cloudflare): 'http', 'https' o '' se non c'è proxy
export function forwardedProto(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xf) return xf;
  const m = /"scheme":"(https?)"/.exec(String(req.headers['cf-visitor'] || ''));
  return m ? m[1] : '';
}

export function createServer({ publicUrl, root = ROOT, uploadToken = process.env.UPLOAD_TOKEN, convert = convertJob,
  enableUpload = process.env.ENABLE_UPLOAD === '1' } = {}) {
  // Tentativi con chiave sbagliata: dopo 10 in 10 minuti, upload bloccato per tutti per 10 minuti
  let badKeys = [], lockedUntil = 0;
  const gamesDir = path.join(root, 'games');
  const uploadsDir = path.join(root, 'uploads');
  const jobs = new Map(); // id → { id, dir, state, step, pct, error, result }
  const cards = createCards({ root, games: () => loadCatalog(root) }); // memory card online (cards.mjs)
  const publicJob = (j) => ({ id: j.id, state: j.state, step: j.step, pct: j.pct, error: j.error, result: j.result });

  // Upload + conversione. Con UPLOAD_TOKEN impostato serve l'header x-upload-token (obbligatorio se online).
  function handleUpload(req, res, p) {
    // Upload SPENTO di default (2026-10-09): si riaccende con ENABLE_UPLOAD=1 + UPLOAD_TOKEN, dopo WinRAR >= 7.13 e controlli sui file.
    if (!enableUpload || !uploadToken) return json(res, 404, { error: 'Upload is coming soon.' });
    const now = Date.now();
    if (now < lockedUntil) return json(res, 429, { error: 'Too many wrong keys. Try again later.' });
    const given = Buffer.from(String(req.headers['x-upload-token'] || ''));
    const want = Buffer.from(uploadToken);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      badKeys = badKeys.filter((t) => now - t < 600000).concat(now);
      if (badKeys.length >= 10) { lockedUntil = now + 600000; badKeys = []; }
      return json(res, 401, { error: 'Wrong upload key.' });
    }

    if (req.method === 'POST' && p === '/api/upload') {
      const id = crypto.randomBytes(8).toString('hex');
      const dir = path.join(uploadsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      jobs.set(id, { id, dir, state: 'uploading', step: 'uploading', pct: null });
      return json(res, 200, { id, accepted: ACCEPTED_EXT });
    }
    let m = /^\/api\/upload\/([0-9a-f]{16})\/([^/]+)$/.exec(p);
    if (req.method === 'PUT' && m) {
      const job = jobs.get(m[1]);
      let name = null;
      try { name = safeName(decodeURIComponent(m[2])); } catch {}
      if (!job || job.state !== 'uploading') return json(res, 404, { error: 'Unknown upload.' });
      if (!name || !ACCEPTED_EXT.includes(path.extname(name).toLowerCase())) return json(res, 415, { error: `Unsupported file: ${m[2]}` });
      if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return json(res, 413, { error: 'File too large (max 4 GB).' });
      const out = fs.createWriteStream(path.join(job.dir, name));
      let size = 0, failed = false;
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD && !failed) { failed = true; req.destroy(); } });
      req.pipe(out);
      out.on('finish', () => (failed ? json(res, 413, { error: 'File too large.' }) : json(res, 200, { ok: true, name, size })));
      out.on('error', (e) => json(res, 500, { error: e.message }));
      return;
    }
    m = /^\/api\/upload\/([0-9a-f]{16})\/convert$/.exec(p);
    if (req.method === 'POST' && m) {
      const job = jobs.get(m[1]);
      if (!job || job.state !== 'uploading') return json(res, 404, { error: 'Unknown upload.' });
      if ([...jobs.values()].some((j) => j.state === 'working')) return json(res, 409, { error: 'Another game is being converted, try again in a minute.' });
      let body = '';
      req.on('data', (c) => { if (body.length < 2000) body += c; });
      req.on('end', () => {
        try { job.title = (JSON.parse(body || '{}').title || '').toString(); } catch {}
        job.state = 'working';
        convert(job, { root }).finally(() => console.log(`[upload ${job.id}] ${job.state} ${job.error || JSON.stringify(job.result)}`));
        json(res, 202, publicJob(job));
      });
      return;
    }
    m = /^\/api\/upload\/([0-9a-f]{16})$/.exec(p);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      return job ? json(res, 200, publicJob(job)) : json(res, 404, { error: 'Unknown upload.' });
    }
    return json(res, 405, { error: 'Method not allowed.' });
  }

  // Diario: al massimo 600 messaggi al minuto in tutto (100 giocatori), il resto si scarta (niente log riempiti da altri)
  let logWindow = Date.now(), logCount = 0;

  const httpsOnly = /^https:\/\//.test(publicUrl || '');
  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Arrivati in http (es. "psxsol0lev.xyz" scritto senza https://): si manda alla versione protetta. Senza https il
    // browser spegne crypto.subtle (codice lobby VERSUS: errore visto su iPhone 2026-10-09) e altre funzioni.
    // Cloudflare dice com'è arrivata la richiesta con x-forwarded-proto / cf-visitor; in locale (niente header) nulla cambia.
    const proto = forwardedProto(req);
    if (httpsOnly && proto === 'http') {
      res.writeHead(301, { Location: publicUrl.replace(/\/$/, '') + req.url, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (httpsOnly && proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // Registro visite delle pagine (non dei pezzi di gioco): serve a vedere se il lettore di X (Twitterbot) passa e cosa riceve
    if (!req.url.startsWith('/games/') && !req.url.startsWith('/ejs/') && !req.url.startsWith('/api/log')) {
      res.on('finish', () => console.log(`[visit] ${res.statusCode} ${req.method} ${req.url.slice(0, 120)} ua=${String(req.headers['user-agent'] || '').slice(0, 90)}`));
    }
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return notFound(res); }
    if (url.pathname === '/api/upload' || url.pathname.startsWith('/api/upload/')) return handleUpload(req, res, url.pathname);
    if (url.pathname === '/api/card' || url.pathname.startsWith('/api/card/')) return cards(req, res, url.pathname);
    // Diario dal browser dei giocatori (tappe ed errori), per capire cosa succede su telefoni che non vediamo.
    if (req.method === 'POST' && url.pathname === '/api/log') {
      let body = '';
      req.on('data', (c) => { if (body.length < 4096) body += c; });
      req.on('end', () => {
        if (Date.now() - logWindow > 60000) { logWindow = Date.now(); logCount = 0; }
        if (++logCount <= 600) {
          const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
          console.log(`[client ${ip}] ${body.slice(0, 4096).replace(/[\s\u0000-\u001f]+/g, ' ')}`);
        }
        res.writeHead(204); res.end();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return notFound(res); }
    const games = loadCatalog(root);
    const base = publicUrl || `http://${req.headers.host}`;

    if (p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(ROBOTS);
    }
    const card = /^\/(r|play)\/([^/]+)\/?$/.exec(p);
    if (p === '/' || card) {
      const game = card ? games.find((g) => g.id === card[2]) || null : null;
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp(nonce) });
      return res.end(req.method === 'HEAD' ? undefined : renderIndex(game, base, nonce));
    }
    // EmulatorJS chiede la lista delle stanze: niente lista pubblica, si entra solo con codice + password
    if (p === '/list') return json(res, 200, {});
    if (p === '/api/config') return json(res, 200, { upload: !!(enableUpload && uploadToken) });
    if (p === '/api/games') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify(catalogWithStatus(games, gamesDir)));
    }
    const g = /^\/games\/([^/]+)\/([^/]+)$/.exec(p);
    if (g) {
      // Solo file dichiarati nel catalogo: niente path traversal, niente file estranei.
      const game = games.find((x) => x.id === g[1]);
      if (!game || !game.files.includes(g[2])) return notFound(res);
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (process.env.LOG_GAMES) console.log(new Date().toISOString(), req.method, p, req.headers.range || 'full');
      const send = () => sendFile(req, res, path.join(gamesDir, game.id, g[2]), undefined, 'public, max-age=86400');
      // GAME_DELAY_MS: ritardo artificiale per simulare la rete del telefono durante i test
      const delay = Number(process.env.GAME_DELAY_MS || 0);
      return delay ? setTimeout(send, delay) : send();
    }
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return notFound(res);
    sendFile(req, res, file, MIME[path.extname(file).toLowerCase()], staticCache(p));
  });
  // Connessioni lente o appese (slowloris): tagliate
  server.headersTimeout = 20000;
  server.requestTimeout = 60000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const enableUpload = process.env.ENABLE_UPLOAD === '1';
  const uploadToken = enableUpload ? loadUploadKey() : undefined;
  const server = createServer({ publicUrl: process.env.PUBLIC_URL, enableUpload, uploadToken });
  // server ponte TURN (VPS: /etc/psx/turn.env letto da systemd; senza, solo collegamento diretto)
  const turn = process.env.TURN_SECRET
    ? { secret: process.env.TURN_SECRET, urls: String(process.env.TURN_URLS || '').split(',').filter(Boolean) } : null;
  attachNetplay(server, { log: (m) => console.log(m), turn });
  // HOST=127.0.0.1 sul VPS: raggiungibile solo dal tunnel Cloudflare sullo stesso server (oltre al firewall)
  server.listen(port, process.env.HOST || undefined, () => {
    console.log(`PSX su http://localhost:${port}`);
    console.log(enableUpload ? 'Upload ATTIVO con chiave (file .upload-key). Pagina admin: /?admin' : 'Upload spento (ENABLE_UPLOAD=1 per attivarlo).');
  });
}
