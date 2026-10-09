// PSX — memory card online: ogni giocatore salva la propria partita con un codice di 12 cifre + un PIN personale
// (4-8 cifre) e la riprende da qualsiasi dispositivo. Sul server ci sono solo impronte: SHA-256 del codice (nome della
// cartella) e scrypt del PIN con sale casuale (lento apposta: provare PIN a caso costa). Codice o PIN sbagliati danno lo
// stesso messaggio e contano per il blocco dell'indirizzo.
//
//   POST /api/card  {"pin":"1234"}                       → { code }            crea una card nuova (PIN obbligatorio)
//   GET  /api/card          (x-card, x-card-pin)          → { games: {...} }    cosa c'è sulla card
//   PUT  /api/card/<game>/<kind> (x-card, x-card-pin, corpo binario)          kind = state | srm
//   GET  /api/card/<game>/<kind> (x-card, x-card-pin)     → binario
// Card create prima del PIN (2026-10-09): la prima richiesta con un PIN valido lo imposta; senza PIN → 428 needPin.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CODE_DIGITS = 12;
const KINDS = { state: 24 * 1024 * 1024, srm: 2 * 1024 * 1024 }; // dimensione massima per tipo
const MAX_TOTAL = 20 * 1024 ** 3; // spazio totale per tutte le card (~4,5 MB a salvataggio: ~4500 salvataggi)
export const FAIL_WINDOW = 10 * 60 * 1000, MAX_FAILS = 60; // codici sbagliati per indirizzo
const CREATE_WINDOW = 60 * 60 * 1000, MAX_CREATES = 60; // card nuove per indirizzo all'ora

export const cleanCode = (v) => String(v || '').replace(/\D/g, '');
export const PIN_RE = /^\d{4,8}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 }; // ~50 ms a controllo, nei thread di Node (non blocca il server)
const scrypt = (pin, salt) => new Promise((ok, ko) => crypto.scrypt(pin, salt, 32, SCRYPT, (e, k) => (e ? ko(e) : ok(k))));
export async function makePin(pin) { const salt = crypto.randomBytes(16); return { salt: salt.toString('hex'), hash: (await scrypt(pin, salt)).toString('hex') }; }
export async function checkPin(pin, rec) {
  if (!rec || !PIN_RE.test(pin)) return false;
  const k = await scrypt(pin, Buffer.from(rec.salt, 'hex'));
  const want = Buffer.from(rec.hash, 'hex');
  return k.length === want.length && crypto.timingSafeEqual(k, want);
}
export const formatCode = (c) => c.replace(/(\d{4})(?=\d)/g, '$1-');

