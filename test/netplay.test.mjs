// Stanze VERSUS: due "giocatori" finti con socket.io-client parlano col server come farebbe EmulatorJS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { attachNetplay, turnCredentials, MAX_FAILS } from '../netplay.mjs';
import crypto from 'node:crypto';

let server, base, io;
before(async () => {
  server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  ({ io } = attachNetplay(server));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

const sockets = [];
function player() {
  const s = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  return new Promise((r) => s.on('connect', () => r(s)));
}
// prima i client, poi il server (altrimenti la chiusura aspetta connessioni aperte)
after(() => { sockets.forEach((s) => s.close()); io.close(); });
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, (...args) => r(args)));
const extra = (code, uid, game = 'tekken3') => ({ domain: 'x', game_id: game, room_name: code, player_name: uid, userid: uid, sessionid: '' });
const once = (s, ev) => new Promise((r) => s.once(ev, r));

test('crea stanza, entra con password giusta, si scambiano messaggi', async () => {
  const p1 = await player();
  const p2 = await player();
  const [err1] = await emit(p1, 'open-room', { extra: extra('TK7Q', 'u1'), maxPlayers: 2, password: 'segreta' });
  assert.equal(err1, null);
  const updated = once(p1, 'users-updated');
  const [err2, players] = await emit(p2, 'join-room', { extra: extra('tk7q', 'u2'), password: 'segreta' });
  assert.equal(err2, null);
  assert.deepEqual(Object.keys(players).sort(), ['u1', 'u2']);
  assert.equal(Object.keys(await updated).length, 2);
  const got = once(p2, 'data-message');
  p1.emit('data-message', { 'sync-control': [{ frame: 10 }] });
  assert.deepEqual(await got, { 'sync-control': [{ frame: 10 }] });
});

test('password sbagliata e codice inesistente: stesso errore', async () => {
  const p1 = await player();
  await emit(p1, 'open-room', { extra: extra('ABCD', 'h1'), maxPlayers: 2, password: 'giusta' });
  const p2 = await player();
  const [e1] = await emit(p2, 'join-room', { extra: extra('ABCD', 'g1'), password: 'sbagliata' });
  const [e2] = await emit(p2, 'join-room', { extra: extra('ZZZZ', 'g1'), password: 'giusta' });
  assert.equal(e1, 'Wrong room code or password.');
  assert.equal(e2, e1);
  const [e3] = await emit(p2, 'join-room', { extra: extra('ABCD', 'g1'), password: 'giusta' }); // gioco giusto ma…
  assert.equal(e3, null);
});

test('stanza piena dopo 2, gioco diverso non vede la stanza, password obbligatoria', async () => {
  const p1 = await player(), p2 = await player(), p3 = await player(), p4 = await player();
  await emit(p1, 'open-room', { extra: extra('FULL', 'a'), maxPlayers: 2, password: 'pw1' });
  assert.equal((await emit(p2, 'join-room', { extra: extra('FULL', 'b'), password: 'pw1' }))[0], null);
  assert.equal((await emit(p3, 'join-room', { extra: extra('FULL', 'c'), password: 'pw1' }))[0], 'Room is full.');
  assert.equal((await emit(p4, 'join-room', { extra: extra('FULL', 'd', 'crash'), password: 'pw1' }))[0], 'Wrong room code or password.');
  const p5 = await player();
  assert.match((await emit(p5, 'open-room', { extra: extra('NPWX', 'e'), maxPlayers: 2, password: '' }))[0], /Password required/);
  assert.match((await emit(p5, 'open-room', { extra: extra('bad!', 'e'), maxPlayers: 2, password: 'pw1' }))[0], /Invalid room code/);
});

test('se esce chi ha creato, la stanza si chiude per tutti', async () => {
  const p1 = await player(), p2 = await player();
  await emit(p1, 'open-room', { extra: extra('BYE2', 'x1'), maxPlayers: 2, password: 'pw12' });
  await emit(p2, 'join-room', { extra: extra('BYE2', 'x2'), password: 'pw12' });
  const closed = once(p2, 'disconnect');
  p1.close();
  await closed;
  const p3 = await player();
  assert.equal((await emit(p3, 'join-room', { extra: extra('BYE2', 'x3'), password: 'pw12' }))[0], 'Wrong room code or password.');
});

test('signal WebRTC: solo all\'altro giocatore della stanza, non a estranei', async () => {
  const a = await player(), b = await player(), c = await player();
  await emit(a, 'open-room', { extra: extra('SGNL', 'sa'), maxPlayers: 2, password: 'pw12' });
  await emit(b, 'join-room', { extra: extra('SGNL', 'sb'), password: 'pw12' });
  let leaked = false;
  c.on('signal', () => { leaked = true; });
  const got = once(b, 'signal');
  a.emit('signal', { type: 'offer', sdp: 'v=0' });
  const m = await got;
  assert.equal(m.from, a.id); // il server aggiunge il mittente
  delete m.from;
  assert.deepEqual(m, { type: 'offer', sdp: 'v=0' });
  c.emit('signal', { type: 'offer', sdp: 'intruso' }); // non è in nessuna stanza: ignorato
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(leaked, false);
});

