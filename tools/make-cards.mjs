// Anteprime per gioco del post su X: public/cards/<id>.png (1200x1200) da public/card-game.html + public/covers/<id>.jpg.
// Il server le usa da sole (server.mjs, cardMeta): il link /r/<id> mostra il disco e il titolo di quel gioco.
// Uso: node tools/make-covers.mjs && node tools/make-cards.mjs   (serve Chrome; profilo temporaneo separato)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'cards');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('Chrome non trovato'); process.exit(1); }

const { games } = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cards-'));
for (const g of games) {
  if (!fs.existsSync(path.join(PUBLIC, 'covers', `${g.id}.jpg`))) { console.log(`salto ${g.id}: copertina mancante`); continue; }
  const url = new URL(pathToFileURL(path.join(PUBLIC, 'card-game.html')).href);
  url.search = new URLSearchParams({ id: g.id, title: g.title, year: String(g.year || ''), color: g.color || '' }).toString();
  const out = path.join(OUT, `${g.id}.png`);
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=1200,1200', '--virtual-time-budget=4000',
    `--screenshot=${out}`, url.href], { encoding: 'utf8' });
  console.log(fs.existsSync(out) ? `ok ${g.id} → public/cards/${g.id}.png (${Math.round(fs.statSync(out).size / 1024)} KB)` : `ERRORE ${g.id}: ${r.stderr}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
