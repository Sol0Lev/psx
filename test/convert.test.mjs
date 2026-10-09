import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { titleFromName, slugify, uniqueId, safeName, pickSource, cueForBin, convertJob, tools, validateCue, isPs1Image, versionOk } from '../convert.mjs';

test('titleFromName toglie regione e tracce', () => {
  assert.equal(titleFromName('Spyro the Dragon (USA).cue'), 'Spyro the Dragon');
  assert.equal(titleFromName('Tekken 3 (USA) (Track 1).bin'), 'Tekken 3');
  assert.equal(titleFromName('crash_bandicoot.7z'), 'crash bandicoot');
});

test('slugify / uniqueId', () => {
  assert.equal(slugify('Spyro the Dragon'), 'spyro-the-dragon');
  assert.equal(uniqueId('spyro', new Set(['spyro', 'spyro-2'])), 'spyro-3');
});

test('safeName: niente percorsi', () => {
  assert.equal(safeName('../../x.bin'), 'x.bin');
  assert.equal(safeName('a/b\\c.cue'), 'c.cue');
  assert.equal(safeName('..'), null);
  assert.equal(safeName("Tony Hawk's (USA).cue"), "Tony Hawk's (USA).cue");
});

test('pickSource: priorità e errori', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pick-'));
  const w = (n, size = 10) => { const p = path.join(d, n); fs.writeFileSync(p, Buffer.alloc(size)); return p; };
  const bin = w('g.bin', 100);
  assert.equal(pickSource([bin]).kind, 'bin');
  const bin2 = w('g2.bin');
  assert.equal(pickSource([bin, bin2]).kind, 'error');
  const cue = w('g.cue');
  assert.equal(pickSource([bin, bin2, cue]).file, cue);
  const chd = w('g.chd');
  assert.equal(pickSource([cue, chd]).kind, 'chd');
  assert.equal(pickSource([w('readme.txt')]).kind, 'error');
  fs.rmSync(d, { recursive: true, force: true });
});

// Conversione vera con chdman su un "disco" finto di 300 settori (salta se chdman manca).
test('convertJob: bin senza cue → CHD nel catalogo', { skip: !fs.existsSync(tools(path.resolve('.')).chdman) && 'chdman assente' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-conv-'));
  fs.mkdirSync(path.join(root, 'tools', 'bin'), { recursive: true });
  fs.copyFileSync(tools(path.resolve('.')).chdman, path.join(root, 'tools', 'bin', path.basename(tools(path.resolve('.')).chdman)));
  fs.mkdirSync(path.join(root, 'games'));
  fs.writeFileSync(path.join(root, 'games.json'), JSON.stringify({ games: [{ id: 'fake-game', title: 'x', color: '#e8402a', files: [] }] }));
  const dir = path.join(root, 'uploads', 'job1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Fake Game (USA).bin'), fakePs1(300));
  const job = { id: 'job1', dir };
  await convertJob(job, { root });
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.result.id, 'fake-game-2');
  assert.ok(fs.existsSync(path.join(root, 'games', 'fake-game-2', 'fake-game-2.chd')));
  assert.ok(job.result.outBytes < job.result.inBytes);
  const cat = JSON.parse(fs.readFileSync(path.join(root, 'games.json'), 'utf8'));
  assert.equal(cat.games[1].title, 'Fake Game');
  assert.ok(!fs.existsSync(dir), 'cartella upload rimossa');
  fs.rmSync(root, { recursive: true, force: true });
});

// Disco finto con descrittore ISO9660 PlayStation al settore 16 (raw 2352, MODE2: dati a +24)
function fakePs1(sectors) {
  const b = Buffer.alloc(2352 * sectors, 1);
  b.write('\x01CD001\x01\x00PLAYSTATION', 2352 * 16 + 24, 'latin1');
  return b;
}

test('cueForBin', () => assert.match(cueForBin('a.bin'), /FILE "a.bin" BINARY[\s\S]*MODE2\/2352/));

test('validateCue: solo file vicini, niente percorsi', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cue-'));
  fs.writeFileSync(path.join(d, 'a.bin'), 'x');
  const cue = (body) => { const p = path.join(d, 'g.cue'); fs.writeFileSync(p, body); return p; };
  assert.deepEqual(validateCue(cue('FILE "a.bin" BINARY\n  TRACK 01 MODE2/2352\n')), ['a.bin']);
  for (const bad of ['FILE "C:\\Windows\\win.ini" BINARY', 'FILE "..\\x.bin" BINARY', 'FILE "../x.bin" BINARY', 'FILE "sub/a.bin" BINARY',
    'FILE "missing.bin" BINARY', 'FILE "a.exe" BINARY', 'FILE broken', '  TRACK 01 MODE2/2352']) {
    assert.throws(() => validateCue(cue(bad + '\n')), Error, bad);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('isPs1Image / versionOk', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ps1-'));
  fs.writeFileSync(path.join(d, 'ok.bin'), fakePs1(20));
  fs.writeFileSync(path.join(d, 'no.bin'), Buffer.alloc(2352 * 20));
  assert.equal(isPs1Image(path.join(d, 'ok.bin')), true);
  assert.equal(isPs1Image(path.join(d, 'no.bin')), false);
  fs.rmSync(d, { recursive: true, force: true });
  assert.equal(versionOk([6, 23]), false);
  assert.equal(versionOk([7, 12]), false);
  assert.equal(versionOk([7, 13]), true);
  assert.equal(versionOk(null), false);
});

test('convertJob: rifiuta un disco che non è PS1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-conv2-'));
  fs.mkdirSync(path.join(root, 'games'));
  fs.writeFileSync(path.join(root, 'games.json'), JSON.stringify({ games: [] }));
  const dir = path.join(root, 'uploads', 'j');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.bin'), Buffer.alloc(2352 * 40));
  const job = { id: 'j', dir };
  await convertJob(job, { root });
  assert.equal(job.state, 'error');
  assert.match(job.error, /PlayStation/);
  fs.rmSync(root, { recursive: true, force: true });
});