// in fondo: blocca l'indirizzo dei test (127.0.0.1) per i test successivi
test('spettatori: stesso codice, max 4, il giocatore 1 sa chi guarda, segnali solo con "to"', async () => {
  const p1 = await player(), p2 = await player();
  await emit(p1, 'open-room', { extra: extra('WTCH', 'h'), maxPlayers: 2, password: 'pw-w' });
  await emit(p2, 'join-room', { extra: extra('WTCH', 'g'), password: 'pw-w' });
  const v = await player();
  const told = once(p1, 'watchers');
  const [err, info] = await emit(v, 'watch-room', { extra: extra('WTCH', 'v'), password: 'pw-w' });
  assert.equal(err, null);
  assert.equal(info.players, 2);
  const list = await told;
  assert.deepEqual(list, [v.id]);
  // gli spettatori non sono giocatori: la stanza resta da 2 e non ricevono i messaggi tra giocatori
  let leaked = false;
  v.on('data-message', () => { leaked = true; });
  v.on('signal', (m) => { if (!m.to && m.hello) leaked = true; });
  p2.emit('signal', { hello: 1 });
  p1.emit('data-message', { x: 1 });
  // giocatore 1 → spettatore con "to"; il giocatore 2 non lo riceve
  let p2got = false;
  p2.on('signal', (m) => { if (m.offerFor === 'v') p2got = true; });
  const toV = once(v, 'signal');
  p1.emit('signal', { to: v.id, offerFor: 'v' });
  const m = await toV;
  assert.equal(m.offerFor, 'v');
  assert.equal(m.from, p1.id);
  assert.equal(m.to, undefined);
  // spettatore → giocatore 1 solo con "to"; senza "to" non arriva a nessuno
  const back = once(p1, 'signal');
  v.emit('signal', { nope: true });
  v.emit('signal', { to: p1.id, answerFrom: 'v' });
  assert.equal((await back).answerFrom, 'v');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(leaked, false);
  assert.equal(p2got, false);
  // al massimo 4
  const more = [await player(), await player(), await player()];
  for (const [i, s] of more.entries()) assert.equal((await emit(s, 'watch-room', { extra: extra('WTCH', 'm' + i), password: 'pw-w' }))[0], null);
  assert.equal((await emit(await player(), 'watch-room', { extra: extra('WTCH', 'x'), password: 'pw-w' }))[0], 'Too many spectators.');
  // chi ha creato esce: spettatori scollegati
  const gone = once(v, 'disconnect');
  p1.close();
  await gone;
});

test('partita veloce: il primo apre, il secondo entra nella stessa stanza; giochi diversi non si incrociano', async () => {
  const a = await player(), b = await player(), c = await player();
  const [qa] = await emit(a, 'quick', { game: 'mvc' });
  assert.equal(qa.action, 'open');
  assert.match(qa.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal((await emit(a, 'open-room', { extra: extra(qa.code, 'qa', 'mvc'), maxPlayers: 2, password: qa.pw }))[0], null);
  const [qc] = await emit(c, 'quick', { game: 'tekken3' });
  assert.equal(qc.action, 'open'); // altro gioco: non abbinato con a
  const [qb] = await emit(b, 'quick', { game: 'mvc' });
  assert.deepEqual([qb.action, qb.code, qb.pw], ['join', qa.code, qa.pw]);
  assert.equal((await emit(b, 'join-room', { extra: extra(qb.code, 'qb', 'mvc'), password: qb.pw }))[0], null);
  // abbinamento consumato: il prossimo apre una stanza nuova
  const d = await player();
  const [qd] = await emit(d, 'quick', { game: 'mvc' });
  assert.equal(qd.action, 'open');
  assert.notEqual(qd.code, qa.code);
  // chi aspettava se ne va: la sua attesa sparisce
  d.close();
  await new Promise((r) => setTimeout(r, 100));
  const e = await player();
  assert.equal((await emit(e, 'quick', { game: 'mvc' }))[0].action, 'open');
  assert.equal((await emit(e, 'quick', { game: '../x' }))[0].error, 'Invalid game.');
});

test('ponte TURN: credenziali solo dentro una stanza, firmate col segreto (formato TURN REST)', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const { io: io2 } = attachNetplay(srv, { turn: { secret: 'segreto-di-prova', urls: ['turn:1.2.3.4:3478?transport=udp'] } });
  await new Promise((r) => srv.listen(0, r));
  const s1 = connect(`http://127.0.0.1:${srv.address().port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise((r) => s1.on('connect', r));
  const [outside] = await emit(s1, 'ice');
  assert.ok(outside.every((x) => !JSON.stringify(x.urls).includes('turn:')), 'fuori dalla stanza niente ponte');
  await emit(s1, 'open-room', { extra: extra('TURN', 't1'), maxPlayers: 2, password: 'pw-t' });
  const [inside] = await emit(s1, 'ice');
  const t = inside.find((x) => JSON.stringify(x.urls).includes('turn:'));
  assert.ok(t && t.username && t.credential);
  const [exp] = t.username.split(':');
  assert.ok(Number(exp) > Date.now() / 1000 + 3600, 'scade tra ore, non subito');
  assert.equal(t.credential, crypto.createHmac('sha1', 'segreto-di-prova').update(t.username).digest('base64'));
  assert.notEqual(turnCredentials('x').username, turnCredentials('x').username, 'utenti diversi ogni volta');
  s1.close(); io2.close();
});

test('troppi tentativi sbagliati: bloccato', async () => {
  const h = await player();
  await emit(h, 'open-room', { extra: extra('LOCK', 'h'), maxPlayers: 2, password: 'right' });
  const g = await player();
  let last;
  for (let i = 0; i <= MAX_FAILS; i++) [last] = await emit(g, 'join-room', { extra: extra('LOCK', 'g'), password: 'wrong' + i });
  assert.match(last, /Too many attempts/);
  assert.match((await emit(g, 'join-room', { extra: extra('LOCK', 'g'), password: 'right' }))[0], /Too many attempts/);
});
