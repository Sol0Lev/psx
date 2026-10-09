// Compone le etichette dei dischi (public/covers/<id>.jpg, 512x512) dalle copertine in covers/src/.
// JPEG e non PNG: ~10 volte più leggero (le 6 copertine PNG pesavano 2,5 MB, scaricati a ogni apertura del menu).
// Taglia la costa nera "PlayStation" a sinistra delle scansioni. Più copertine (es. una raccolta) = fette uguali.
// Uso: node tools/make-covers.mjs   (serve Chrome installato; usa un profilo temporaneo separato)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'covers', 'src');
const OUT = path.join(ROOT, 'public', 'covers');
const SPINE = 0.15; // quota di larghezza occupata dalla costa nelle scansioni libretro (512 px → ~77 px)

// id del gioco → copertine sorgente (in senso orario partendo dall'alto)
const COVERS = {
  tekken3: ['tekken3.png'],
  spyro: ['spyro.png'],
  ctr: ['ctr.png'],
  diablo: ['diablo.png'],
  mvc: ['mvc.png'],
  thps: ['thps.png'],
  dbgt: ['dbgt.png'],
  tombraider: ['tombraider.png'],
  xmvsf: ['xmvsf.png'],
  crash: ['crash1.png', 'crash2.png', 'crash3.png'],
};

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('Chrome non trovato'); process.exit(1); }

// fetta k di n: poligono dal centro, archi approssimati con punti fuori dal quadrato
function wedge(k, n) {
  const pts = ['50% 50%'];
  const a0 = -90 + (360 / n) * k, a1 = a0 + 360 / n;
  for (let a = a0; a <= a1 + 0.01; a += (a1 - a0) / 12) {
    const r = (a * Math.PI) / 180;
    pts.push(`${(50 + 90 * Math.cos(r)).toFixed(2)}% ${(50 + 90 * Math.sin(r)).toFixed(2)}%`);
  }
  return `polygon(${pts.join(',')})`;
}

function page(files) {
  const n = files.length;
  const layers = files.map((f, k) => {
    const url = pathToFileURL(path.join(SRC, f)).href;
    // immagine allargata in modo che la parte senza costa riempia il suo riquadro
    const w = 100 / (1 - SPINE);
    const img = `<img src="${url}" style="width:${w}%;height:100%;left:-${(w * SPINE).toFixed(3)}%">`;
    if (n === 1) return `<div class="l"><div class="box" style="inset:0">${img}</div></div>`;
    // più copertine: ognuna rimpicciolita e centrata a metà dell'anello visibile della sua fetta
    const mid = ((-90 + (360 / n) * (k + 0.5)) * Math.PI) / 180, S = 70, R = 25;
    const cx = 50 + R * Math.cos(mid), cy = 50 + R * Math.sin(mid);
    return `<div class="l" style="clip-path:${wedge(k, n)}"><div class="box" style="left:${(cx - S / 2).toFixed(2)}%;top:${(cy - S / 2).toFixed(2)}%;width:${S}%;height:${S}%">${img}</div></div>`;
  }).join('');
  const lines = n > 1 ? Array.from({ length: n }, (_, k) => `<div class="cut" style="transform:rotate(${-90 + (360 / n) * k}deg)"></div>`).join('') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:512px;height:512px;overflow:hidden;background:#000}
    .l{position:absolute;inset:0;overflow:hidden;background:#111}
    .box{position:absolute;overflow:hidden}
    img{position:absolute;top:0;object-fit:cover}
    .cut{position:absolute;left:50%;top:50%;width:400px;height:6px;margin-top:-3px;background:#fff;transform-origin:0 50%;box-shadow:0 0 6px rgba(0,0,0,.6)}
  </style></head><body>${layers}${lines}</body></html>`;
}

// PNG → JPEG qualità 84 con System.Drawing di Windows (niente dipendenze npm)
function toJpeg(png, jpg) {
  const ps = `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${png}'); ` +
    `$c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | ? { $_.MimeType -eq 'image/jpeg' }; ` +
    `$p=New-Object System.Drawing.Imaging.EncoderParameters 1; ` +
    `$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 84L; ` +
    `$i.Save('${jpg}', $c, $p); $i.Dispose()`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
}

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-covers-'));
for (const [id, files] of Object.entries(COVERS)) {
  if (!files.every((f) => fs.existsSync(path.join(SRC, f)))) { console.log(`salto ${id}: copertine mancanti`); continue; }
  const html = path.join(tmp, `${id}.html`);
  fs.writeFileSync(html, page(files));
  const out = path.join(tmp, `${id}.png`), jpg = path.join(OUT, `${id}.jpg`);
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=512,512', `--screenshot=${out}`, pathToFileURL(html).href],
  { encoding: 'utf8' });
  if (!fs.existsSync(out)) { console.log(`ERRORE ${id}: ${r.stderr}`); continue; }
  const j = toJpeg(out, jpg);
  console.log(fs.existsSync(jpg) ? `ok ${id} → public/covers/${id}.jpg (${Math.round(fs.statSync(jpg).size / 1024)} KB)` : `ERRORE jpeg ${id}: ${j.stderr}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
