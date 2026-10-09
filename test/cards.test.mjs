// Memory card online: crea, salva, rileggi, limiti e codici sbagliati.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../server.mjs';
import { MAX_FAILS } from '../cards.mjs';

let dir, server, base;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cards-'));
  fs.mkdirSync(path.join(dir, 'games'));
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify({ games: [{ id: 'tekken3', title: 'T3', files: [] }] }));
  server = createServer({ publicUrl: 'https://ts.example', root: dir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('card: crea, salva stato e memory card, rileggi', async () => {
  const { code, pretty } = await (await fetch(base + '/api/card', { method: 'POST', body: JSON.stringify({ pin: '2468' }) })).json();
  assert.match(code, /^\d{12}$/);
  assert.match(pretty, /^\d{4}-\d{4}-\d{4}$/);
  const H = { 'x-card': pretty, 'x-card-pin': '2468' }; // anche col trattino
  const state = Buffer.from('STATE'.repeat(1000));
  assert.equal((await fetch(base + '/api/card/tekken3/state', { method: 'PUT', headers: H, body: state })).status, 200);
  assert.equal((await fetch(base + '/api/card/tekken3/srm', { method: 'PUT', headers: H, body: Buffer.alloc(131072, 7) })).status, 200);
  const meta = await (await fetch(base + '/api/card', { headers: H })).json();
  assert.equal(meta.games.tekken3.state, state.length);
  assert.equal(meta.games.tekken3.srm, 131072);
  const back = Buffer.from(await (await fetch(base + '/api/card/tekken3/state', { headers: H })).arrayBuffer());
  assert.ok(back.equals(state));
  // sul disco non c'è il codice in chiaro
  assert.ok(!fs.readdirSync(path.join(dir, 'saves')).some((d) => d.includes(code)));
});

test('card: gioco sconosciuto, tipo sbagliato, vuoto, codice sbagliato', async () => {
  const { code } = await (await fetch(base + '/api/card', { method: 'POST', body: JSON.stringify({ pin: '2468' }) })).json();
  const H = { 'x-card': code, 'x-card-pin': '2468' };
  assert.equal((await fetch(base + '/api/card/doom/state', { method: 'PUT', headers: H, body: 'x' })).status, 404);
  assert.equal((await fetch(base + '/api/card/tekken3/exe', { method: 'PUT', headers: H, body: 'x' })).status, 404);
  assert.equal((await fetch(base + '/api/card/tekken3/state', { method: 'PUT', headers: H, body: '' })).status, 400);
  assert.equal((await fetch(base + '/api/card/tekken3/srm', { headers: H })).status, 404); // niente salvato
  assert.equal((await fetch(base + '/api/card', { headers: { 'x-card': '000000000000' } })).status, 404);
  assert.equal((await fetch(base + '/api/card', { headers: { 'x-card': '123' } })).status, 404);
});

test('card: memory card troppo grande rifiutata', async () => {
  const { code } = await (await fetch(base + '/api/card', { method: 'POST', body: JSON.stringify({ pin: '2468' }) })).json();
  const r = await fetch(base + '/api/card/tekken3/srm', { method: 'PUT', headers: { 'x-card': code, 'x-card-pin': '2468' }, body: Buffer.alloc(3 * 1024 * 1024) });
  assert.equal(r.status, 413);
});

test('PIN: obbligatorio sulle card nuove, sbagliato = stesso errore del codice sbagliato', async () => {
  assert.equal((await fetch(base + '/api/card', { method: 'POST' })).status, 400);
  assert.equal((await fetch(base + '/api/card', { method: 'POST', body: JSON.stringify({ pin: '12' }) })).status, 400);
  const { code } = await (await fetch(base + '/api/card', { method: 'POST', body: JSON.stringify({ pin: '97531' }) })).json();
  const ok = await fetch(base + '/api/card', { headers: { 'x-card': code, 'x-card-pin': '97531' } });
  assert.equal(ok.status, 200);
  const badPin = await fetch(base + '/api/card', { headers: { 'x-card': code, 'x-card-pin': '97530' } });
  const noPin = await fetch(base + '/api/card', { headers: { 'x-card': code } });
  const badCode = await fetch(base + '/api/card', { headers: { 'x-card': '999988887777', 'x-card-pin': '97531' } });
  assert.equal(badPin.status, 404); assert.equal(noPin.status, 404); assert.equal(badCode.status, 404);
  const msgs = await Promise.all([badPin, noPin, badCode].map((r) => r.json().then((j) => j.error)));
  assert.ok(msgs.every((m) => m === msgs[0]), 'stesso messaggio: non si capisce se è sbagliato il codice o il PIN');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'saves', crypto.createHash('sha256').update('tweetstation-card|' + code).digest('hex'), 'meta.json'), 'utf8'));
  assert.ok(meta.pin && meta.pin.salt && meta.pin.hash && !JSON.stringify(meta).includes('97531'), 'sul server solo l\'impronta del PIN');
});

test('PIN: una card di prima del PIN chiede di sceglierlo, poi lo pretende', async () => {
  const code = '123412341234';
  const d = path.join(dir, 'saves', crypto.createHash('sha256').update('tweetstation-card|' + code).digest('hex'));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ created: 'x', games: {} }));
  const need = await fetch(base + '/api/card', { headers: { 'x-card': code } });
  assert.equal(need.status, 428);
  assert.equal((await need.json()).needPin, true);
  assert.equal((await fetch(base + '/api/card', { headers: { 'x-card': code, 'x-card-pin': '4321' } })).status, 200); // imposta il PIN
  assert.equal((await fetch(base + '/api/card', { headers: { 'x-card': code, 'x-card-pin': '9999' } })).status, 404); // ora serve quello
  assert.equal((await fetch(base + '/api/card', { headers: { 'x-card': code, 'x-card-pin': '4321' } })).status, 200);
});

test('card: troppi codici sbagliati → blocco', async () => {
  let last;
  for (let i = 0; i < MAX_FAILS + 5; i++) last = (await fetch(base + '/api/card', { headers: { 'x-card': String(100000000000 + i) } })).status;
  assert.equal(last, 429);
});

test('codici: 12 cifre casuali, tutti diversi', async () => {
  const codes = new Set();
  for (let i = 0; i < 40; i++) {
    const r = await fetch(base + '/api/card', { method: 'POST', body: JSON.stringify({ pin: '2468' }) });
    if (r.status === 429) break; // limite card nuove per indirizzo
    const { code } = await r.json();
    assert.match(code, /^\d{12}$/);
    assert.ok(!codes.has(code), 'codice doppio');
    codes.add(code);
  }
  assert.ok(codes.size >= 20);
});
