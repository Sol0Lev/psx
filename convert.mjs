// TweetStation — upload a disc image and "lighten" it: archive → cue/bin → CHD (chdman), then add it to games.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Solo formati disco semplici: .ccd/.toc/.m3u esclusi (riferimenti a file più liberi, poco usati per PS1)
const DISC_EXT = ['.cue', '.bin', '.img', '.iso', '.chd'];
const ARCHIVE_EXT = ['.7z', '.zip', '.rar'];
export const ACCEPTED_EXT = [...DISC_EXT, ...ARCHIVE_EXT];
export const MIN_WINRAR = [7, 13]; // CVE-2025-6218 (fix 7.12) e CVE-2025-8088 (fix 7.13): path traversal → esecuzione codice
const MAX_EXTRACTED = 3 * 1024 ** 3, MAX_FILES = 64;
const PALETTE = ['#e8402a', '#f28c1e', '#f5c400', '#2bbf6a', '#2f7cf6', '#8a4fd8', '#ff6fb5', '#19b8c9'];

export function safeName(name) {
  // Keep the original name as far as possible (cue files reference bins by name); block only what Windows/paths forbid.
  const base = path.basename(String(name).replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim();
  return base && !/^\.+$/.test(base) ? base : null;
}

// "Spyro the Dragon (USA) (Track 1).bin" → "Spyro the Dragon"
export function titleFromName(name) {
  return path.basename(name, path.extname(name))
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';
}

export function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 40) || 'game';
}

export function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// Cue for a lone PS1 .bin (single data track). Multi-track games need their own cue.
export function cueForBin(binName) {
  return `FILE "${binName}" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// Picks what to feed chdman: .chd (already light) > .cue/.ccd/.toc > .iso > lone .bin (cue generated).
export function pickSource(files) {
  const by = (exts) => files.filter((f) => exts.includes(path.extname(f).toLowerCase()));
  const chd = by(['.chd']);
  if (chd.length) return { kind: 'chd', file: chd[0] };
  const sheet = by(['.cue']);
  if (sheet.length) return { kind: 'sheet', file: sheet[0] };
  const iso = by(['.iso']);
  if (iso.length) return { kind: 'sheet', file: iso[0] };
  const bins = by(['.bin', '.img']).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  if (bins.length === 1) return { kind: 'bin', file: bins[0] };
  if (bins.length > 1) return { kind: 'error', error: 'Several .bin files but no .cue: upload the .cue too.' };
  return { kind: 'error', error: 'No disc image found (.cue/.bin/.iso/.chd or a .7z/.zip/.rar with them).' };
}

// Il cue dice a chdman quali file leggere: con un percorso assoluto gli si potrebbe far leggere (e poi pubblicare)
// un file qualsiasi del PC. Ammessi solo nomi semplici di file presenti nella stessa cartella.
export function validateCue(cuePath) {
  if (fs.statSync(cuePath).size > 64 * 1024) throw new Error('The .cue file is too large.');
  const dir = path.dirname(cuePath);
  const names = [];
  for (const line of fs.readFileSync(cuePath, 'latin1').split(/\r?\n/)) {
    if (!/^\s*FILE\b/i.test(line)) continue;
    const m = /^\s*FILE\s+(?:"([^"]*)"|(\S+))\s+\S+\s*$/i.exec(line);
    if (!m) throw new Error('Invalid FILE line in .cue.');
    const name = m[1] ?? m[2];
    if (!name || name !== path.basename(name) || /[\\/:]/.test(name) || /^\.+$/.test(name)) throw new Error(`.cue points outside its folder: ${name}`);
    if (!['.bin', '.img', '.iso'].includes(path.extname(name).toLowerCase())) throw new Error(`.cue points to an unsupported file: ${name}`);
    if (!fs.existsSync(path.join(dir, name))) throw new Error(`.cue points to a missing file: ${name}`);
    names.push(name);
  }
  if (!names.length) throw new Error('The .cue lists no files.');
  return names;
}

// È un disco PS1? Settore 16 = descrittore ISO9660 ("CD001") con system identifier "PLAYSTATION".
// Prova i formati raw 2352 (MODE2: dati a +24, MODE1: +16) e ISO 2048.
export function isPs1Image(file) {
  const fd = fs.openSync(file, 'r');
  try {
    for (const [sector, off] of [[2352, 24], [2352, 16], [2048, 0]]) {
      const buf = Buffer.alloc(48);
      if (fs.readSync(fd, buf, 0, 48, sector * 16 + off) < 48) continue;
      if (buf.toString('latin1', 1, 6) === 'CD001' && buf.toString('latin1', 8, 40).includes('PLAYSTATION')) return true;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let tail = '';
    const feed = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      s.split(/[\r\n]+/).forEach((l) => l && onLine && onLine(l));
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${tail.trim().split(/[\r\n]+/).pop()}`))));
  });
}

export function tools(root) {
  const local = path.join(root, 'tools', 'bin', process.platform === 'win32' ? 'chdman.exe' : 'chdman');
  const chdman = process.env.CHDMAN || (fs.existsSync(local) ? local : 'chdman');
  const winrar = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
  const unarchiver = process.env.UNARCHIVER || (fs.existsSync(winrar) ? winrar : '7z');
  return { chdman, unarchiver };
}

