// TweetStation — stanze VERSUS (1 contro 1) compatibili con il netplay di EmulatorJS 4.2.3 (socket.io).
// Il client EmulatorJS manda: open-room {extra, maxPlayers, password}, join-room {extra}, data-message, e ascolta users-updated.
// Differenze volute rispetto al server pubblico di EmulatorJS:
//  - nessuna lista pubblica delle stanze (/list risponde vuoto): si entra solo con codice + password;
//  - la password è obbligatoria e la controlla il server (il client EmulatorJS da solo non la invia al join:
//    la nostra pagina aggiunge "password" a join-room);
//  - massimo 2 giocatori, stanze legate al gioco, limiti su tentativi, numero di stanze e dimensione dei messaggi.
// Aggiunte (2026-10-09):
//  - SPETTATORI: watch-room con lo stesso codice + password, massimo MAX_WATCHERS per stanza; non contano come
//    giocatori, non mandano tasti. Il giocatore 1 manda loro il video con una connessione diretta per spettatore.
//  - PARTITA VELOCE: quick {game} → il primo che aspetta riceve un codice e una password casuali e apre la stanza,
//    il secondo riceve gli stessi e ci entra. Una sola attesa per gioco.
//  - signal con "to": il messaggio va solo a quella connessione (se è nella stessa stanza); il server aggiunge "from".
import crypto from 'node:crypto';
import { Server } from 'socket.io';

