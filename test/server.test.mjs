import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, cardMeta } from '../server.mjs';

// Fixture: catalogo finto in una cartella temporanea, con un "gioco" di 1000 byte.
let dir, server, base;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  fs.mkdirSync(path.join(dir, 'games', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'games', 'demo', 'a.cue'), 'FILE "a.bin" BINARY');
  fs.writeFileSync(path.join(dir, 'games', 'demo', 'a.bin'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(dir, 'games', 'secret.txt'), 'no');
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify({ games: [
    { id: 'demo', title: 'Demo <b>', year: 1999, color: '#fff', cue: 'a.cue', files: ['a.cue', 'a.bin'] },
    { id: 'vuoto', title: 'Vuoto', cue: null, files: [] },
  ] }));
  server = createServer({ publicUrl: 'https://ts.example', root: dir, enableUpload: true, uploadToken: 'k-test' });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('card: meta player con URL pubblico e id del gioco', async () => {
  const html = await (await fetch(base + '/r/demo')).text();
  assert.match(html, /<meta name="twitter:card" content="player">/);
  assert.match(html, /<meta name="twitter:player" content="https:\/\/ts\.example\/play\/demo">/);
  assert.match(html, /twitter:player:width" content="600"/);
  assert.match(html, /window\.TS_GAME="demo"/);
  assert.match(html, /Play Demo &lt;b&gt; right inside X/); // titolo escapato
});

test('card: id sconosciuto → meta generici, 200', async () => {
  const r = await fetch(base + '/play/boh');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /window\.TS_GAME=null/);
  assert.match(html, /play\/psx/);
});

test('nessun header che blocca l\'iframe', async () => {
  const r = await fetch(base + '/play/demo');
  assert.equal(r.headers.get('x-frame-options'), null);
});

test('catalogo: available e bytes', async () => {
  const list = await (await fetch(base + '/api/games')).json();
  const demo = list.find((g) => g.id === 'demo');
  assert.equal(demo.available, true);
  assert.equal(demo.bytes, 1000 + 'FILE "a.bin" BINARY'.length);
  assert.equal(list.find((g) => g.id === 'vuoto').available, false);
});