export function winrarVersion(rarExe = 'C:\\Program Files\\WinRAR\\Rar.exe') {
  return new Promise((resolve) => {
    if (!fs.existsSync(rarExe)) return resolve(null);
    const p = spawn(rarExe, [], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => { const m = /RAR\s+(\d+)\.(\d+)/.exec(out); resolve(m ? [Number(m[1]), Number(m[2])] : null); });
  });
}
export const versionOk = (v) => !!v && (v[0] > MIN_WINRAR[0] || (v[0] === MIN_WINRAR[0] && v[1] >= MIN_WINRAR[1]));

// Estrazione: solo file disco, SENZA percorsi interni (tutto piatto nella cartella), in una cartella nuova.
async function extract(unarchiver, archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (/winrar\.exe$/i.test(unarchiver)) {
    const v = await winrarVersion(path.join(path.dirname(unarchiver), 'Rar.exe'));
    if (!versionOk(v)) throw new Error(`Archives are disabled: WinRAR ${v ? v.join('.') : '?'} is unsafe (needs ${MIN_WINRAR.join('.')}+). Upload the extracted .cue/.bin instead.`);
    // e = estrai senza percorsi, -n<maschera> = solo questi tipi, -ibck = senza finestra, -y = sì a tutto
    return run(unarchiver, ['e', '-ibck', '-y', ...DISC_EXT.map((e) => `-n*${e}`), archive, dest + path.sep]);
  }
  // 7-Zip: e = senza percorsi, solo questi tipi
  return run(unarchiver, ['e', `-o${dest}`, '-y', archive, ...DISC_EXT.map((e) => `*${e}`), '-r']);
}

// job: { id, dir, title?, state, step, pct, error, gameId }. Mutated in place so the server can report progress.
export async function convertJob(job, { root }) {
  const { chdman, unarchiver } = tools(root);
  const gamesDir = path.join(root, 'games');
  const catalogPath = path.join(root, 'games.json');
  const set = (step, pct = null) => { job.step = step; job.pct = pct; };
  try {
    job.state = 'working';
    let files = walk(job.dir);
    const archives = files.filter((f) => ARCHIVE_EXT.includes(path.extname(f).toLowerCase()));
    for (const a of archives) {
      set('extracting');
      await extract(unarchiver, a, path.join(job.dir, 'x-' + path.basename(a, path.extname(a))));
      fs.rmSync(a, { force: true });
    }
    files = walk(job.dir).filter((f) => DISC_EXT.includes(path.extname(f).toLowerCase()));
    if (files.length > MAX_FILES) throw new Error('Too many files.');
    const inBytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    if (inBytes > MAX_EXTRACTED) throw new Error('Too large once unpacked (max 3 GB).');
    const src = pickSource(files);
    if (src.kind === 'error') throw new Error(src.error);
    set('checking');
    if (src.kind === 'sheet' && path.extname(src.file).toLowerCase() === '.cue') {
      const names = validateCue(src.file);
      if (!isPs1Image(path.join(path.dirname(src.file), names[0]))) throw new Error('This does not look like a PlayStation disc.');
    } else if (src.kind === 'sheet' || src.kind === 'bin') {
      if (!isPs1Image(src.file)) throw new Error('This does not look like a PlayStation disc.');
    } else if (src.kind === 'chd') {
      const head = Buffer.alloc(8);
      const fd = fs.openSync(src.file, 'r');
      try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
      if (head.toString('latin1') !== 'MComprHD') throw new Error('Not a valid .chd file.');
    }

    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const title = (job.title && String(job.title).trim().slice(0, 60)) || titleFromName(src.file);
    const id = uniqueId(slugify(title), new Set(catalog.games.map((g) => g.id)));
    const outDir = path.join(gamesDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${id}.chd`);

    if (src.kind === 'chd') {
      set('copying');
      fs.renameSync(src.file, out);
    } else {
      let input = src.file;
      if (src.kind === 'bin') {
        input = path.join(path.dirname(src.file), 'auto.cue');
        fs.writeFileSync(input, cueForBin(path.basename(src.file)));
      }
      set('compressing', 0);
      await run(chdman, ['createcd', '-i', input, '-o', out, '-f'], (l) => {
        const m = /([\d.]+)% complete/.exec(l);
        if (m) job.pct = Number(m[1]);
      });
    }

    const used = new Set(catalog.games.map((g) => g.color));
    const color = PALETTE.find((c) => !used.has(c)) || PALETTE[catalog.games.length % PALETTE.length];
    catalog.games.push({ id, title, year: null, color, cue: null, files: [`${id}.chd`], uploaded: new Date().toISOString() });
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');

    job.result = { id, title, inBytes, outBytes: fs.statSync(out).size };
    job.gameId = id;
    job.state = 'done';
    set('done', 100);
  } catch (e) {
    job.state = 'error';
    job.error = e.message;
  } finally {
    fs.rmSync(job.dir, { recursive: true, force: true });
  }
}