export const CODE_RE = /^[A-HJ-NP-Z2-9]{4,8}$/; // niente I, O, 0, 1 (si confondono)
export const MAX_ROOMS = 300; // 100 amici insieme = 50 sfide + partite veloci e spettatori
const MAX_MSG = 1024 * 1024; // messaggi piccoli: video e tasti viaggiano in WebRTC, qui solo segnali (max 64 KB)
export const FAIL_WINDOW = 10 * 60 * 1000, MAX_FAILS = 60; // ogni "lobby nuova" costa un tentativo (il primo join non trova la stanza)
export const MAX_WATCHERS = 4; // ogni spettatore costa ~1,5 Mbit/s in uscita al giocatore 1
const QUICK_TTL = 3 * 60 * 1000; // un'attesa di partita veloce scade dopo 3 minuti
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => Array.from({ length: 8 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const randomPw = () => String(crypto.randomInt(1e7, 1e8));

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

// Server ponte (TURN, coturn sul VPS): quando il collegamento diretto tra i due non riesce (5G/CGNAT, 5G + Wi-Fi)
// video e tasti passano da lì. Credenziali temporanee (TURN REST: utente "scadenza:caso", password HMAC-SHA1 col
// segreto condiviso con coturn), date solo a chi è dentro una stanza.
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const TURN_TTL = 6 * 60 * 60; // secondi
export function turnCredentials(secret, now = Date.now()) {
  const username = `${Math.floor(now / 1000) + TURN_TTL}:${crypto.randomBytes(4).toString('hex')}`;
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') };
}

export function attachNetplay(httpServer, { log = () => {}, turn = null } = {}) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: MAX_MSG,
    serveClient: true, // /socket.io/socket.io.min.js: serve alla pagina per entrare in lobby prima di avviare l'emulatore
    cors: { origin: false }, // solo dalla nostra pagina
    pingTimeout: 20000,
  });
  const rooms = new Map(); // key "game|CODE" → { key, code, game, pw, owner, players: {userid: extra}, sockets: Map(socketId → userid), watchers: Set(socketId) }
  const quick = new Map(); // game → { code, pw, socket, t } chi aspetta una partita veloce
  const fails = new Map(); // ip → [timestamps]

  const ipOf = (s) => String(s.handshake.headers['cf-connecting-ip'] || s.handshake.address || '');
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW);
    fails.set(ip, list);
    return list.length >= MAX_FAILS;
  };
  const fail = (ip) => { fails.set(ip, (fails.get(ip) || []).concat(Date.now())); };

  // extra arriva dal client: si tengono solo i campi noti, come stringhe corte
  function cleanExtra(e) {
    if (!e || typeof e !== 'object') return null;
    const out = {
      domain: str(e.domain, 200) || '',
      game_id: String(e.game_id ?? '').slice(0, 40),
      room_name: str(e.room_name, 16),
      player_name: (str(e.player_name, 20) || 'Player').replace(/[<>]/g, ''),
      userid: str(e.userid, 64),
      sessionid: str(e.sessionid, 64) || '',
    };
    return out.room_name && out.userid ? out : null;
  }

  const watchList = (room) => [...room.watchers];
  const tellWatchers = (room) => io.to(room.key).emit('watchers', watchList(room));
  function leave(socket) {
    for (const [g, q] of quick) if (q.socket === socket.id) quick.delete(g);
    const key = socket.data.room;
    if (!key) return;
    socket.data.room = null;
    const room = rooms.get(key);
    if (!room) return;
    if (socket.data.watching) {
      socket.data.watching = false;
      room.watchers.delete(socket.id);
      socket.leave(key + '#w');
      return tellWatchers(room);
    }
    const uid = room.sockets.get(socket.id);
    room.sockets.delete(socket.id);
    if (uid) delete room.players[uid];
    socket.leave(key);
    if (socket.id === room.owner || room.sockets.size === 0) {
      // chi ha creato la stanza se ne va: la stanza si chiude per tutti
      rooms.delete(key);
      io.in(key).disconnectSockets(true);
      io.in(key + '#w').disconnectSockets(true);
      log(`[versus] stanza ${room.code} chiusa`);
    } else {
      io.to(key).emit('users-updated', room.players);
    }
  }

  io.on('connection', (socket) => {
    socket.data.room = null;

    socket.on('open-room', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      if (socket.data.room) return reply('Already in a room.');
      const extra = cleanExtra(data && data.extra);
      const pw = str(data && data.password, 64);
      if (!extra || !CODE_RE.test(extra.room_name)) return reply('Invalid room code.');
      if (!pw || pw.length < 3) return reply('Password required (min 3 characters).');
      if (rooms.size >= MAX_ROOMS) return reply('Server is full, try later.');
      const key = `${extra.game_id}|${extra.room_name}`;
      if (rooms.has(key)) return reply('Room code already in use.');
      const room = { key, code: extra.room_name, game: extra.game_id, pw: hash(pw), owner: socket.id,
        players: { [extra.userid]: extra }, sockets: new Map([[socket.id, extra.userid]]), watchers: new Set() };
      rooms.set(key, room);
      socket.data.room = key;
      socket.join(key);
      log(`[versus] stanza ${room.code} creata (${room.game})`);
      reply(null);
      io.to(key).emit('users-updated', room.players);
    });

    socket.on('join-room', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const ip = ipOf(socket);
      if (tooMany(ip)) return reply('Too many attempts, wait a few minutes.');
      if (socket.data.room) return reply('Already in a room.');
      const extra = cleanExtra(data && data.extra);
      const pw = str(data && data.password, 64) || '';
      const code = extra && extra.room_name ? extra.room_name.toUpperCase() : '';
      const room = extra && rooms.get(`${extra.game_id}|${code}`);
      // stesso messaggio per stanza inesistente e password sbagliata: non si scopre quali codici esistono
      if (!room || !crypto.timingSafeEqual(room.pw, hash(pw))) { fail(ip); return reply('Wrong room code or password.'); }
      if (room.sockets.size >= 2) return reply('Room is full.');
      extra.room_name = room.code;
      room.players[extra.userid] = extra;
      room.sockets.set(socket.id, extra.userid);
      socket.data.room = room.key;
      socket.join(room.key);
      log(`[versus] giocatore entrato in ${room.code}`);
      reply(null, room.players);
      io.to(room.key).emit('users-updated', room.players);
    });

    // spettatore: stesso codice e password dei giocatori, entra in un canale a parte (key#w)
    socket.on('watch-room', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const ip = ipOf(socket);
      if (tooMany(ip)) return reply('Too many attempts, wait a few minutes.');
      if (socket.data.room) return reply('Already in a room.');
      const extra = cleanExtra(data && data.extra);
      const pw = str(data && data.password, 64) || '';
      const code = extra && extra.room_name ? extra.room_name.toUpperCase() : '';
      const room = extra && rooms.get(`${extra.game_id}|${code}`);
      if (!room || !crypto.timingSafeEqual(room.pw, hash(pw))) { fail(ip); return reply('Nobody is playing with this code.'); }
      if (room.watchers.size >= MAX_WATCHERS) return reply('Too many spectators.');
      room.watchers.add(socket.id);
      socket.data.room = room.key;
      socket.data.watching = true;
      socket.join(room.key + '#w');
      log(`[versus] spettatore in ${room.code} (${room.watchers.size})`);
      reply(null, { players: Object.keys(room.players).length });
      tellWatchers(room);
    });
    // server per il collegamento: STUN per tutti, TURN (ponte) solo dentro una stanza
    socket.on('ice', (a, b) => {
      const cb = typeof a === 'function' ? a : b; // emit('ice', cb) oppure emit('ice', null, cb)
      if (typeof cb !== 'function') return;
      if (!socket.data.room || !turn || !turn.secret || !turn.urls.length) return cb(STUN);
      cb([...STUN, { urls: turn.urls, ...turnCredentials(turn.secret) }]);
    });
    socket.on('get-watchers', (cb) => {
      const room = socket.data.room && !socket.data.watching && rooms.get(socket.data.room);
      if (typeof cb === 'function') cb(room ? watchList(room) : []);
    });

    // partita veloce: chi arriva per primo aspetta, il secondo entra nella sua stanza
    socket.on('quick', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      if (socket.data.room) return reply({ error: 'Already in a room.' });
      const game = String((data && data.game) ?? '').slice(0, 40);
      if (!/^[\w-]{1,40}$/.test(game)) return reply({ error: 'Invalid game.' });
      const now = Date.now();
      const q = quick.get(game);
      if (q && q.socket !== socket.id && now - q.t < QUICK_TTL && io.sockets.sockets.has(q.socket)) {
        quick.delete(game);
        log(`[versus] partita veloce: abbinati in ${q.code}`);
        return reply({ action: 'join', code: q.code, pw: q.pw });
      }
      if (rooms.size >= MAX_ROOMS) return reply({ error: 'Server is full, try later.' });
      const entry = { code: randomCode(), pw: randomPw(), socket: socket.id, t: now };
      quick.set(game, entry);
      reply({ action: 'open', code: entry.code, pw: entry.pw });
    });

    // tasti, sincronizzazione e stato della partita: solo all'altro giocatore della stessa stanza
    socket.on('data-message', (msg) => {
      if (!socket.data.room || socket.data.watching || !msg || typeof msg !== 'object') return;
      socket.to(socket.data.room).emit('data-message', msg);
    });

    // WebRTC: il server fa solo da "presentatore" (offerta, risposta, candidati); poi video e tasti
    // viaggiano direttamente tra i due giocatori. Messaggi piccoli, solo dentro la propria stanza.
    socket.on('signal', (msg) => {
      if (!socket.data.room || !msg || typeof msg !== 'object') return;
      if (JSON.stringify(msg).length > 64 * 1024) return;
      const out = { ...msg, from: socket.id };
      delete out.to;
      if (typeof msg.to === 'string') {
        // solo a una connessione della stessa stanza (giocatore o spettatore)
        const target = io.sockets.sockets.get(msg.to);
        if (target && target.data.room === socket.data.room) target.emit('signal', out);
        return;
      }
      if (socket.data.watching) return; // gli spettatori parlano solo con "to"
      socket.to(socket.data.room).emit('signal', out); // ai giocatori (gli spettatori sono in key#w)
    });

    socket.on('disconnect', () => leave(socket));
  });

  return { io, rooms };
}