export function createCards({ root, games }) {
  const dir = path.join(root, 'saves');
  fs.mkdirSync(dir, { recursive: true });
  const fails = new Map(), creates = new Map();
  const hashOf = (code) => crypto.createHash('sha256').update('tweetstation-card|' + code).digest('hex');
  const cardDir = (code) => path.join(dir, hashOf(code));
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  const recent = (map, ip, win) => { const now = Date.now(); const l = (map.get(ip) || []).filter((t) => now - t < win); map.set(ip, l); return l; };

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readMeta = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')); } catch { return null; } };
  const writeMeta = (d, m) => fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(m));
  function usedBytes() {
    let n = 0;
    for (const c of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, c))) n += fs.statSync(path.join(dir, c, f)).size;
    return n;
  }

  // la card richiesta (codice + PIN giusti), oppure null (e il tentativo sbagliato conta per il blocco)
  const WRONG = 'Wrong card code or PIN.';
  async function openCard(req, res) {
    const ip = ipOf(req);
    if (recent(fails, ip, FAIL_WINDOW).length >= MAX_FAILS) { json(res, 429, { error: 'Too many wrong attempts. Try again later.' }); return null; }
    const code = cleanCode(req.headers['x-card']);
    const pin = String(req.headers['x-card-pin'] || '');
    const d = code.length === CODE_DIGITS ? cardDir(code) : null;
    const meta = d && readMeta(d);
    const wrong = () => { fails.get(ip).push(Date.now()); json(res, 404, { error: WRONG }); return null; };
    if (!meta) { if (PIN_RE.test(pin)) await scrypt(pin, 'x'); return wrong(); } // stesso tempo di un PIN sbagliato
    if (meta.pin) return (await checkPin(pin, meta.pin)) ? { d, meta } : wrong();
    // card di prima del PIN: il primo PIN valido la protegge da qui in avanti
    if (!PIN_RE.test(pin)) { json(res, 428, { error: 'Choose a PIN for this card.', needPin: true }); return null; }
    meta.pin = await makePin(pin);
    writeMeta(d, meta);
    return { d, meta };
  }
  function readSmallBody(req, max = 512) {
    return new Promise((ok) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > max) { b = ''; req.destroy(); } });
      req.on('end', () => ok(b));
      req.on('error', () => ok(''));
    });
  }

  return function handle(req, res, p) {
    if (req.method === 'POST' && p === '/api/card') {
      const ip = ipOf(req);
      if (recent(creates, ip, CREATE_WINDOW).length >= MAX_CREATES) return json(res, 429, { error: 'Too many new cards. Try again later.' });
      return readSmallBody(req).then(async (body) => {
      let pin = '';
      try { pin = String(JSON.parse(body || '{}').pin || ''); } catch {}
      if (!PIN_RE.test(pin)) return json(res, 400, { error: 'Choose a PIN of 4 to 8 digits.' });
      const pinRec = await makePin(pin);
      let code, d;
      // codice casuale (generatore crittografico) e mai doppio: la cartella si crea in un solo passaggio, se esiste già
      // (stesso codice, anche nello stesso istante di un'altra richiesta) si genera un altro codice
      for (;;) {
        code = Array.from({ length: CODE_DIGITS }, () => crypto.randomInt(10)).join('');
        d = cardDir(code);
        try { fs.mkdirSync(d); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      writeMeta(d, { created: new Date().toISOString(), games: {}, pin: pinRec });
      creates.get(ip).push(Date.now());
      return json(res, 200, { code, pretty: formatCode(code) });
      });
    }
    if (req.method === 'GET' && p === '/api/card') {
      return openCard(req, res).then((c) => c && json(res, 200, { games: c.meta.games }));
    }
    const m = /^\/api\/card\/([^/]+)\/(state|srm)$/.exec(p);
    if (!m) return json(res, 404, { error: 'Not found.' });
    const [, game, kind] = m;
    if (!games().some((g) => g.id === game)) return json(res, 404, { error: 'Unknown game.' });
    return openCard(req, res).then((c) => {
    if (!c) return;
    const file = path.join(c.d, `${game}.${kind}`);

    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Nothing saved for this game.' });
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    if (req.method === 'PUT') {
      const max = KINDS[kind];
      if (Number(req.headers['content-length'] || 0) > max) return json(res, 413, { error: 'Save too large.' });
      const parts = [];
      let size = 0, tooBig = false;
      req.on('data', (b) => { size += b.length; if (size > max) { tooBig = true; req.destroy(); } else parts.push(b); });
      req.on('end', () => {
        if (tooBig) return;
        if (!size) return json(res, 400, { error: 'Empty save.' });
        if (usedBytes() + size > MAX_TOTAL) return json(res, 507, { error: 'Server storage full.' });
        fs.writeFileSync(file, Buffer.concat(parts));
        const g = c.meta.games[game] || (c.meta.games[game] = {});
        g[kind] = size;
        g.updated = new Date().toISOString();
        writeMeta(c.d, c.meta);
        json(res, 200, { ok: true, game, kind, size, updated: g.updated });
      });
      req.on('close', () => { if (tooBig && !res.headersSent) json(res, 413, { error: 'Save too large.' }); });
      return;
    }
    return json(res, 405, { error: 'Method not allowed.' });
    });
  };
}