test('giochi: file intero e Range 206', async () => {
  const full = await fetch(base + '/games/demo/a.bin');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '1000');
  const part = await fetch(base + '/games/demo/a.bin', { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  const bad = await fetch(base + '/games/demo/a.bin', { headers: { Range: 'bytes=5000-' } });
  assert.equal(bad.status, 416);
});

test('giochi: solo file del catalogo (niente traversal)', async () => {
  for (const p of ['/games/demo/..%2Fsecret.txt', '/games/demo/secret.txt', '/games/nope/a.bin', '/games/demo/%2e%2e%2f%2e%2e%2fgames.json']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('static: niente uscita da public/', async () => {
  assert.equal((await fetch(base + '/..%2Fserver.mjs')).status, 404);
  assert.equal((await fetch(base + '/style.css')).status, 200);
});

test('cardMeta senza gioco', () => {
  assert.match(cardMeta(null, 'https://a.b'), /PSX/);
});

test('diario: POST /api/log → 204', async () => {
  const r = await fetch(base + '/api/log', { method: 'POST', body: JSON.stringify({ ev: 'test' }) });
  assert.equal(r.status, 204);
  assert.equal((await fetch(base + '/api/games', { method: 'POST' })).status, 405);
});

test('upload: crea job, rifiuta estensioni strane, stato', async () => {
  const H = { 'x-upload-token': 'k-test' };
  const j = await (await fetch(base + '/api/upload', { method: 'POST', headers: H })).json();
  assert.match(j.id, /^[0-9a-f]{16}$/);
  const bad = await fetch(`${base}/api/upload/${j.id}/virus.exe`, { method: 'PUT', body: 'x', headers: H });
  assert.equal(bad.status, 415);
  const ok = await fetch(`${base}/api/upload/${j.id}/${encodeURIComponent('My Game (USA).bin')}`, { method: 'PUT', body: Buffer.alloc(100), headers: H });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).name, 'My Game (USA).bin');
  const st = await (await fetch(`${base}/api/upload/${j.id}`, { headers: H })).json();
  assert.equal(st.state, 'uploading');
  assert.equal((await fetch(`${base}/api/upload/ffffffffffffffff`, { headers: H })).status, 404);
});

test('upload: con UPLOAD_TOKEN serve la chiave', async () => {
  const s2 = createServer({ publicUrl: 'https://ts.example', root: dir, uploadToken: 'k1', enableUpload: true });
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  assert.equal((await fetch(b2 + '/api/upload', { method: 'POST' })).status, 401);
  assert.equal((await fetch(b2 + '/api/upload', { method: 'POST', headers: { 'x-upload-token': 'k1' } })).status, 200);
  s2.close();
});

test('upload spento di default (anche con chiave)', async () => {
  for (const opts of [{}, { uploadToken: 'k1' }, { enableUpload: true }]) {
    const s3 = createServer({ publicUrl: 'https://ts.example', root: dir, uploadToken: undefined, ...opts });
    await new Promise((r) => s3.listen(0, r));
    const b3 = `http://127.0.0.1:${s3.address().port}`;
    const r = await fetch(b3 + '/api/upload', { method: 'POST', headers: { 'x-upload-token': 'k1' } });
    assert.equal(r.status, 404, JSON.stringify(opts));
    s3.close();
  }
});

test('sicurezza: header, robots, CSP con nonce', async () => {
  const r = await fetch(base + '/r/demo');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-robots-tag'), null); // niente noindex: X deve poter leggere la card
  const policy = r.headers.get('content-security-policy');
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /frame-ancestors/); // deve poter stare nell'iframe di X
  const nonce = /'nonce-([^']+)'/.exec(policy)[1];
  assert.ok((await r.text()).includes(`<script nonce="${nonce}">`));
  const robots = await (await fetch(base + '/robots.txt')).text();
  assert.match(robots, /User-agent: Twitterbot\nAllow: \//);
  assert.match(robots, /User-agent: \*\nDisallow: \//);
  const g = await fetch(base + '/games/demo/a.bin', { headers: { Range: 'bytes=0-1' } });
  assert.equal(g.headers.get('cross-origin-resource-policy'), 'same-origin');
});

test('upload: chiave sbagliata 401, poi blocco 429; /api/config', async () => {
  const s4 = createServer({ publicUrl: 'https://ts.example', root: dir, uploadToken: 'right-key-1234567890', enableUpload: true });
  await new Promise((r) => s4.listen(0, r));
  const b4 = `http://127.0.0.1:${s4.address().port}`;
  assert.equal((await (await fetch(b4 + '/api/config')).json()).upload, true);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(b4 + '/api/upload', { method: 'POST', headers: { 'x-upload-token': 'wrong' } })).status, 401);
  const locked = await fetch(b4 + '/api/upload', { method: 'POST', headers: { 'x-upload-token': 'right-key-1234567890' } });
  assert.equal(locked.status, 429);
  s4.close();
  assert.equal((await (await fetch(base + '/api/config')).json()).upload, true);
});

test('card: twitter:site e image:alt come Tweetboy', async () => {
  const html = await (await fetch(base + '/r/demo')).text();
  // account X da TWITTER_SITE: senza, il tag non c'è (X lo chiede: impostarlo in produzione)
  if (process.env.TWITTER_SITE) assert.match(html, /<meta name="twitter:site" content="@[A-Za-z0-9_]+">/);
  else assert.doesNotMatch(html, /twitter:site/);
  assert.match(html, /<meta name="twitter:image:alt" content="Demo &lt;b&gt; on PSX">/);
});

test('cache: ETag → 304, emulatore 7 giorni, app sempre ricontrollata', async () => {
  const r = await fetch(base + '/style.css');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(base + '/style.css', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(base + '/style.css', { headers: { 'If-None-Match': 'W/"altro"' } })).status, 200);
  assert.equal((await fetch(base + '/ejs/loader.js')).headers.get('cache-control'), 'public, max-age=604800');
  assert.match(cardMeta(null, 'https://a.b'), /card\.png\?v=[0-9a-z]+/);
});

test('https: chi arriva in http (via Cloudflare) va alla versione protetta; HSTS solo in https', async () => {
  const r = await fetch(base + '/r/demo?v=1', { headers: { 'x-forwarded-proto': 'http' }, redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://ts.example/r/demo?v=1');
  const v = await fetch(base + '/r/demo', { headers: { 'cf-visitor': '{"scheme":"http"}' }, redirect: 'manual' });
  assert.equal(v.status, 301);
  const s = await fetch(base + '/r/demo', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(s.status, 200);
  assert.match(s.headers.get('strict-transport-security') || '', /max-age=/);
  const local = await fetch(base + '/r/demo'); // senza proxy (sviluppo in locale): niente rimando
  assert.equal(local.status, 200);
});
