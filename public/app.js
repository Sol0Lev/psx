// TweetStation — interfaccia: accensione → menu dischi → EmulatorJS (core psx / pcsx_rearmed).
(() => {
  'use strict';

  // EmulatorJS 4.2.3 copiato sul nostro server (solo i file PS1, 2,8 MB): niente codice da siti terzi. Vedi docs/adr/0001
  const EJS_DATA = '/ejs/';
  const $ = (s) => document.querySelector(s);
  const screens = { power: $('#screen-power'), boot: $('#screen-boot'), menu: $('#screen-menu'), game: $('#screen-game') };

  // ---------- diario per il server (tappe ed errori) ----------
  function report(ev, data) {
    try {
      const body = JSON.stringify({ ev, data, t: Math.round(performance.now()), ua: navigator.userAgent.slice(0, 120) });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/log', body))) fetch('/api/log', { method: 'POST', body, keepalive: true });
    } catch {}
  }
  addEventListener('error', (e) => report('error', String(e.message || e.error || e).slice(0, 500) + ' @' + (e.filename || '') + ':' + (e.lineno || '')));
  addEventListener('unhandledrejection', (e) => report('rejection', String(e.reason && (e.reason.stack || e.reason.message) || e.reason).slice(0, 500)));
  report('load', { path: location.pathname + location.search, w: innerWidth, h: innerHeight, secure: isSecureContext });

  let current = 'power';
  let discs = [];        // giochi del catalogo + disco "carica il tuo"
  let sel = 0;
  let started = false;   // EmulatorJS si può avviare una sola volta per pagina

  // ---------- schermate ----------
  function show(name) {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('on', k === name);
    current = name;
    if (name === 'menu') setTimeout(preloadEmulator, 1200);
    document.body.classList.toggle('playing', name === 'game');
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }

  const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

  // ---------- suono di accensione (sintetizzato, originale) ----------
  let audio;
  // audio spento dal pulsante 🔇 (ricordato sul dispositivo)
  let soundOff = false;
  try { soundOff = localStorage.getItem('ts-muted') === '1'; } catch {}
  function bootSound() {
    if (soundOff) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audio, now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.35, now + 0.6);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 4.2);
      const delay = ctx.createDelay(); delay.delayTime.value = 0.23;
      const fb = ctx.createGain(); fb.gain.value = 0.35;
      delay.connect(fb).connect(delay);
      master.connect(ctx.destination); master.connect(delay); delay.connect(ctx.destination);
      // accordo che si apre: whoosh basso + campanelle
      [55, 110, 164.8].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(f / 2, now); o.frequency.exponentialRampToValueAtTime(f, now + 1.2);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
        lp.frequency.setValueAtTime(200, now); lp.frequency.exponentialRampToValueAtTime(2400, now + 1.6);
        const g = ctx.createGain(); g.gain.value = 0.18 / (i + 1);
        o.connect(lp).connect(g).connect(master); o.start(now); o.stop(now + 4.3);
      });
      [880, 1318.5, 1760, 2637].forEach((f, i) => {
        const t = now + 1.25 + i * 0.12;
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        o.connect(g).connect(master); o.start(t); o.stop(t + 1.7);
      });
    } catch { /* audio non disponibile: si va avanti in silenzio */ }
  }

  function blip(freq = 660, dur = 0.06) {
    if (soundOff) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur);
    } catch {}
  }

  // ---------- accensione ----------
  function powerOn() {
    if (current !== 'power') return;
    report('power');
    setTimeout(checkPageHz, 1200); // durante l'animazione di accensione: misura quanto batte la pagina
    bootSound();
    show('boot');
    setTimeout(() => show('menu'), 3600);
  }
  $('#btn-power').addEventListener('click', powerOn);
  screens.power.addEventListener('click', (e) => { if (e.target === screens.power) powerOn(); });

  // ---------- menu ----------
  // Upload solo in modalità admin (?admin nell'indirizzo) e solo se il server ce l'ha acceso. Gli altri vedono SOON.
  let adminUpload = false;
  async function loadCatalog() {
    let games = [];
    try { adminUpload = new URLSearchParams(location.search).has('admin') && !!(await (await fetch('/api/config', { cache: 'no-store' })).json()).upload; } catch {}
    try { games = await (await fetch('/api/games', { cache: 'no-store' })).json(); } catch { toast('GAME LIST UNAVAILABLE'); }
    discs = [...games.map((g) => ({ kind: g.available ? 'game' : 'empty', ...g })),
      { kind: 'upload', id: 'upload', title: 'Upload your game', color: '#f5c400' }];
    const want = window.TS_GAME;
    const i = discs.findIndex((d) => d.id === want);
    sel = i >= 0 ? i : 0;
    renderCarousel();
  }

  function renderCarousel() {
    const box = $('#carousel');
    box.innerHTML = '';
    discs.forEach((d, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'disc ' + d.kind;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', d.title);
      b.style.setProperty('--c', d.color || '#444');
      b.innerHTML = `<div class="disc-face"><div class="disc-label"><span></span></div></div>`;
      b.querySelector('span').textContent = d.kind === 'upload' ? (adminUpload ? '+ UPLOAD' : 'SOON') : d.kind === 'empty' ? 'EMPTY' : d.title.toUpperCase();
      // copertina stampata sul disco (public/covers/<id>.jpg, generata da tools/make-covers.mjs)
      if (d.cover && d.kind === 'game' && /^[\w-]+\.(png|jpg|webp)$/.test(d.cover)) {
        b.classList.add('has-cover');
        b.querySelector('.disc-label').style.backgroundImage = `url("/covers/${d.cover}")`;
      }
      b.addEventListener('click', () => (i === sel ? confirm() : select(i)));
      box.appendChild(b);
    });
    layout();
  }

  function layout() {
    [...$('#carousel').children].forEach((el, i) => {
      const d = i - sel, a = Math.abs(d);
      el.classList.toggle('sel', d === 0);
      el.setAttribute('aria-selected', d === 0);
      el.style.transform = `translate(-50%,-50%) translateX(${d * 68}%) translateZ(${-a * 180}px) rotateY(${-d * 38}deg)`;
      el.style.opacity = a > 2 ? 0 : 1 - a * 0.3;
      el.style.zIndex = 10 - a;
      el.style.filter = a ? 'brightness(.6)' : 'none';
    });
    const d = discs[sel];
    if (!d) return;
    $('#disc-name').textContent = d.title;
    $('#disc-meta').textContent =
      d.kind === 'upload' ? (adminUpload ? 'ADMIN · .CUE+.BIN · .ISO · .CHD · .7Z/.ZIP' : 'COMING SOON') :
      d.kind === 'empty' ? 'EMPTY SLOT' :
      [d.year, fmtSize(d.bytes), 'PS1'].filter(Boolean).join(' · ');
    $('#menu-vs').hidden = !(d.kind === 'game' && d.versus);
    prewarmSelected();
    if (d.versus) $('#menu-vs').textContent = `${modeOf(d).icon} ${modeOf(d).name} · ${modeOf(d).sub}`;
  }

  // ---------- pre-caricamento dal menu: al tocco su ✕ il grosso è già scaricato ----------
  // 1) i file dell'emulatore (il browser li tiene 7 giorni: server.mjs staticCache)
  const EJS_FILES = ['loader.js', 'emulator.min.js', 'emulator.min.css', 'cores/pcsx_rearmed-wasm.data',
    'compression/extract7z.js', 'localization/en-US.json', 'cores/reports/pcsx_rearmed.json'];
  let ejsPreloaded = false;
  function preloadEmulator() {
    if (ejsPreloaded || started) return;
    ejsPreloaded = true;
    for (const f of EJS_FILES) fetch(EJS_DATA + f, { priority: 'low' }).catch(() => {});
  }
  // 2) l'inizio del disco su cui ci si ferma (~1,5 MB), dopo 0,7 s: scorrendo i dischi non si scarica nulla
  let prewarmTimer = null;
  function prewarmSelected() {
    clearTimeout(prewarmTimer);
    const d = discs[sel];
    if (started || current !== 'menu' || !d || d.kind !== 'game' || d.cue || !/.chd$/i.test(d.files[0])) return;
    prewarmTimer = setTimeout(() => {
      if (started || current !== 'menu' || discs[sel] !== d) return;
      const u = `/games/${encodeURIComponent(d.id)}/${encodeURIComponent(d.files[0])}`;
      if (warmJob && warmJob.target.url === u) return;
      startWarm({ name: d.files[0], url: u, bytes: d.bytes });
    }, 700);
  }

  function select(i) {
    if (current !== 'menu') return;
    const n = Math.max(0, Math.min(discs.length - 1, i));
    if (n !== sel) { sel = n; blip(520); layout(); }
  }

  function confirm() {
    if (current !== 'menu') return;
    const d = discs[sel];
    if (!d) return;
    report('confirm', d.id);
    if (d.kind === 'empty') { blip(180, 0.15); return toast('EMPTY SLOT'); }
    if (d.kind === 'upload') {
      if (!adminUpload) { blip(180, 0.15); return toast('UPLOAD · COMING SOON'); }
      return openUploadKey();
    }
    blip(880, 0.1);
    document.body.classList.toggle('has-vs', !!d.versus); // in due solo sui giochi segnati in games.json
    if (d.versus) { vs.game = d; if (!vs.inRoom) vsBadge(''); } // entrando dalla lobby lo stato (P1 · WAITING) resta
    const files = d.files.filter((f) => f !== d.cue);
    const url = (f) => `/games/${encodeURIComponent(d.id)}/${encodeURIComponent(f)}`;
    if (d.cue) startGame({ gameUrl: url(d.cue), externalFiles: Object.fromEntries(files.map((f) => [f, url(f)])), name: d.title, id: d.id });
    else {
      const f = d.files[0];
      // CHD: a pezzi in streaming (?stream=0 per scaricarlo tutto come prima)
      const canStream = /\.chd$/i.test(f) && new URLSearchParams(location.search).get('stream') !== '0';
      startGame({ gameUrl: url(f), name: d.title, id: d.id, stream: canStream ? { name: f, url: url(f), bytes: d.bytes } : null });
    }
  }

  function back() {
    if (current === 'game') { // EmulatorJS non si smonta: si ricarica la pagina, ma si salta l'accensione
      try { sessionStorage.setItem('ts-go-menu', '1'); } catch {}
      return location.reload();
    }
    if (current === 'menu') { blip(300); show('power'); }
  }

  // ---------- upload: il gioco va sul server, che lo alleggerisce (CHD) e lo aggiunge al menu ----------
  function openUpload() { blip(880, 0.1); $('#file-input').click(); }

  const up = { box: $('#upload'), title: $('#up-title'), step: $('#up-step'), bar: $('#up-bar'), note: $('#up-note'), close: $('#up-close') };
  let uploading = false;
  function upShow(title, step, pct, note = '', done = false) {
    up.box.hidden = false;
    up.title.textContent = title;
    up.step.textContent = step;
    up.bar.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
    up.bar.parentElement.classList.toggle('busy', pct == null);
    up.note.textContent = note;
    up.close.hidden = !done;
  }
  up.close.addEventListener('click', () => { up.box.hidden = true; });

  // La chiave si scrive nel riquadro (mai nell'indirizzo) e resta solo in questa scheda (sessionStorage).
  function uploadKey() {
    try { return sessionStorage.getItem('ts-key') || ''; } catch { return ''; }
  }
  function openUploadKey() {
    blip(880, 0.1);
    upShow('UPLOAD', 'Enter your upload key', 0, 'Only the owner can upload. Files are checked and converted to CHD.', true);
    $('#up-keyrow').hidden = false;
    $('#up-key').value = uploadKey();
    $('#up-key').focus();
  }
  $('#up-pick').addEventListener('click', () => {
    const k = $('#up-key').value.trim();
    if (!k) return $('#up-key').focus();
    try { sessionStorage.setItem('ts-key', k); } catch {}
    $('#up-keyrow').hidden = true;
    up.box.hidden = true;
    openUpload();
  });
  function api(method, url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      const key = uploadKey();
      if (key) xhr.setRequestHeader('x-upload-token', key);
      if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || `HTTP ${xhr.status}`), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(body == null ? null : body);
    });
  }

  $('#file-input').addEventListener('change', async (e) => {
    const list = [...e.target.files];
    e.target.value = '';
    if (!list.length || uploading) return;
    uploading = true;
    const total = list.reduce((s, f) => s + f.size, 0);
    report('upload', { files: list.map((f) => f.name), bytes: total });
    try {
      upShow('UPLOADING', 'starting…', null);
      const job = await api('POST', '/api/upload');
      let sent = 0;
      for (const [i, f] of list.entries()) {
        await api('PUT', `/api/upload/${job.id}/${encodeURIComponent(f.name)}`, f, (loaded) => {
          upShow('UPLOADING', `FILE ${i + 1}/${list.length} · ${fmtSize(sent + loaded)} / ${fmtSize(total)}`, ((sent + loaded) / total) * 100, f.name);
        });
        sent += f.size;
      }
      await api('POST', `/api/upload/${job.id}/convert`, JSON.stringify({}));
      // stato della conversione
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await api('GET', `/api/upload/${job.id}`);
        if (s.state === 'error') throw new Error(s.error || 'Conversion failed.');
        if (s.state === 'done') {
          const r = s.result;
          upShow('READY', `${fmtSize(r.inBytes)} → ${fmtSize(r.outBytes)}`, 100, `${r.title} is in the menu. It streams in 1 MB pieces.`, true);
          window.TS_GAME = r.id;
          await loadCatalog();
          report('upload-done', r);
          break;
        }
        const label = { extracting: 'UNPACKING', checking: 'CHECKING', copying: 'COPYING', compressing: 'LIGHTENING' }[s.step] || 'WORKING';
        upShow(label, s.pct != null ? `${Math.round(s.pct)}%` : 'please wait…', s.pct, 'Converting to CHD: smaller, and playable while it downloads.');
      }
    } catch (err) {
      report('upload-error', err.message);
      upShow('UPLOAD FAILED', err.message, 0, 'Accepted: .cue + .bin, .iso, .chd, or a .7z / .zip / .rar containing them.', true);
    } finally {
      uploading = false;
    }
  });

  // ---------- emulatore ----------
  // Bug di EmulatorJS 4.2.3: EJS_externalFiles scrive un ArrayBuffer con FS.writeFile, che accetta solo
  // stringhe o typed array → i .bin finiscono vuoti (0 byte) e il core apre il menu di RetroArch.
  // Correzione: quando il bundle registra EJS_GameManager, avvolgiamo writeFile convertendo in Uint8Array.
  function patchGameManager() {
    let cls;
    Object.defineProperty(window, 'EJS_GameManager', {
      configurable: true,
      get: () => cls,
      set: (v) => {
        cls = v;
        const orig = v && v.prototype && v.prototype.writeFile;
        if (orig && !orig.tsPatched) {
          v.prototype.writeFile = function (p, data) {
            return orig.call(this, p, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          };
          v.prototype.writeFile.tsPatched = true;
        }
        // "Load State" senza uno stato salvato passa undefined e manda in errore il core: si avvisa e basta
        const ls = v && v.prototype && v.prototype.loadState;
        if (ls && !ls.tsPatched) {
          v.prototype.loadState = function (data) {
            if (!data || !(ArrayBuffer.isView(data) || data instanceof ArrayBuffer)) { toast('NO SAVED STATE YET'); return; }
            return ls.call(this, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          };
          v.prototype.loadState.tsPatched = true;
        }
      },
    });
  }

  // ---------- controller a schermo ----------
  // Il gamepad virtuale di EmulatorJS ascolta solo eventi touch (col mouse non funziona) e per psx ha il layout SNES.
  // Il nostro usa pointer events (dito e mouse, multi-touch) e manda gli input con gameManager.simulateInput.
  // Id joypad RetroArch: B=0 Y=1 SELECT=2 START=3 SU=4 GIÙ=5 SX=6 DX=7 A=8 X=9 L=10 R=11 L2=12 R2=13.
  // Con pcsx_rearmed: ✕=B(0), ○=A(8), □=Y(1), △=X(9).
  // Un clic dura pochi ms: se il rilascio arriva prima che il core legga gli input (1 volta per frame),
  // la pressione si perde. Ogni pressione resta attiva almeno MIN_HOLD ms.
  // Sui telefoni lenti 80 ms possono essere meno di un fotogramma dell'emulatore: allora il rilascio si rimanda
  // anche finché il gioco non ha fatto almeno MIN_FRAMES fotogrammi da quando il tasto è stato premuto.
  const MIN_HOLD = 80, MIN_FRAMES = 2;
  const pressedAt = {}, pressedFrame = {}, releaseTimer = {};
  const frameNow = () => { try { return window.EJS_emulator.gameManager.getFrameNum(); } catch { return 0; } };
  function rawInput(id, v) {
    if (guestSend(id, v)) return; // VERSUS: il giocatore 2 manda i tasti al giocatore 1
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (gm && window.EJS_emulator.started) gm.simulateInput(0, id, v);
  }
  function sendInput(id, down) {
    clearTimeout(releaseTimer[id]);
    if (down) { pressedAt[id] = performance.now(); pressedFrame[id] = frameNow(); return rawInput(id, 1); }
    const release = () => {
      const heldMs = performance.now() - (pressedAt[id] || 0);
      const heldFrames = frameNow() - (pressedFrame[id] || 0);
      // locale: aspetta tempo E fotogrammi (max 1 s); in VERSUS da giocatore 2 conta solo il tempo
      if (heldMs < MIN_HOLD || (vs.role !== 'guest' && heldFrames < MIN_FRAMES && heldMs < 1000)) {
        releaseTimer[id] = setTimeout(release, 16);
      } else rawInput(id, 0);
    };
    release();
  }

  // velocità reale dell'emulatore sul dispositivo (una volta, dopo l'avvio): per capire i telefoni lenti
  // Media fps + cali: per 10 s si guarda ogni quanto avanza il fotogramma dell'emulatore. "late" = volte in cui tra un
  // fotogramma e il successivo sono passati più di 25 ms (a 60 fps dovrebbero essere ~16,7), "worst" = attesa peggiore.
  function reportPerf() {
    const a = frameNow(), t0 = performance.now();
    let last = a, lastT = t0, late = 0, worst = 0;
    const iv = setInterval(() => {
      const f = frameNow(), now = performance.now();
      if (f !== last) {
        const gap = (now - lastT) / Math.max(1, f - last);
        if (now - lastT > 25 && f - last === 1) late++;
        worst = Math.max(worst, now - lastT);
        last = f; lastT = now;
      }
    }, 4);
    setTimeout(() => {
      clearInterval(iv);
      report('perf', { fps: Math.round(((frameNow() - a) * 1000) / (performance.now() - t0)), late, worstMs: Math.round(worst), busyMs: takeClockLoad(), w: innerWidth, h: innerHeight });
    }, 10000);
  }

  function setupPad() {
    const pad = $('#pad');
    // pulsanti: ogni dito/puntatore tiene premuto il suo pulsante finché non si alza
    pad.querySelectorAll('[data-in]').forEach((b) => {
      const id = Number(b.dataset.in);
      const press = (e) => {
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch {}
        b.classList.add('on'); sendInput(id, true);
        if (navigator.vibrate) navigator.vibrate(8);
      };
      const release = (e) => { e.preventDefault(); if (b.classList.contains('on')) { b.classList.remove('on'); sendInput(id, false); } };
      b.addEventListener('pointerdown', press);
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('lostpointercapture', release);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // croce: direzione dalla posizione del dito rispetto al centro (anche diagonali, si può strisciare)
    const dpad = $('#dpad');
    const arms = { 4: dpad.querySelector('.up'), 5: dpad.querySelector('.down'), 6: dpad.querySelector('.left'), 7: dpad.querySelector('.right') };
    let held = new Set(), active = null;
    const apply = (next) => {
      for (const id of [4, 5, 6, 7]) {
        const want = next.has(id);
        if (want !== held.has(id)) { sendInput(id, want); arms[id].classList.toggle('on', want); }
      }
      held = next;
    };
    const dirFrom = (e) => {
      const r = dpad.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const dead = r.width * 0.12, s = new Set();
      if (Math.hypot(dx, dy) < dead) return s;
      const a = Math.atan2(dy, dx) * 180 / Math.PI; // 0 = destra, 90 = giù
      if (a > -67.5 && a < 67.5) s.add(7);
      if (a > 22.5 && a < 157.5) s.add(5);
      if (a > 112.5 || a < -112.5) s.add(6);
      if (a > -157.5 && a < -22.5) s.add(4);
      return s;
    };
    dpad.addEventListener('pointerdown', (e) => {
      e.preventDefault(); active = e.pointerId;
      try { dpad.setPointerCapture(e.pointerId); } catch {}
      apply(dirFrom(e));
      if (navigator.vibrate) navigator.vibrate(8);
    });
    dpad.addEventListener('pointermove', (e) => { if (e.pointerId === active) apply(dirFrom(e)); });
    const end = (e) => { if (e.pointerId === active) { active = null; apply(new Set()); } };
    dpad.addEventListener('pointerup', end);
    dpad.addEventListener('pointercancel', end);
    dpad.addEventListener('lostpointercapture', end);

    $('#btn-pad').addEventListener('click', () => { document.body.classList.toggle('pad-off'); refocusGame(); });
    $('#btn-keys').addEventListener('click', () => { $('#keys').hidden = false; });
    $('#keys-close').addEventListener('click', () => { $('#keys').hidden = true; refocusGame(); });
  }

  // La tastiera arriva a EmulatorJS solo se il suo contenitore ha il focus
  function refocusGame() {
    const p = window.EJS_emulator && window.EJS_emulator.elements && window.EJS_emulator.elements.parent;
    if (p) p.focus();
  }

  // ---------- menu dell'emulatore senza import/export ----------
  // EJS_Buttons nasconde i pulsanti della barra; qui si tolgono le voci del menu contestuale che scaricano file
  // (screenshot, registrazione) e si blocca il trascinamento di file sul gioco (caricava stati da file).
  const KILL_ITEMS = ['Take Screenshot', 'Start Screen Recording', 'Stop Screen Recording', 'Export Save File', 'Import Save File', 'Cache Manager', 'Cheats', 'Netplay'];
  function stripEmulatorMenus() {
    document.querySelectorAll('#game li, #game button, #game a').forEach((el) => {
      if (KILL_ITEMS.includes(el.textContent.trim())) (el.closest('li') || el).remove();
    });
  }
  ['dragenter', 'dragover', 'drop'].forEach((t) => $('#game-wrap').addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); }, true));

  // ---------- VERSUS: 1 contro 1 in streaming (WebRTC) ----------
  // I due giocatori scrivono la STESSA password (codice stanza = SHA-256 della password, stanza sul nostro server).
  // Il primo è il giocatore 1: fa girare il gioco e manda il VIDEO dell'emulatore direttamente all'altro (WebRTC).
  // Il secondo è il giocatore 2: guarda il video e manda i suoi TASTI su un canale dati diretto; il giocatore 1
  // li applica come "controller 2". Niente sincronizzazione di due emulatori: il giocatore 1 non ha ritardo,
  // il 2 ha solo quello della rete. Il server fa da presentatore (signal) e controlla la password (netplay.mjs).
  const vs = { panel: $('#vs'), pin: '', go: $('#vs-go'), status: $('#vs-status'),
    leave: $('#vs-leave'), video: $('#vs-video'), badge: $('#vs-badge'),
    socket: null, pc: null, dc: null, role: null, busy: false, inRoom: false, game: null,
    viewers: new Map(), lastWatchers: [], hostId: null };
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  // Server per il collegamento: STUN sempre; dentro una stanza il server delle lobby dà anche il PONTE (TURN sul VPS,
  // credenziali temporanee). Serve col 5G (CGNAT) o 5G + Wi-Fi, dove il collegamento diretto non riesce: allora
  // video, audio e tasti passano dal VPS. Se il diretto riesce si usa quello (meno ritardo).
  // ?relay=1: solo ponte, per provarlo.
  async function loadIce() {
    try {
      const list = await Promise.race([ask('ice').then(([l]) => l), new Promise((r) => setTimeout(() => r(null), 3000))]);
      vs.ice = Array.isArray(list) && list.length ? list : ICE;
    } catch { vs.ice = ICE; }
    report('versus-ice', { turn: vs.ice.some((x) => String(x.urls).includes('turn:')) });
  }
  const rtcConfig = () => ({ iceServers: vs.ice || ICE, ...(new URLSearchParams(location.search).has('relay') ? { iceTransportPolicy: 'relay' } : {}) });
  // dopo il collegamento: diretto o tramite ponte? (registro, per capire le reti dei giocatori)
  async function reportRoute(pc) {
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((st) => { if (st.type === 'candidate-pair' && st.state === 'succeeded' && (st.nominated || st.selected)) pair = st; });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
      report('versus-route', { local: local && local.candidateType, remote: remote && remote.candidateType, proto: local && local.protocol, rttMs: pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null });
      // passa dal ponte (VPS): il giocatore 1 manda il video a 1,5 Mbit/s invece di 2,5 → con 100 persone il VPS
      // (200 Mbit/s in tutto, condivisi coi pezzi di gioco) regge il doppio delle sfide sul ponte; su telefono si nota poco
      const relayed = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
      if (relayed && vs.role === 'host') {
        for (const sender of pc.getSenders()) {
          if (!sender.track || sender.track.kind !== 'video') continue;
          try { const p = sender.getParameters(); (p.encodings && p.encodings.length ? p.encodings : (p.encodings = [{}])).forEach((e) => { e.maxBitrate = 1_500_000; }); await sender.setParameters(p); } catch {}
        }
      }
    } catch {}
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const VALID_IN = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

  // games.json: "versus": true = uno contro l'altro (Tekken, MvC, CTR); "versus": "coop" = in squadra (Diablo).
  // Lobby e collegamento sono identici: cambia solo cosa c'è scritto.
  const MODES = {
    versus: { icon: '⚔', name: 'VERSUS', sub: '1 VS 1', on: 'VS ON', go: 'FIGHT!' },
    coop: { icon: '✚', name: 'CO-OP', sub: '2 PLAYERS', on: 'CO-OP ON', go: "LET'S GO!" },
  };
  function modeOf(g) { return g && g.versus === 'coop' ? MODES.coop : MODES.versus; }

  async function lobbyCode(gameId, pw) {
    // pagina aperta in http: il browser non dà crypto.subtle (il server ora rimanda a https, questo è un paracadute)
    if (!window.crypto || !crypto.subtle) throw new Error('Open the secure address (https://) to use VERSUS.');
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tweetstation|${gameId}|${pw}`)));
    return Array.from(h.slice(0, 6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  }
  function vsStatus(text, err = false) { vs.status.className = 'vs-status' + (err ? ' err' : ''); vs.status.textContent = text; }
  function vsUi() {
    $('#vs-form').hidden = vs.inRoom; vs.leave.hidden = !vs.inRoom; vs.go.disabled = vs.busy || vs.pin.length < 4;
    $('#vs-watch').disabled = vs.busy || vs.pin.length < 4; $('#vs-quick').disabled = vs.busy;
  }
  // lo stato (P1/P2, collegato…) si scrive dentro il pulsante VERSUS: un'etichetta a parte si sovrapponeva sui telefoni
  function vsBadge(text) {
    const m = modeOf(vs.game), b = $('#btn-vs');
    b.textContent = text ? text.replace('⚔', m.icon).replace('VS ON', m.on) : `${m.icon} ${m.name}`;
    b.setAttribute('aria-label', `${m.name}: ${m.sub}`);
    b.classList.toggle('on', !!text);
  }
  // su iPhone il focus automatico confonde i campi (si scrive in quello sbagliato): solo con mouse
  const canAutoFocus = () => matchMedia('(pointer: fine)').matches;
  // potenza del dispositivo: il gioco deve girare su quello più forte (PC > telefono)
  const devicePower = () => (matchMedia('(pointer: fine)').matches && !matchMedia('(pointer: coarse)').matches ? 2 : 1);
  const ask = (ev, data) => new Promise((resolve) => vs.socket.emit(ev, data, (...a) => resolve(a)));

  function versusGame() {
    // gioco del VERSUS: quello in corso, altrimenti il disco selezionato nel menu
    return vs.game || (current === 'menu' ? discs[sel] : null);
  }

  function openVs() {
    const g = versusGame();
    if (!g || !g.versus) return toast('NO 2-PLAYER MODE IN THIS GAME');
    vs.game = g;
    $('#vs-title').textContent = `${modeOf(g).name} · ${modeOf(g).sub}`;
    vs.panel.hidden = false;
    vsUi();
    if (!vs.inRoom) { vsStatus('You and your friend enter the SAME code\nand press ENTER LOBBY.\n⚡ QUICK MATCH: a random opponent, no code.'); renderPin(); }
  }

  function connectSocket() {
    if (vs.socket && vs.socket.connected) return Promise.resolve();
    if (typeof window.io !== 'function') return loadScript('/socket.io/socket.io.min.js').then(connectSocket); // client ufficiale servito dal nostro socket.io
    return new Promise((resolve, reject) => {
      vs.socket = window.io(location.origin, { transports: ['websocket', 'polling'], reconnection: false });
      vs.socket.on('connect', resolve);
      vs.socket.on('connect_error', () => reject(new Error('Cannot reach the lobby server.')));
      vs.socket.on('signal', onSignal);
      vs.socket.on('users-updated', onPlayers);
      vs.socket.on('watchers', (list) => { vs.lastWatchers = Array.isArray(list) ? list : []; syncWatchers(); });
      vs.socket.on('disconnect', () => { if (vs.inRoom) endVersus('Lobby closed.'); });
    });
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
  }

  async function enterLobby() {
    if (vs.busy || vs.inRoom) return;
    const pw = vs.pin, name = matchMedia('(pointer: fine)').matches ? 'PC' : 'Phone';
    if (pw.length < 4) return vsStatus('Code: at least 4 digits.', true);
    if (!window.RTCPeerConnection) return vsStatus('This browser cannot do VERSUS (no WebRTC).', true);
    try { localStorage.setItem('ts-name', name); } catch {}
    vs.busy = true; vsUi(); vsStatus('Looking for the lobby…');
    report('versus', 'enter');
    try {
      await connectSocket();
      const code = await lobbyCode(vs.game.id, pw);
      const extra = () => ({ domain: location.host, game_id: vs.game.id, room_name: code, player_name: name, userid: uuid(), sessionid: uuid() });
      let [err] = await ask('join-room', { extra: extra(), password: pw });
      if (!err) { await loadIce(); return becomeGuest(); }
      if (err !== 'Wrong room code or password.') throw new Error(err);
      [err] = await ask('open-room', { extra: extra(), maxPlayers: 2, password: pw });
      if (err === 'Room code already in use.') { vs.busy = false; return enterLobby(); } // l'altro è arrivato un attimo prima
      if (err) throw new Error(err);
      await loadIce();
      becomeHost();
    } catch (e) {
      vsStatus(String(e.message || e), true);
    } finally { vs.busy = false; vsUi(); }
  }

  const playerName = () => (matchMedia('(pointer: fine)').matches ? 'PC' : 'Phone');
  const roomExtra = (code, name = playerName()) => ({ domain: location.host, game_id: vs.game.id, room_name: code, player_name: name, userid: uuid(), sessionid: uuid() });

  // ----- PARTITA VELOCE: senza codice, il server abbina chi aspetta sullo stesso gioco (netplay.mjs "quick") -----
  async function quickMatch() {
    if (vs.busy || vs.inRoom) return;
    if (!window.RTCPeerConnection) return vsStatus('This browser cannot do VERSUS (no WebRTC).', true);
    vs.busy = true; vsUi(); vsStatus('Looking for an opponent…');
    report('versus', 'quick');
    try {
      await connectSocket();
      const [q] = await ask('quick', { game: vs.game.id });
      if (!q || q.error) throw new Error((q && q.error) || 'Quick match failed.');
      if (q.action === 'open') {
        const [err] = await ask('open-room', { extra: roomExtra(q.code), maxPlayers: 2, password: q.pw });
        if (err) throw new Error(err);
        await loadIce();
        becomeHost();
        vsStatus('⚡ QUICK MATCH · You are PLAYER 1.\nWaiting for a random opponent…\n(up to 3 minutes)');
        return;
      }
      // l'altro sta aprendo la stanza proprio adesso: qualche tentativo ravvicinato
      let err = 'wait';
      for (let i = 0; i < 6 && err; i++) {
        [err] = await ask('join-room', { extra: roomExtra(q.code), password: q.pw });
        if (err) await new Promise((r) => setTimeout(r, 600));
      }
      if (err) throw new Error('The opponent left. Try again.');
      await loadIce();
      becomeGuest();
    } catch (e) {
      vsStatus(String(e.message || e), true);
    } finally { vs.busy = false; vsUi(); }
  }

  // ----- SPETTATORE: stesso codice dei giocatori, guarda il video del giocatore 1 (niente tasti) -----
  async function watchLobby() {
    if (vs.busy || vs.inRoom) return;
    const pw = vs.pin;
    if (pw.length < 4) return vsStatus('Type the code of the match you want to watch.', true);
    if (!window.RTCPeerConnection) return vsStatus('This browser cannot do VERSUS (no WebRTC).', true);
    vs.busy = true; vsUi(); vsStatus('Looking for the match…');
    report('versus', 'watch');
    try {
      await connectSocket();
      const [err] = await ask('watch-room', { extra: roomExtra(await lobbyCode(vs.game.id, pw), 'Viewer'), password: pw });
      if (err) throw new Error(err);
      await loadIce();
      becomeWatcher();
    } catch (e) {
      vsStatus(String(e.message || e), true);
    } finally { vs.busy = false; vsUi(); }
  }
  function becomeWatcher() {
    vs.role = 'watcher'; vs.inRoom = true; vsUi();
    vsStatus('👁 SPECTATOR · waiting for the video…');
    vsBadge('👁 WATCHING');
    const E = window.EJS_emulator;
    if (E && E.started) { try { E.pause ? E.pause(true) : E.gameManager.toggleMainLoop(0); } catch {} }
    document.body.classList.add('has-vs', 'vs-guest', 'vs-watch');
    show('game');
    vs.video.hidden = false;
  }

  // ----- giocatore 1 → spettatori: una connessione diretta (solo video, 1,5 Mbit/s) per spettatore -----
  let shared = null;
  function gameStream() {
    const E = window.EJS_emulator;
    if (!shared || shared.getVideoTracks().every((t) => t.readyState === 'ended')) shared = E.canvas.captureStream(60);
    return shared;
  }
  function closeViewers() {
    for (const pc of vs.viewers.values()) { try { pc.close(); } catch {} }
    vs.viewers.clear();
  }
  let watchRetry = null;
  async function syncWatchers() {
    if (vs.role !== 'host' || !vs.socket) return;
    const E = window.EJS_emulator;
    clearTimeout(watchRetry);
    if (!E || !E.started || !E.canvas) { watchRetry = setTimeout(syncWatchers, 1000); return; } // il gioco sta partendo
    const want = new Set(vs.lastWatchers);
    for (const [id, pc] of vs.viewers) if (!want.has(id)) { try { pc.close(); } catch {} vs.viewers.delete(id); }
    const before = vs.viewers.size;
    for (const id of want) {
      if (vs.viewers.has(id)) continue;
      const pc = new RTCPeerConnection(rtcConfig());
      vs.viewers.set(id, pc);
      const stream = gameStream();
      for (const track of stream.getVideoTracks()) {
        const sender = pc.addTrack(track, stream);
        try { const p = sender.getParameters(); p.encodings = [{ maxBitrate: 1_500_000, maxFramerate: 30 }]; sender.setParameters(p).catch(() => {}); } catch {}
      }
      pc.onicecandidate = (e) => { if (e.candidate && vs.socket) vs.socket.emit('signal', { to: id, candidate: e.candidate.toJSON() }); };
      try {
        await pc.setLocalDescription(await pc.createOffer());
        vs.socket.emit('signal', { to: id, sdp: pc.localDescription.toJSON() });
      } catch (e) { report('versus-error', 'viewer: ' + String(e.message || e)); }
    }
    if (vs.viewers.size > before) toast(`👁 ${vs.viewers.size} WATCHING`);
    report('versus', { viewers: vs.viewers.size });
  }

  // ----- giocatore 1: gioco locale + video verso l'altro -----
  function becomeHost() {
    vs.role = 'host'; vs.inRoom = true; vs.players = 1; vs.otherPower = null; vsUi();
    vsStatus('You are PLAYER 1.\nWaiting for your friend…\n(they type the same password)');
    vsBadge('⚔ P1 · WAITING');
    if (!started) confirmGame(vs.game); // se si entra dal menu, parte il gioco
  }
  // avvia il gioco anche se siamo già sulla schermata di gioco (es. dopo uno scambio di ruoli): confirm() parte solo dal menu
  function confirmGame(g) { const i = discs.indexOf(g); if (i >= 0 && !started) { sel = i; current = 'menu'; confirm(); } }

  function onPlayers(players) {
    vs.players = Object.keys(players || {}).length;
    if (vs.role !== 'host') return;
    if (vs.players >= 2) decideRoles();
    if (vs.players < 2) { vs.otherPower = null; if (vs.pc) { closePeer(); vsBadge('⚔ P1 · WAITING'); toast('PLAYER 2 LEFT'); } }
  }
  // chiamata quando ci sono 2 giocatori E si conosce la potenza dell'altro (arriva col messaggio "hello")
  function decideRoles() {
    if (vs.role !== 'host' || vs.pc || vs.players < 2 || vs.otherPower == null) return;
    if (vs.otherPower > devicePower()) {
      // l'altro è più potente (PC): fa lui il giocatore 1, noi guardiamo il video
      vs.socket.emit('signal', { swap: true });
      report('versus', 'swap-to-guest');
      becomeGuest();
      return;
    }
    startStream();
  }

  async function startStream() {
    // aspetta che l'emulatore stia girando (il giocatore 1 può essere entrato dal menu)
    for (let i = 0; i < 120 && !(window.EJS_emulator && window.EJS_emulator.started && window.EJS_emulator.canvas); i++) await new Promise((r) => setTimeout(r, 250));
    const E = window.EJS_emulator;
    if (!E || !E.canvas) return vsStatus('The game did not start.', true);
    const pc = vs.pc = new RTCPeerConnection(rtcConfig());
    const stream = gameStream();
    for (const track of stream.getVideoTracks()) {
      track.contentHint = 'motion';
      const sender = pc.addTrack(track, stream);
      try { const p = sender.getParameters(); p.degradationPreference = 'maintain-framerate'; p.encodings = [{ maxBitrate: 2_500_000, maxFramerate: 60 }]; sender.setParameters(p).catch(() => {}); } catch {}
    }
    // audio del gioco per il giocatore 2, in un flusso SEPARATO dal video: con audio e video nello stesso flusso il
    // telefono ritarda il video per allinearlo all'audio (che ha un buffer più lungo) e i tasti sembrerebbero in ritardo
    const audio = gameAudioTrack();
    if (audio) {
      const sender = pc.addTrack(audio, new MediaStream([audio]));
      try { const p = sender.getParameters(); p.encodings = [{ maxBitrate: 128_000 }]; sender.setParameters(p).catch(() => {}); } catch {}
    }
    report('versus-audio', audio ? 'sending' : 'no-audio');
    // tasti del giocatore 2: canale non ordinato e senza ritrasmissioni (meglio perdere un pacchetto che arrivare tardi)
    const dc = vs.dc = pc.createDataChannel('pad', { ordered: false, maxRetransmits: 0 });
    dc.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m.rewind === 'number') return undoChoice('PLAYER 2', m.rewind); // ↩ UNDO chiesto dal giocatore 2
      if (!Array.isArray(m) || !VALID_IN.has(m[0]) || (m[1] !== 0 && m[1] !== 1)) return;
      try { E.gameManager.simulateInput(1, m[0], m[1]); } catch {} // passa da hookUndo: anche le scelte del P2 si annullano
    };
    const sendVis = () => { try { if (dc.readyState === 'open') dc.send(JSON.stringify({ p1: document.hidden ? 'paused' : 'playing' })); } catch {} };
    document.addEventListener('visibilitychange', sendVis);
    dc.onopen = () => { sendVis(); vsBadge('⚔ P1 · VS ON'); vsStatus(`PLAYER 2 CONNECTED · ${modeOf(vs.game).go}`); toast(`PLAYER 2 CONNECTED · ${modeOf(vs.game).go}`); setTimeout(() => { vs.panel.hidden = true; refocusGame(); }, 1200); };
    watchPeer(pc);
    pc.onicecandidate = (e) => { if (e.candidate) vs.socket.emit('signal', { candidate: e.candidate.toJSON() }); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    vs.socket.emit('signal', { sdp: pc.localDescription.toJSON() });
    vsStatus('Friend found · connecting…');
  }

  function swapToHost() {
    closePeer();
    vs.role = 'host'; vs.otherPower = 0; vs.players = 2;
    vs.video.hidden = true; vs.video.srcObject = null;
    document.body.classList.remove('vs-guest');
    vsBadge('⚔ P1 · STARTING');
    vsStatus('Your device is faster: you run the game.\nYou are PLAYER 1.');
    const E = window.EJS_emulator;
    if (E && E.started) { try { E.play ? E.play(true) : E.gameManager.toggleMainLoop(1); } catch {} }
    else if (!started) confirmGame(vs.game);
    startStream();
    vs.socket.emit('get-watchers', (list) => { vs.lastWatchers = Array.isArray(list) ? list : []; syncWatchers(); });
  }

  // ----- giocatore 2: video del giocatore 1 + tasti verso di lui -----
  function becomeGuest() {
    closeViewers();
    vs.role = 'guest'; vs.inRoom = true; vsUi();
    vsStatus('You are PLAYER 2.\nConnecting to player 1…');
    vsBadge('⚔ P2 · CONNECTING');
    const E = window.EJS_emulator;
    if (E && E.started) { try { E.pause ? E.pause(true) : E.gameManager.toggleMainLoop(0); } catch {} } // il proprio emulatore si ferma: si gioca sul video
    document.body.classList.add('has-vs', 'vs-guest');
    show('game');
    vs.video.hidden = false;
    vs.socket.emit('signal', { hello: devicePower() }); // il giocatore 1 decide chi fa girare il gioco
  }

  async function onSignal(msg) {
    try {
      // giocatore 1: risposta e candidati di uno spettatore
      if (vs.role === 'host' && msg.from && vs.viewers.has(msg.from)) {
        const pc = vs.viewers.get(msg.from);
        if (msg.sdp && msg.sdp.type === 'answer') await pc.setRemoteDescription(msg.sdp);
        else if (msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
        return;
      }
      // spettatore: offerta e candidati del giocatore 1
      if (vs.role === 'watcher') {
        if (msg.sdp && msg.sdp.type === 'offer') {
          closePeer();
          vs.hostId = msg.from;
          const pc = vs.pc = new RTCPeerConnection(rtcConfig());
          pc.ontrack = (e) => {
            try { e.receiver.playoutDelayHint = 0.1; } catch {}
            vs.video.srcObject = e.streams[0] || new MediaStream([e.track]);
            vs.video.play().catch(() => toast('TAP THE SCREEN TO SHOW THE MATCH', 5000));
            vsStatus('👁 SPECTATOR · LIVE'); setTimeout(() => { vs.panel.hidden = true; }, 1200);
          };
          pc.onicecandidate = (e) => { if (e.candidate && vs.socket) vs.socket.emit('signal', { to: vs.hostId, candidate: e.candidate.toJSON() }); };
          watchPeer(pc);
          await pc.setRemoteDescription(msg.sdp);
          await pc.setLocalDescription(await pc.createAnswer());
          vs.socket.emit('signal', { to: vs.hostId, sdp: pc.localDescription.toJSON() });
        } else if (msg.candidate && vs.pc) await vs.pc.addIceCandidate(msg.candidate).catch(() => {});
        return;
      }
      if (msg.hello != null && vs.role === 'host') { vs.otherPower = Number(msg.hello) || 1; decideRoles(); return; }
      if (msg.swap && vs.role === 'guest') { swapToHost(); return; }
      if (msg.sdp && msg.sdp.type === 'offer' && vs.role === 'guest') {
        closePeer();
        const pc = vs.pc = new RTCPeerConnection(rtcConfig());
        pc.ontrack = (e) => {
          if (e.track.kind === 'audio') return playVsAudio(e.streams[0] || new MediaStream([e.track]));
          // 25 ms di margine: con zero buffer ogni fotogramma un po' in ritardo faceva scattare il video (provato su iPhone)
          try { e.receiver.playoutDelayHint = 0.025; e.receiver.jitterBufferTarget = 25; } catch {}
          smoothVideo(pc, e.receiver);
          vs.video.srcObject = e.streams[0] || new MediaStream([e.track]);
          vs.video.play().catch((err) => { report('versus-video', 'play blocked: ' + err.name); toast('TAP THE SCREEN TO SHOW PLAYER 1', 5000); });
          setTimeout(() => report('versus-video', { w: vs.video.videoWidth, h: vs.video.videoHeight, paused: vs.video.paused }), 4000);
        };
        pc.ondatachannel = (e) => {
          vs.dc = e.channel;
          vs.dc.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m && m.p1 === 'paused') { vsBadge('⚔ P2 · P1 PAUSED'); toast('PLAYER 1 SWITCHED AWAY · GAME PAUSED', 4000); }
            if (m && m.p1 === 'playing') vsBadge('⚔ P2 · VS ON');
          };
          vs.dc.onopen = () => { vsBadge('⚔ P2 · VS ON'); vsStatus(`CONNECTED · YOU ARE PLAYER 2 · ${modeOf(vs.game).go}`); toast('CONNECTED · YOU ARE PLAYER 2'); setTimeout(() => { vs.panel.hidden = true; }, 1200); };
        };
        pc.onicecandidate = (e) => { if (e.candidate) vs.socket.emit('signal', { candidate: e.candidate.toJSON() }); };
        watchPeer(pc);
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        answer.sdp = stereoOpus(answer.sdp);
        await pc.setLocalDescription(answer);
        vs.socket.emit('signal', { sdp: pc.localDescription.toJSON() });
      } else if (msg.sdp && msg.sdp.type === 'answer' && vs.role === 'host' && vs.pc) {
        await vs.pc.setRemoteDescription(msg.sdp);
      } else if (msg.candidate && vs.pc) {
        await vs.pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    } catch (e) { report('versus-error', String(e.message || e)); }
  }

  // Giocatore 2 su rete instabile (5G): i pacchetti arrivano a ondate e con 25 ms di margine il video si blocca a ogni
  // onda ("cali assurdi", registro 2026-10-09). Ogni 2 s si guarda il video ricevuto: se ci sono blocchi, scarti o
  // variazioni forti, il margine sale (fino a 200 ms: un po' più di ritardo ma video liscio); se è tutto stabile per
  // 10 s, scende di nuovo verso 25 ms.
  function smoothVideo(pc, receiver) {
    let delay = 0.025, calm = 0, last = null;
    const iv = setInterval(async () => {
      if (pc.connectionState === 'closed' || vs.pc !== pc) return clearInterval(iv);
      let v = null;
      try { (await pc.getStats()).forEach((st) => { if (st.type === 'inbound-rtp' && st.kind === 'video') v = st; }); } catch { return; }
      if (!v) return;
      const cur = { freezes: v.freezeCount || 0, dropped: v.framesDropped || 0, lost: v.packetsLost || 0, decoded: v.framesDecoded || 0 };
      if (last) {
        const bad = cur.freezes > last.freezes || cur.dropped - last.dropped > 6 || cur.lost - last.lost > 20 || (v.jitter || 0) > 0.03;
        const before = delay;
        if (bad) { delay = Math.min(0.2, delay + 0.04); calm = 0; }
        else if (++calm >= 5) { delay = Math.max(0.025, delay - 0.02); calm = 0; }
        if (delay !== before) {
          try { receiver.playoutDelayHint = delay; receiver.jitterBufferTarget = Math.round(delay * 1000); } catch {}
          report('versus-smooth', { ms: Math.round(delay * 1000), jitterMs: Math.round((v.jitter || 0) * 1000), freezes: cur.freezes });
        }
      }
      last = cur;
    }, 2000);
  }

  function watchPeer(pc) {
    const t = setTimeout(() => {
      const linked = pc.connectionState === 'connected' || (vs.dc && vs.dc.readyState === 'open');
      if (!linked && vs.pc === pc) vsStatus('Connection failed: this network blocks it.\nTry again, or switch network.', true);
    }, 15000);
    pc.onconnectionstatechange = () => {
      report('versus-state', pc.connectionState);
      if (pc.connectionState === 'connected') { clearTimeout(t); setTimeout(() => reportRoute(pc), 1500); }
      if (pc.connectionState === 'failed') { vsStatus('Connection failed: this network blocks it.\nTry again, or switch network.', true); reportRoute(pc); report('versus-error', 'ice failed'); }
      if (pc.connectionState === 'disconnected' && vs.role === 'guest') vsBadge('⚔ P2 · RECONNECTING');
    };
  }
  function closePeer() {
    try { vs.dc && vs.dc.close(); } catch {}
    try { vs.pc && vs.pc.close(); } catch {}
    vs.pc = null; vs.dc = null;
    vsAudio.srcObject = null;
  }

  // ----- audio del VERSUS -----
  // Giocatore 1: l'uscita audio del core (OpenAL, AL.currentCtx.gain) va anche in un MediaStream da mandare.
  let audioOut = null;
  function gameAudioTrack() {
    try {
      const ctx = window.EJS_emulator.Module.AL.currentCtx;
      if (!audioOut || audioOut.ctx !== ctx) {
        const dest = ctx.audioCtx.createMediaStreamDestination();
        ctx.gain.connect(dest);
        audioOut = { ctx, dest };
      }
      return audioOut.dest.stream.getAudioTracks()[0] || null;
    } catch { return null; }
  }
  // Giocatore 2: elemento audio a parte (il video resta muto e quindi parte da solo). Se il telefono blocca l'audio
  // senza un tocco, si chiede un tocco (vedi pointerdown più sotto).
  const vsAudio = document.createElement('audio');
  vsAudio.autoplay = true;
  vsAudio.setAttribute('playsinline', '');
  vsAudio.hidden = true;
  document.body.appendChild(vsAudio);
  function playVsAudio(stream) {
    vsAudio.srcObject = stream;
    vsAudio.play()
      .then(() => report('versus-audio', 'playing'))
      .catch(() => { report('versus-audio', 'blocked'); toast('TAP THE SCREEN TO HEAR THE GAME', 5000); });
  }
  // Opus in stereo (la PS1 è stereo; di base WebRTC manda mono): lo chiede chi riceve, nella risposta
  function stereoOpus(sdp) {
    const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
    if (!m) return sdp;
    return sdp.replace(new RegExp('a=fmtp:' + m[1] + ' ([^\\r\\n]*)'), (line, params) =>
      (params.includes('stereo=1') ? line : `a=fmtp:${m[1]} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`));
  }
  function endVersus(msg) {
    const wasGuest = vs.role === 'guest' || vs.role === 'watcher';
    closePeer();
    closeViewers();
    try { vs.socket && vs.socket.disconnect(); } catch {}
    vs.socket = null; vs.role = null; vs.inRoom = false; vsUi(); vsBadge('');
    if (msg) { vsStatus(msg, true); toast(msg.toUpperCase()); }
    if (wasGuest) { vs.video.hidden = true; vs.video.srcObject = null; setTimeout(() => location.reload(), 1500); }
  }

  // il giocatore 2 manda i tasti al giocatore 1 invece di usarli in locale
  function guestSend(id, v) {
    if (vs.role !== 'guest' || !vs.dc || vs.dc.readyState !== 'open') return false;
    vs.dc.send(JSON.stringify([id, v ? 1 : 0]));
    return true;
  }
  // tastiera del giocatore 2 (stessa mappa di EmulatorJS)
  const GUEST_KEYS = { x: 0, s: 1, v: 2, enter: 3, arrowup: 4, arrowdown: 5, arrowleft: 6, arrowright: 7, z: 8, a: 9, q: 10, e: 11, tab: 12, r: 13 };
  ['keydown', 'keyup'].forEach((type) => addEventListener(type, (e) => {
    if (vs.role !== 'guest' || (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
    const id = GUEST_KEYS[e.key.toLowerCase()];
    if (id === undefined || e.repeat) return;
    e.preventDefault(); e.stopPropagation();
    guestSend(id, type === 'keydown');
  }, true));
  // joypad del giocatore 2 (mappa "standard": 0 ✕, 1 ○, 2 □, 3 △, 4 L1, 5 R1, 6 L2, 7 R2, 8 select, 9 start, 12-15 croce)
  const PAD_MAP = { 0: 0, 1: 8, 2: 1, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13, 8: 2, 9: 3, 12: 4, 13: 5, 14: 6, 15: 7 };
  const guestPadState = {};
  (function guestPadLoop() {
    if (vs.role === 'guest') {
      for (const p of padConnected()) {
        const now = {};
        for (const [b, id] of Object.entries(PAD_MAP)) now[id] = !!(p.buttons[b] && p.buttons[b].pressed);
        const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
        now[6] = now[6] || ax < -0.5; now[7] = now[7] || ax > 0.5; now[4] = now[4] || ay < -0.5; now[5] = now[5] || ay > 0.5;
        const prev = guestPadState[p.index] || {};
        for (const id of Object.keys(now)) if (now[id] !== !!prev[id]) guestSend(Number(id), now[id]);
        guestPadState[p.index] = now;
      }
    }
    requestAnimationFrame(guestPadLoop);
  })();

  vs.go.addEventListener('click', enterLobby);
  $('#vs-quick').addEventListener('click', quickMatch);
  $('#vs-watch').addEventListener('click', watchLobby);
  // iPhone: se il video del giocatore 1 non è partito da solo, parte al primo tocco
  addEventListener('pointerdown', () => {
    if ((vs.role === 'guest' || vs.role === 'watcher') && vs.video.srcObject && vs.video.paused) vs.video.play().catch(() => {});
    if (vs.role === 'guest' && vsAudio.srcObject && vsAudio.paused) vsAudio.play().then(() => report('versus-audio', 'playing-after-tap')).catch(() => {});
  }, true);
  // tastierino del codice (tocco, mouse) + tastiera fisica quando il pannello è aperto
  function renderPin() {
    const box = $('#vs-pin');
    box.innerHTML = '';
    for (let i = 0; i < Math.max(4, vs.pin.length + (vs.pin.length < 8 ? 1 : 0)); i++) {
      const d = document.createElement('span');
      d.className = 'pin-slot' + (i < vs.pin.length ? ' on' : '') + (i === vs.pin.length ? ' cur' : '');
      d.textContent = i < vs.pin.length ? vs.pin[i] : '';
      box.appendChild(d);
    }
    vs.go.disabled = vs.busy || vs.pin.length < 4;
    $('#vs-watch').disabled = vs.busy || vs.pin.length < 4;
  }
  function pinKey(k) {
    if (vs.inRoom || vs.busy) return;
    if (/^\d$/.test(k) && vs.pin.length < 8) vs.pin += k;
    else if (k === 'del') vs.pin = vs.pin.slice(0, -1);
    else if (k === 'clr') vs.pin = '';
    else return;
    blip(k === 'del' || k === 'clr' ? 300 : 700, 0.04);
    renderPin();
  }
  $('#vs-keys').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) pinKey(b.dataset.d); });
  addEventListener('keydown', (e) => {
    if (vs.panel.hidden || vs.inRoom) return;
    if (/^\d$/.test(e.key)) pinKey(e.key);
    else if (e.key === 'Backspace') pinKey('del');
    else if (e.key === 'Enter') enterLobby();
    else if (e.key === 'Escape') { vs.panel.hidden = true; refocusGame(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  $('#btn-vs').addEventListener('click', () => { if (document.body.classList.contains('has-vs')) openVs(); });

  // ---------- CLIP: registra fino a 30 s di gioco (video + audio) e lo salva o lo condivide ----------
  // Video dallo schermo dell'emulatore, audio agganciato all'uscita del core (OpenAL: AL.currentCtx.gain).
  // Giocatore 2 e spettatori registrano il video che arriva dal giocatore 1 (senza audio: non viaggia).
  // MP4 dove il browser lo sa fare (X accetta MP4, non WebM). Salvataggio: menu "condividi" del telefono
  // (rullino, X…), altrimenti scaricamento. Se la clip finisce da sola (30 s) serve un tocco su 💾 SAVE CLIP:
  // il menu condividi parte solo da un tocco.
  const clip = { rec: null, chunks: [], t0: 0, timer: null, stream: null, unhook: null, file: null, userStop: false, btn: $('#btn-clip') };
  const CLIP_MAX = 30000;
  const clipMime = () => ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || '';
  function clipStream() {
    if ((vs.role === 'guest' || vs.role === 'watcher') && vs.video.srcObject) return new MediaStream(vs.video.srcObject.getVideoTracks().map((t) => t.clone()));
    const E = window.EJS_emulator;
    if (!E || !E.started || !E.canvas) return null;
    const s = E.canvas.captureStream(30);
    try {
      const ctx = E.Module.AL.currentCtx;
      const dest = ctx.audioCtx.createMediaStreamDestination();
      ctx.gain.connect(dest);
      clip.unhook = () => { try { ctx.gain.disconnect(dest); } catch {} };
      for (const t of dest.stream.getAudioTracks()) s.addTrack(t);
    } catch {}
    return s;
  }
  function clipLabel(t, cls = '') { clip.btn.textContent = t; clip.btn.classList.toggle('on', cls === 'on'); clip.btn.classList.toggle('ready', cls === 'ready'); }
  function clipStart() {
    if (!window.MediaRecorder) return toast('CLIPS NOT SUPPORTED ON THIS BROWSER');
    const stream = clipStream();
    if (!stream) return toast('START A GAME FIRST');
    const mime = clipMime();
    let rec;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : { videoBitsPerSecond: 4_000_000 }); }
    catch { if (clip.unhook) clip.unhook(); return toast('CLIPS NOT SUPPORTED ON THIS BROWSER'); }
    Object.assign(clip, { rec, chunks: [], t0: Date.now(), stream, file: null, userStop: false });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) clip.chunks.push(e.data); };
    rec.onstop = clipDone;
    rec.start(1000);
    clipLabel('● REC 0s', 'on');
    clip.timer = setInterval(() => {
      const ms = Date.now() - clip.t0;
      clipLabel(`● REC ${Math.floor(ms / 1000)}s`, 'on');
      if (ms >= CLIP_MAX) clipStop(false);
    }, 250);
    toast('RECORDING · TAP ● REC TO STOP (MAX 30 s)', 3000);
    report('clip', 'start ' + (mime || 'default'));
    refocusGame();
  }
  function clipStop(user) {
    clearInterval(clip.timer);
    clip.userStop = user;
    if (clip.rec && clip.rec.state !== 'inactive') clip.rec.stop();
  }
  function clipDone() {
    if (clip.unhook) { clip.unhook(); clip.unhook = null; }
    for (const t of clip.stream.getTracks()) { try { t.stop(); } catch {} }
    const type = (clip.rec.mimeType || 'video/webm').split(';')[0];
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(clip.chunks, { type });
    const id = (runningGame && runningGame.id) || (vs.game && vs.game.id) || 'clip';
    clip.file = new File([blob], `psx-${id}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type });
    clip.rec = null; clip.chunks = [];
    report('clip', { kb: Math.round(blob.size / 1024), ext });
    if (clip.userStop) clipDeliver();
    else { clipLabel('💾 SAVE CLIP', 'ready'); toast('CLIP READY · TAP 💾 SAVE CLIP', 4000); }
  }
  async function clipDeliver() {
    const file = clip.file;
    if (!file) return;
    clip.file = null;
    clipLabel('🎬 CLIP');
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'PSX clip' }); report('clip', 'shared'); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    report('clip', 'download');
    toast(file.name.endsWith('.webm') ? 'CLIP SAVED (.WEBM) · X WANTS MP4: CONVERT IT FIRST' : 'CLIP SAVED', 4000);
  }
  clip.btn.addEventListener('click', () => {
    if (clip.file) return clipDeliver();
    if (clip.rec) return clipStop(true);
    clipStart();
  });

  // ---------- ↩ UNDO: annulla l'ultima scelta (personaggio, pista, modalità…) ----------
  // Tekken 3 e CTR non permettono di cambiare personaggio dopo averlo confermato (era così anche sulla PS1): prima
  // bisognava riavviare. Ora chi fa girare il gioco (giocatore 1, o chi gioca da solo) salva la partita in memoria
  // un attimo PRIMA di ogni tasto di conferma (✕ ○ □ △ START, di chiunque: tocco, joypad, tastiera, giocatore 2);
  // UNDO ricarica l'ultima di queste fotografie = la schermata di prima, col cursore dov'era. Ogni UNDO toglie un passo.
  // Comandi: tasto ↩ UNDO sul controller a schermo, clic di una levetta (L3/R3) sul joypad, Backspace. Il giocatore 2
  // lo chiede al giocatore 1 sul canale dei tasti (mandato 3 volte: quel canale può perdere pacchetti).
  // Costo: una fotografia ~4,5 MB; al massimo una ogni 0,6 s sul PC e ogni 2,5 s sui telefoni (meno scatti).
  const UNDO_KEYS = new Set([0, 1, 3, 8, 9]); // ✕ □ START ○ △
  const undoStack = [];
  let lastSnap = 0, lastUndoId = 0;
  function hookUndo(E) {
    const gm = E && E.gameManager;
    if (!gm || gm.tsUndo) return;
    gm.tsUndo = true;
    const orig = gm.simulateInput.bind(gm);
    gm.simulateInput = (player, id, value) => {
      if (value === 1 && UNDO_KEYS.has(id) && vs.role !== 'guest' && vs.role !== 'watcher') {
        const now = Date.now();
        if (now - lastSnap > (isPhone() ? 2500 : 600)) {
          lastSnap = now;
          try { undoStack.push(gm.getState()); if (undoStack.length > 8) undoStack.shift(); } catch {}
        }
      }
      return orig(player, id, value);
    };
  }
  function undoChoice(who = '', id = Date.now()) {
    if (id === lastUndoId) return; // stessa richiesta arrivata più volte
    lastUndoId = id;
    const E = window.EJS_emulator;
    const st = undoStack.pop();
    if (!E || !st) return toast('NOTHING TO UNDO');
    try { E.gameManager.loadState(st); } catch { return toast('CANNOT UNDO HERE'); }
    lastSnap = Date.now(); // il tasto appena premuto dopo l'UNDO non deve fotografare subito
    toast(who ? `${who}: UNDO` : 'UNDO · CHOOSE AGAIN', 1800);
    report('undo', { who: who || 'self', left: undoStack.length });
  }
  function askUndo() {
    if (current !== 'game') return;
    if (vs.role === 'watcher') return;
    if (vs.role === 'guest') {
      if (!vs.dc || vs.dc.readyState !== 'open') return toast('NOT CONNECTED');
      const id = Date.now();
      for (const ms of [0, 150, 300]) setTimeout(() => { try { vs.dc.send(JSON.stringify({ rewind: id })); } catch {} }, ms);
      toast('UNDO…', 1200);
      return;
    }
    undoChoice();
  }
  $('#pad-undo').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); askUndo(); });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || current !== 'game' || e.repeat) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!vs.panel.hidden || !card.panel.hidden) return;
    e.preventDefault(); askUndo();
  }, true);
  // clic delle levette (L3 = tasto 10, R3 = 11 nella mappa standard): non li usa nessun gioco PS1 digitale
  const stickClick = {};
  setInterval(() => {
    if (current !== 'game') return;
    for (const p of padConnected()) {
      const on = !!((p.buttons[10] && p.buttons[10].pressed) || (p.buttons[11] && p.buttons[11].pressed));
      if (on && !stickClick[p.index]) askUndo();
      stickClick[p.index] = on;
    }
  }, 30);

  // ---------- 🔊/🔇 audio acceso/spento ----------
  // Tra l'uscita del core (AL.currentCtx.gain, verificato nel core JS) e gli altoparlanti si mette un nostro volume:
  // 0 = muto. NON si stacca e NON si sospende: un audio non collegato agli altoparlanti non viene più "fatto scorrere"
  // e il core, che aspetta l'audio, si ferma (provato 2026-10-09: 0 fotogrammi al secondo). L'audio mandato al
  // giocatore 2 e quello delle clip partono prima del nostro volume, quindi restano. Il giocatore 2 spegne il suo
  // elemento <audio>. Ricordato sul dispositivo.
  function applySound() {
    const b = $('#btn-mute');
    b.textContent = soundOff ? '🔇 MUTED' : '🔊 SOUND';
    b.classList.toggle('on', soundOff);
    vsAudio.muted = soundOff;
    try {
      const ctx = window.EJS_emulator.Module.AL.currentCtx;
      if (!ctx.tsOut) {
        ctx.tsOut = ctx.audioCtx.createGain();
        ctx.gain.disconnect(ctx.audioCtx.destination);
        ctx.gain.connect(ctx.tsOut);
        ctx.tsOut.connect(ctx.audioCtx.destination);
      }
      ctx.tsOut.gain.value = soundOff ? 0 : 1;
    } catch {}
  }
  $('#btn-mute').addEventListener('click', () => {
    soundOff = !soundOff;
    try { localStorage.setItem('ts-muted', soundOff ? '1' : '0'); } catch {}
    applySound();
    toast(soundOff ? 'SOUND OFF' : 'SOUND ON', 1500);
    report('sound', soundOff ? 'off' : 'on');
    refocusGame();
  });
  applySound();

  // ---------- video del giocatore 1 a tutto schermo per giocatore 2 e spettatori ----------
  // Il video è lo schermo intero dell'emulatore del giocatore 1: su un PC con finestra larga contiene grandi bande
  // nere ai lati e il gioco usciva piccolo al centro del telefono. La PS1 è sempre 4:3 al centro di quello schermo:
  // si ingrandisce il video in modo che sia quel rettangolo 4:3 a riempire lo spazio, le bande escono dai bordi.
  function fitVsVideo() {
    const v = vs.video, wrap = $('#game-wrap');
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh || v.hidden) return;
    const cw = vw / vh > 4 / 3 ? vh * 4 / 3 : vw, ch = vw / vh > 4 / 3 ? vh : vw * 3 / 4; // rettangolo del gioco
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const s = Math.min(W / cw, H / ch);
    Object.assign(v.style, { inset: 'auto', width: `${vw * s}px`, height: `${vh * s}px`,
      left: `${(W - vw * s) / 2}px`, top: `${(H - vh * s) / 2}px`, objectFit: 'fill' });
  }
  vs.video.addEventListener('resize', fitVsVideo);
  vs.video.addEventListener('loadedmetadata', fitVsVideo);
  addEventListener('resize', fitVsVideo);
  $('#menu-vs').addEventListener('click', openVs);
  $('#vs-close').addEventListener('click', () => { vs.panel.hidden = true; refocusGame(); });
  vs.leave.addEventListener('click', () => { endVersus(''); vsStatus('You left the lobby.'); });

  // Streaming: invece di scaricare tutto il disco prima di partire, il file viene montato come "lazy file"
  // di Emscripten: ogni lettura del core scarica solo il pezzo che serve (HTTP Range, server con 206).
  // Si sostituisce downloadRom di EmulatorJS quando il bundle registra la classe EmulatorJS.
  let streamTarget = null; // { name, url, bytes }
  const bootTimes = { t0: 0 }; // tempi dell'avvio in ms dal tocco (registro)
  // FS.createLazyFile di Emscripten rifiuta l'XHR sincrono binario sul thread principale. Qui si usa XHR sincrono
  // testuale (charset x-user-defined: ogni byte arriva come un carattere), che il browser permette.
  // Pezzi da 512 KB: quando il gioco ne chiede uno che manca, tutto si ferma finché arriva; pezzi piccoli = attese brevi.
  // Dal post su X i pezzi passano dalla connessione di casa (tunnel): la lettura anticipata è leggera (max 2 download
  // insieme) e si ferma quando serve un pezzo urgente, così la banda va a quello.
  const CHUNK = 512 * 1024;
  const CACHE_BYTES = 96 * 1024 * 1024, CACHE_BYTES_PHONE = 48 * 1024 * 1024;
  const AHEAD = 4, AHEAD_PARALLEL = 2;
  const streamStats = { chunks: 0, bytes: 0, ms: 0, ahead: 0, aborted: 0 };
  window.TS_STREAM_STATS = streamStats;
  const streamReads = new Set(); // indici dei pezzi letti dal gioco
  window.TS_STREAM_READS = streamReads;
  let warmJob = null; // { target, promise, n, t, el }
  function startWarm(target) {
    const job = { target, n: 0, t: 1, el: null, t0: performance.now() };
    job.promise = warmStream(target, (n, t) => {
      job.n = n; job.t = t;
      if (job.el) job.el.innerText = `Loading disc ${Math.round((n / t) * 100)}%`;
    }).then((w) => { job.ms = Math.round(performance.now() - job.t0); return w; });
    warmJob = job;
    return job;
  }
  // Prima di avviare si scarica solo quello che il core legge subito (misurato 2026-10-09 su tutti e 6 i giochi):
  // l'intestazione del CHD (pezzo 0), i primi settori del disco (pezzi 1-2) e l'indice dei blocchi ("map"), che
  // chdman scrive in fondo al file. Prima si scaricavano i primi 6 MB: 10 pezzi su 12 non servivano all'avvio.
  const WARM_HEAD = 3, MAP_MAX = 256 * 1024;
  async function warmStream({ url, bytes }, onProgress) {
    const warm = new Map();
    const total = Math.ceil(bytes / CHUNK);
    const want = new Set();
    let done = 0;
    const get = (i) => {
      want.add(i);
      const from = i * CHUNK, to = Math.min(bytes, from + CHUNK) - 1;
      return fetch(url, { headers: { Range: `bytes=${from}-${to}` } })
        .then((r) => (r.status === 206 ? r.arrayBuffer() : null))
        .then((buf) => { if (buf) warm.set(i, new Uint8Array(buf)); })
        .catch(() => {})
        .finally(() => onProgress(++done, want.size));
    };
    const first = get(0);
    const jobs = [];
    for (let i = 1; i < Math.min(WARM_HEAD, total); i++) jobs.push(get(i));
    await first;
    // CHD v5: "MComprHD", versione a 12, offset dell'indice (64 bit big-endian) a 40
    const c0 = warm.get(0);
    if (c0 && c0.length >= 64 && String.fromCharCode(...c0.subarray(0, 8)) === 'MComprHD') {
      const dv = new DataView(c0.buffer, c0.byteOffset, c0.byteLength);
      if (dv.getUint32(12) === 5) {
        const mapOff = Number(dv.getBigUint64(40));
        const last = Math.floor(Math.min(bytes - 1, mapOff + MAP_MAX) / CHUNK);
        for (let i = Math.max(WARM_HEAD, Math.floor(mapOff / CHUNK)); i <= last && i < total; i++) jobs.push(get(i));
      }
    }
    await Promise.all(jobs);
    return warm;
  }
  // ogni 30 s: quante volte il gioco ha aspettato un pezzo e per quanto (per capire i "lag" dal registro)
  let lastStreamReport = { chunks: 0, ms: 0 };
  setInterval(() => {
    if (!started || streamStats.chunks === lastStreamReport.chunks) return;
    report('stream', { waits: streamStats.chunks - lastStreamReport.chunks, waitMs: Math.round(streamStats.ms - lastStreamReport.ms), ahead: streamStats.ahead, aborted: streamStats.aborted });
    lastStreamReport = { chunks: streamStats.chunks, ms: streamStats.ms };
  }, 30000);

  function mountStreamFile(FS, { name, url, bytes }, warm = new Map()) {
    const cache = new Map(warm);
    const inflight = new Map(); // pezzo → AbortController del download anticipato
    const phone = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
    const maxChunks = Math.floor((phone ? CACHE_BYTES_PHONE : CACHE_BYTES) / CHUNK);
    const total = Math.ceil(bytes / CHUNK);
    const store = (i, c) => {
      cache.set(i, c);
      while (cache.size > maxChunks) cache.delete(cache.keys().next().value);
    };
    let queue = [];
    const pump = () => {
      while (inflight.size < AHEAD_PARALLEL && queue.length) {
        const k = queue.shift();
        if (cache.has(k) || inflight.has(k)) continue;
        const ctl = new AbortController();
        inflight.set(k, ctl);
        const from = k * CHUNK, to = Math.min(bytes, from + CHUNK) - 1;
        fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal: ctl.signal })
          .then((r) => (r.status === 206 ? r.arrayBuffer() : null))
          .then((b) => { if (b) { streamStats.ahead++; store(k, new Uint8Array(b)); } })
          .catch(() => {})
          .finally(() => { inflight.delete(k); pump(); });
      }
    };
    // lettura anticipata: i pezzi dopo i, in ordine; quelli vecchi in coda vengono sostituiti
    const prefetch = (i) => {
      queue = [];
      for (let k = i + 1; k <= i + AHEAD && k < total; k++) if (!cache.has(k) && !inflight.has(k)) queue.push(k);
      pump();
    };
    const getChunk = (i) => {
      streamReads.add(i);
      let c = cache.get(i);
      if (c) { cache.delete(i); cache.set(i, c); prefetch(i); return c; } // in fondo = usato di recente
      // pezzo urgente: si fermano i download anticipati (stesso pezzo compreso) per lasciargli tutta la banda
      queue = [];
      for (const ctl of inflight.values()) { try { ctl.abort(); streamStats.aborted++; } catch {} }
      inflight.clear();
      const from = i * CHUNK, to = Math.min(bytes, from + CHUNK) - 1;
      const t0 = performance.now();
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.setRequestHeader('Range', `bytes=${from}-${to}`);
      xhr.overrideMimeType('text/plain; charset=x-user-defined');
      xhr.send(null);
      if (xhr.status !== 206 && xhr.status !== 200) throw new Error('stream: HTTP ' + xhr.status);
      let s = xhr.responseText;
      if (xhr.status === 200) s = s.slice(from, to + 1); // server senza Range: tutto il file (lento ma corretto)
      c = new Uint8Array(s.length);
      for (let k = 0; k < s.length; k++) c[k] = s.charCodeAt(k) & 0xff;
      streamStats.chunks++; streamStats.bytes += c.length; streamStats.ms += performance.now() - t0;
      store(i, c);
      prefetch(i);
      return c;
    };
    const node = FS.createFile('/', name, {}, true, false);
    Object.defineProperty(node, 'usedBytes', { get: () => bytes });
    node.contents = null;
    const base = node.stream_ops;
    node.stream_ops = {
      ...base,
      read(stream, buffer, offset, length, position) {
        if (position >= bytes) return 0;
        const end = Math.min(bytes, position + length);
        let done = 0;
        while (position + done < end) {
          const p = position + done, ci = Math.floor(p / CHUNK), co = p - ci * CHUNK;
          const c = getChunk(ci), n = Math.min(c.length - co, end - p);
          buffer.set(c.subarray(co, co + n), offset + done);
          done += n;
        }
        return done;
      },
      write() { throw new FS.ErrnoError(63); },
    };
  }
  function patchEmulatorJS() {
    let cls;
    Object.defineProperty(window, 'EmulatorJS', {
      configurable: true,
      get: () => cls,
      set: (v) => {
        cls = v;
        const errOrig = v && v.prototype && v.prototype.startGameError;
        if (errOrig && !errOrig.tsPatched) {
          v.prototype.startGameError = function (msg) { report('ejs-error', String(msg)); return errOrig.apply(this, arguments); };
          v.prototype.startGameError.tsPatched = true;
        }
        const orig = v && v.prototype && v.prototype.downloadRom;
        if (!orig || orig.tsPatched) return;
        v.prototype.downloadRom = async function () {
          if (!streamTarget) return orig.call(this);
          const job = warmJob && warmJob.target.url === streamTarget.url ? warmJob : startWarm(streamTarget);
          job.el = this.textElem;
          bootTimes.romAsked = Math.round(performance.now() - bootTimes.t0);
          const warm = await job.promise;
          bootTimes.warmMs = job.ms;
          bootTimes.romReady = Math.round(performance.now() - bootTimes.t0);
          mountStreamFile(this.gameManager.FS, streamTarget, warm);
          this.fileName = streamTarget.name;
        };
        v.prototype.downloadRom.tsPatched = true;
      },
    });
  }

  // Telefoni: solo il dithering spento (effetto grafico che costa e si nota poco).
  // Il frameskip auto e l'audio semplificato sono stati tolti: su iPhone l'audio andava a scatti (2026-10-09).
  const isPhone = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // + salto del DISEGNO solo nei picchi: "auto_threshold" salta un fotogramma solo quando il buffer audio scende sotto
  //   la soglia (33%), cioè quando il telefono sta per restare indietro. La partita e l'audio non rallentano.
  //   (Il frameskip "auto" del 2026-10-09 rovinava l'audio perché il gioco girava a 30 Hz; ora gira a 60.)
  const PHONE_CORE_OPTIONS = {
    pcsx_rearmed_dithering: 'disabled',
    pcsx_rearmed_frameskip_type: 'auto_threshold',
    pcsx_rearmed_frameskip_threshold: '33',
  };

  // iPhone in "Risparmio energetico" (e alcuni iframe) limita requestAnimationFrame a 30 al secondo: l'emulatore,
  // che avanza di un fotogramma per battito, va a metà velocità (registro: 30 fps fissi). Il main loop di Emscripten
  // chiede ogni battito alla funzione globale requestAnimationFrame (verificato nel core JS): se la pagina batte sotto
  // i 45 Hz la si sostituisce con un orologio a 60 Hz basato su timer, che esegue tutte le richieste a ogni battito
  // come fa il browser. Lo schermo resta a 30 Hz, ma gioco e audio tornano a velocità normale.
  let rafPatched = false;
  const clockLoad = { on: false, ms: 0, n: 0 }; // ms di lavoro del core per battito (solo con l'orologio a 60 Hz)
  function takeClockLoad() { const v = clockLoad.n ? +(clockLoad.ms / clockLoad.n).toFixed(1) : null; clockLoad.ms = 0; clockLoad.n = 0; return v; }
  function install60HzClock() {
    if (rafPatched) return;
    rafPatched = true;
    let queue = new Map(), nextId = 1, next = performance.now();
    const STEP = 1000 / 60;
    clockLoad.on = true;
    // i timer arrivano sempre un po' in ritardo (~18 ms invece di 16,7): timer fino a 3 ms dalla scadenza,
    // poi MessageChannel (immediato) per l'ultimo tratto
    const mc = new MessageChannel();
    // In ritardo (fotogramma più lungo di 16,7 ms, telefono lento): MAI il battito successivo nella stessa chiamata.
    // Prima qui c'era tick() diretto: battiti uno dopo l'altro senza mai lasciare il turno al browser → timer,
    // tocchi e audio fermi e pagina bloccata (trovato 2026-10-09 simulando un telefono lento). Ora si cede sempre il
    // turno (MessageChannel: subito dopo gli eventi in attesa).
    let due = false;
    mc.port1.onmessage = () => { if (due) { due = false; tick(); } else wait(); };
    const wait = () => {
      const left = next - performance.now();
      if (left > 3) setTimeout(wait, left - 3);
      else { due = left <= 0; mc.port2.postMessage(0); }
    };
    const tick = () => {
      const now = performance.now();
      const run = queue; queue = new Map();
      for (const cb of run.values()) { try { cb(now); } catch (e) { setTimeout(() => { throw e; }); } }
      if (run.size) { clockLoad.ms += performance.now() - now; clockLoad.n++; }
      next += STEP;
      if (next < now - STEP) next = now; // se si è rimasti indietro non si recupera di colpo
      wait();
    };
    window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id; };
    window.cancelAnimationFrame = (id) => { queue.delete(id); };
    setTimeout(tick, 0);
  }
  // La velocità della pagina si misura PRIMA di avviare l'emulatore (all'accensione e nel menu): se è limitata,
  // l'orologio a 60 Hz si installa prima che il ciclo del core parta. Installarlo a gioco avviato (con pausa e
  // ripresa del ciclo) mandava in crash il core su iPhone (registro 2026-10-09: Crash e Spyro).
  let pageHz = null;
  function measurePageHz(ms = 900) {
    return new Promise((resolve) => {
      if (document.hidden) return resolve(null);
      let ticks = 0;
      const t0 = performance.now();
      const tick = () => {
        ticks++;
        if (performance.now() - t0 < ms) return requestAnimationFrame(tick);
        resolve(Math.round((ticks * 1000) / (performance.now() - t0)));
      };
      requestAnimationFrame(tick);
    });
  }
  function checkPageHz() {
    measurePageHz().then((hz) => { if (hz != null) { pageHz = hz; report('page-hz', hz); } });
  }
  // Telefoni lenti (es. iPhone in Risparmio energetico, che rallenta anche il processore): se dopo l'avvio il gioco
  // non arriva a 50 fps, il core salta il DISEGNO di alcuni fotogrammi (la partita, i tasti e l'audio restano a 60).
  // Opzioni lette dal core in esecuzione: frameskip_type fixed_interval, frameskip_interval 1..10. Si cambia con
  // setVariable a gioco avviato, senza fermare il ciclo del core.
  const emuFps = (ms) => new Promise((resolve) => {
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return resolve(null);
    const a = gm.getFrameNum(), t0 = performance.now();
    setTimeout(() => resolve(Math.round(((gm.getFrameNum() - a) * 1000) / (performance.now() - t0))), ms);
  });
  async function adaptPhoneSpeed() {
    if (!isPhone() || document.hidden) return;
    const gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    let fps = await emuFps(2000);
    if (!isIOS()) return adaptOtherPhone(gm, fps);
    const steps = [['1', 50], ['2', 45]];
    for (const [interval, below] of steps) {
      if (fps == null || fps >= below) break;
      try {
        gm.setVariable('pcsx_rearmed_frameskip_type', 'fixed_interval');
        gm.setVariable('pcsx_rearmed_frameskip_interval', interval);
      } catch { break; }
      await new Promise((r) => setTimeout(r, 3000));
      const after = await emuFps(2000);
      report('perf-adapt', { before: fps, interval, after });
      fps = after;
    }
  }

  // Android e altri telefoni (non iPhone): il registro dell'Honor CRT-LX1 dava 19 fps in Tekken 3. Il peso è la CPU
  // della PS1 emulata, non il disegno (misurato 2026-10-09: saltare fotogrammi non cambia i ms per fotogramma,
  // psxclock 45 li riduce del 19%, 40 del ~27%). Gradini: si scende finché il gioco non torna a velocità piena.
  // psxclock più basso = alcuni giochi possono rallentare nelle scene pesanti, ma suono e comandi restano giusti
  // (meglio che tutto il gioco al rallentatore).
  const OTHER_PHONE_STEPS = [
    { below: 57, interval: '1', clock: '50' },
    { below: 55, interval: '2', clock: '45' },
    { below: 53, interval: '3', clock: '40' },
    { below: 50, interval: '4', clock: '35' },
  ];
  async function adaptOtherPhone(gm, fps) {
    report('perf-adapt', { start: fps, busyMs: takeClockLoad() });
    for (const s of OTHER_PHONE_STEPS) {
      if (fps == null || fps >= s.below) break;
      try {
        gm.setVariable('pcsx_rearmed_frameskip_type', 'fixed_interval');
        gm.setVariable('pcsx_rearmed_frameskip_interval', s.interval);
        gm.setVariable('pcsx_rearmed_psxclock', s.clock);
      } catch { break; }
      await new Promise((r) => setTimeout(r, 2500));
      takeClockLoad();
      const after = await emuFps(2000);
      report('perf-adapt', { before: fps, interval: s.interval, clock: s.clock, after, busyMs: takeClockLoad() });
      fps = after;
    }
  }

  // ---------- audio su iPhone: senza audio attivo il gioco si ferma ----------
  // Il core aspetta che l'audio "consumi" i suoni prima di andare avanti: con l'audio sospeso il gioco scende a
  // ~1 fotogramma al secondo (verificato 2026-10-09: 61 fps → 1 fps sospendendo l'audio, 59 riprendendolo).
  // Su iPhone l'audio nasce sospeso se il gioco parte qualche secondo dopo il tocco, e il core prova a riattivarlo
  // solo al PRIMO tocco: se quel tentativo non vale, resta fermo per sempre. Qui: si riprova a ogni tocco/tasto e,
  // se l'audio è ancora fermo, si chiede un tocco a tutto schermo (TAP TO START), che iOS accetta sempre.
  const audioCtxs = new Set();
  for (const k of ['AudioContext', 'webkitAudioContext']) {
    const C = window[k];
    if (!C || C.tsTracked) continue;
    try {
      const T = class extends C { constructor(...a) { super(...a); audioCtxs.add(this); } };
      T.tsTracked = true;
      window[k] = T;
    } catch {}
  }
  function emuAudio() {
    try { const c = window.EJS_emulator.Module.AL.currentCtx.audioCtx; if (c) { audioCtxs.add(c); return c; } } catch {}
    return null;
  }
  function wakeAudio() {
    emuAudio();
    for (const c of audioCtxs) if (c.state !== 'running' && c.state !== 'closed') { try { c.resume().catch(() => {}); } catch {} }
  }
  for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) addEventListener(ev, wakeAudio, true);
  let audioWatch = null;
  function watchAudio() {
    if (audioWatch) return;
    const tap = document.createElement('button');
    tap.type = 'button'; tap.id = 'tap-start'; tap.className = 'tap-start'; tap.hidden = true;
    tap.innerHTML = '<span>▶</span>TAP TO START';
    document.body.appendChild(tap);
    const go = (e) => { e.preventDefault(); wakeAudio(); tap.hidden = true; refocusGame(); report('audio', 'tap'); };
    tap.addEventListener('click', go);
    tap.addEventListener('touchend', go);
    let since = 0, reported = false;
    audioWatch = setInterval(() => {
      const c = emuAudio();
      const stuck = c && c.state !== 'running' && c.state !== 'closed' && vs.role !== 'guest';
      if (!stuck) { since = 0; tap.hidden = true; return; }
      wakeAudio();
      if (!since) since = performance.now();
      if (performance.now() - since > 900 && tap.hidden) {
        tap.hidden = false;
        if (!reported) { reported = true; report('audio', 'stuck:' + c.state); }
      }
    }, 300);
  }

  function clockBeforeStart() {
    const force = new URLSearchParams(location.search).has('clock60'); // prova: forza l'orologio a 60 Hz
    if (rafPatched) return;
    const android = isPhone() && !isIOS();
    if (force || android || (pageHz != null && pageHz < 45)) {
      install60HzClock();
      report('perf-fix', { pageHz, forced: force, android, clock: '60hz-timer' });
    }
  }

  let runningGame = null;
  function startGame({ gameUrl, externalFiles, name, id, stream }) {
    if (started) return;
    started = true;
    runningGame = { id, name };
    show('game');
    Object.assign(window, {
      EJS_player: '#game',
      EJS_core: 'psx',
      EJS_pathtodata: EJS_DATA,
      EJS_gameUrl: gameUrl,
      EJS_externalFiles: externalFiles && Object.keys(externalFiles).length ? externalFiles : undefined,
      EJS_gameName: name,
      EJS_gameID: id,
      EJS_threads: false, // multi-core provato 2026-10-09: nessun guadagno (il peso è la CPU della PS1, non il disegno)
      EJS_startOnLoaded: true,
      EJS_color: '#2f7cf6',
      EJS_backgroundColor: '#000000',
      EJS_language: 'en-US',
      EJS_defaultOptions: { 'save-state-location': 'browser', 'virtual-gamepad': 'disabled', ...(isPhone() ? PHONE_CORE_OPTIONS : {}) },
      EJS_DEBUG: new URLSearchParams(location.search).has('debug'),
      // Niente import/export di file dal menu dell'emulatore (decisione del 2026-10-09)
      EJS_Buttons: { saveSavFiles: false, loadSavFiles: false, cacheManager: false, cheat: false, netplay: false },
      EJS_onGameStart: () => {
        bootTimes.started = Math.round(performance.now() - bootTimes.t0);
        report('game-started', { id, stats: streamStats, audio: (emuAudio() || {}).state, boot: bootTimes, reads: streamReads.size, maxRead: Math.max(-1, ...streamReads) });
        // pezzi di disco letti nei primi 20 s (per tarare quanto scaricare prima di partire)
        setTimeout(() => report('boot-reads', { n: streamReads.size, max: Math.max(-1, ...streamReads), first: [...streamReads].slice(0, 40) }), 20000);
        watchAudio();
        // VERSUS: se nel frattempo siamo diventati giocatore 2, il nostro emulatore resta fermo (si gioca sul video)
        if (vs.role === 'guest') { try { window.EJS_emulator.pause ? window.EJS_emulator.pause(true) : window.EJS_emulator.gameManager.toggleMainLoop(0); } catch {} }
        setTimeout(adaptPhoneSpeed, 6000);
        if (isPhone() && pageHz != null && pageHz < 45) setTimeout(() => toast('BATTERY SAVER ON · TURN IT OFF FOR FULL SPEED', 5000), 2500);
        setTimeout(reportPerf, 16000);
        stripEmulatorMenus();
        // le impostazioni del core restano salvate nel browser (anche quelle vecchie): si riapplicano sempre quelle giuste
        try {
          const want = isPhone() ? { ...PHONE_CORE_OPTIONS } : { pcsx_rearmed_frameskip_type: 'disabled' };
          // Android: ogni gioco riparte con la CPU emulata normale (i gradini restano salvati nel browser)
          if (isPhone() && !isIOS()) want.pcsx_rearmed_psxclock = 'auto';
          for (const [k, v] of Object.entries(want)) window.EJS_emulator.gameManager.setVariable(k, v);
        } catch {}
        // il gamepad virtuale di EmulatorJS resta spento: usiamo il nostro
        try { window.EJS_emulator.toggleVirtualGamepad(false); } catch {}
        refocusGame();
        if (padConnected().length) document.body.classList.add('pad-off');
        if (!matchMedia('(pointer: coarse)').matches) toast('KEYBOARD: ARROWS · X ✕ · Z ○ · S □ · A △ · ENTER START', 4500);
        applySound(); // audio spento col pulsante 🔇: vale anche appena il gioco parte
        hookUndo(window.EJS_emulator); // ↩ UNDO: fotografia prima di ogni tasto di conferma
      },
    });
    report('start', { id, stream: !!stream });
    clockBeforeStart();
    patchGameManager();
    streamTarget = stream || null;
    bootTimes.t0 = performance.now();
    if (streamTarget && !(warmJob && warmJob.target.url === streamTarget.url)) startWarm(streamTarget); // già avviato dal menu?
    patchEmulatorJS();
    const s = document.createElement('script');
    s.src = EJS_DATA + 'loader.js';
    s.onerror = () => { report('ejs-cdn-fail', EJS_DATA); toast('EMULATOR UNREACHABLE', 5000); };
    document.body.appendChild(s);
  }
  $('#btn-back').addEventListener('click', back);

  // ↺ RESET: come il tasto RESET della PS1, riavvia il disco → logo, titolo e menu del gioco (Arcade, VS Mode…).
  // Vale per ogni gioco. Doppio tocco per evitare reset per sbaglio; in VERSUS lo può fare solo il giocatore 1.
  let resetArmed = 0;
  $('#btn-reset').addEventListener('click', () => {
    const E = window.EJS_emulator;
    if (vs.role === 'guest') return toast('ONLY PLAYER 1 CAN RESET');
    if (!E || !E.started) return;
    if (Date.now() - resetArmed > 3000) { resetArmed = Date.now(); return toast('TAP RESET AGAIN TO GO BACK TO THE TITLE', 3000); }
    resetArmed = 0;
    try { E.gameManager.restart(); toast('RESET · BACK TO THE TITLE'); report('reset', runningGame && runningGame.id); } catch {}
    refocusGame();
  });

  // ---------- memory card online (cards.mjs): codice di 12 cifre + PIN personale, da qualsiasi dispositivo ----------
  // Il codice lo genera il server (casuale, mai doppio); il PIN (4-8 cifre) lo sceglie il giocatore. Tutto col
  // tastierino a cifre: dentro X su iPhone i campi di testo sfasavano cursore e tocchi. Il dispositivo ricorda codice e
  // PIN (SAVE/LOAD a un tocco); su un altro dispositivo: I HAVE A CODE → codice → PIN. Card di prima del PIN: al primo
  // uso si sceglie il PIN (il server lo imposta e da lì lo pretende).
  const card = { panel: $('#card'), info: $('#card-info'), code: '', pin: '', entry: '', mode: 'code', pendingCode: '', afterPin: null, busy: false };
  try { card.code = localStorage.getItem('ts-card') || ''; card.pin = localStorage.getItem('ts-card-pin') || ''; } catch {}
  const PIN_OK = (p) => /^\d{4,8}$/.test(p);
  const prettyCode = (c) => c.replace(/(\d{4})(?=\d)/g, '$1-');
  function remember() {
    try {
      if (card.code) localStorage.setItem('ts-card', card.code); else localStorage.removeItem('ts-card');
      if (card.pin) localStorage.setItem('ts-card-pin', card.pin); else localStorage.removeItem('ts-card-pin');
    } catch {}
  }
  function cardInfo(t, err = false) { card.info.className = 'vs-status' + (err ? ' err' : ''); card.info.textContent = t; }
  function cardUi(entering = false) {
    $('#card-code').textContent = card.code ? prettyCode(card.code) : 'NO CARD YET';
    $('#card-main').hidden = entering;
    $('#card-enter').hidden = !entering;
    $('#card-save').hidden = !card.code; $('#card-load').hidden = !card.code;
    $('#card-new').textContent = card.code ? 'NEW CARD' : 'NEW CARD + SAVE';
    for (const b of card.panel.querySelectorAll('button')) b.disabled = card.busy && b.id !== 'card-close';
  }
  const ENTRY = {
    code: { label: 'CARD CODE · 12 DIGITS', max: 12, go: 'NEXT' },
    pin: { label: 'PIN OF THIS CARD · 4-8 DIGITS', max: 8, go: 'USE THIS CARD' },
    newpin: { label: 'CHOOSE YOUR PIN · 4-8 DIGITS', max: 8, go: 'OK' },
  };
  function openEntry(mode, info, afterPin = null) {
    card.mode = mode; card.entry = ''; card.afterPin = afterPin;
    cardUi(true); renderCardEntry(); cardInfo(info);
  }
  function renderCardEntry() {
    const m = ENTRY[card.mode], box = $('#card-slots');
    $('#card-enter .pin-label').textContent = m.label;
    $('#card-use').textContent = m.go;
    box.innerHTML = '';
    const n = card.mode === 'code' ? 12 : Math.max(4, Math.min(8, card.entry.length + 1));
    for (let i = 0; i < n; i++) {
      if (card.mode === 'code' && i && i % 4 === 0) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '-'; box.appendChild(sep); }
      const d = document.createElement('span');
      d.className = 'pin-slot' + (i < card.entry.length ? ' on' : '') + (i === card.entry.length ? ' cur' : '');
      d.textContent = i < card.entry.length ? (card.mode === 'code' ? card.entry[i] : '•') : ''; // il PIN non si mostra
      box.appendChild(d);
    }
    $('#card-use').disabled = card.mode === 'code' ? card.entry.length !== 12 : !PIN_OK(card.entry);
  }
  function cardKey(k) {
    if ($('#card-enter').hidden) return;
    if (/^\d$/.test(k) && card.entry.length < ENTRY[card.mode].max) card.entry += k;
    else if (k === 'del') card.entry = card.entry.slice(0, -1);
    else if (k === 'clr') card.entry = '';
    else return;
    blip(k === 'del' || k === 'clr' ? 300 : 700, 0.04);
    renderCardEntry();
  }
  async function cardApi(method, path, body, code = card.code, pin = card.pin) {
    const r = await fetch(path, { method, body, headers: { 'x-card': code, 'x-card-pin': pin } });
    if (!r.ok) {
      let e = {}; try { e = await r.json(); } catch {}
      const err = new Error(e.error || `HTTP ${r.status}`);
      err.needPin = r.status === 428; err.status = r.status;
      throw err;
    }
    return r;
  }
  const gameReady = () => {
    const E = window.EJS_emulator;
    if (vs.role === 'guest' || vs.role === 'watcher') { cardInfo('In VERSUS the game runs on player 1\'s device.', true); return null; }
    if (!E || !E.started || !runningGame) { cardInfo('Start a game first.', true); return null; }
    return E;
  };
  // prima di SAVE/LOAD: serve una card con PIN (nuova → si sceglie il PIN; vecchia senza PIN → si sceglie ora)
  function needPinFirst(then) {
    if (!card.code) { openEntry('newpin', 'Choose a PIN for your new card.\nYou will need it (with the code) on other devices.', async (pin) => { if (await createCard(pin)) then(); }); return true; }
    if (!card.pin) { openEntry('newpin', 'Protect your card: choose a PIN.\nYou will need it (with the code) on other devices.', (pin) => { card.pin = pin; remember(); then(); }); return true; }
    return false;
  }
  async function createCard(pin) {
    try {
      const r = await fetch('/api/card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      const j = await r.json();
      if (!r.ok || !j.code) throw new Error(j.error || 'Could not create a card.');
      card.code = j.code; card.pin = pin; remember();
      report('card', 'new');
      return true;
    } catch (e) { cardUi(false); cardInfo(String(e.message || e), true); return false; }
  }
  async function cardSave() {
    const E = gameReady(); if (!E || card.busy) return;
    if (needPinFirst(cardSave)) return;
    card.busy = true; cardUi(); cardInfo('Saving…');
    try {
      const state = E.gameManager.getState();
      await cardApi('PUT', `/api/card/${runningGame.id}/state`, state);
      let srm = null; try { srm = E.gameManager.getSaveFile(); } catch {}
      if (srm && srm.length) await cardApi('PUT', `/api/card/${runningGame.id}/srm`, srm);
      cardInfo(`SAVED · ${runningGame.name} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\nWrite your code down (and remember your PIN)\nto load it on another device.`);
      report('card', 'save');
    } catch (e) { cardInfo(String(e.message || e), true); }
    finally { card.busy = false; cardUi(); }
  }
  async function cardLoad() {
    const E = gameReady(); if (!E || card.busy || !card.code) return;
    if (needPinFirst(cardLoad)) return;
    card.busy = true; cardUi(); cardInfo('Loading…');
    try {
      const meta = await (await cardApi('GET', '/api/card')).json();
      const g = meta.games && meta.games[runningGame.id];
      if (!g || !g.state) throw new Error(`Nothing saved for ${runningGame.name} on this card yet.`);
      if (g.srm) {
        const srm = new Uint8Array(await (await cardApi('GET', `/api/card/${runningGame.id}/srm`)).arrayBuffer());
        try { E.gameManager.FS.writeFile(E.gameManager.getSaveFilePath(), srm); E.gameManager.loadSaveFiles(); } catch {}
      }
      const state = new Uint8Array(await (await cardApi('GET', `/api/card/${runningGame.id}/state`)).arrayBuffer());
      E.gameManager.loadState(state);
      cardInfo(`LOADED · ${runningGame.name} · saved ${new Date(g.updated).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
      report('card', 'load');
      setTimeout(() => { card.panel.hidden = true; refocusGame(); }, 900);
    } catch (e) { cardInfo(String(e.message || e), true); }
    finally { card.busy = false; cardUi(); }
  }
  // tasto del tastierino: NEXT (codice) → USE THIS CARD (PIN) / OK (nuovo PIN)
  async function cardUse() {
    if (card.busy) return;
    if (card.mode === 'code') {
      if (card.entry.length !== 12) return;
      card.pendingCode = card.entry;
      return openEntry('pin', 'Now the PIN of this card.');
    }
    if (!PIN_OK(card.entry)) return;
    const pin = card.entry;
    if (card.mode === 'newpin') { const next = card.afterPin; card.afterPin = null; cardUi(false); if (next) await next(pin); return; }
    card.busy = true; cardUi(true); cardInfo('Checking…');
    try {
      const meta = await (await cardApi('GET', '/api/card', null, card.pendingCode, pin)).json();
      card.code = card.pendingCode; card.pin = pin; card.pendingCode = ''; remember();
      const n = Object.keys(meta.games || {}).length;
      card.busy = false; cardUi(false);
      cardInfo(n ? `Card found · ${n} game(s) saved. Press LOAD.` : 'Card found · empty. Press SAVE.');
    } catch (e) {
      card.busy = false;
      if (e.needPin) { // card di prima del PIN: lo si sceglie adesso
        const code = card.pendingCode;
        return openEntry('newpin', 'This card has no PIN yet: choose one now.', async (p) => {
          try { await cardApi('GET', '/api/card', null, code, p); card.code = code; card.pin = p; remember(); cardUi(false); cardInfo('PIN set · card protected. Press LOAD.'); }
          catch (err) { cardUi(false); cardInfo(String(err.message || err), true); }
        });
      }
      card.entry = ''; renderCardEntry(); cardUi(true); cardInfo(String(e.message || e), true);
    }
  }
  $('#btn-card').addEventListener('click', () => {
    card.panel.hidden = false; cardUi(false);
    cardInfo(card.code ? 'SAVE stores this exact moment. LOAD brings it back,\non any device with your code and PIN.' : 'Create a card (with your own PIN) to save\nyour progress and load it on any device.');
  });
  $('#card-save').addEventListener('click', cardSave);
  $('#card-load').addEventListener('click', cardLoad);
  $('#card-new').addEventListener('click', () => {
    if (card.code && !confirmNewCard()) return;
    card.code = ''; card.pin = ''; remember();
    cardSave(); // senza card: prima si sceglie il PIN, poi si crea e si salva
  });
  // niente window.confirm (dentro l'iframe di X può essere bloccato): secondo tocco per confermare
  let newCardArmed = 0;
  function confirmNewCard() {
    if (Date.now() - newCardArmed < 4000) return true;
    newCardArmed = Date.now();
    cardInfo('Your current card stays on the server. Tap NEW CARD again to start a new one.', true);
    return false;
  }
  $('#card-have').addEventListener('click', () => openEntry('code', 'Enter the 12-digit code of your card.'));
  $('#card-keys').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (b) cardKey(b.dataset.d); });
  $('#card-use').addEventListener('click', cardUse);
  $('#card-close').addEventListener('click', () => { card.panel.hidden = true; card.afterPin = null; cardUi(false); refocusGame(); });
  addEventListener('keydown', (e) => {
    if (card.panel.hidden) return;
    if (!$('#card-enter').hidden && /^\d$/.test(e.key)) cardKey(e.key);
    else if (!$('#card-enter').hidden && e.key === 'Backspace') cardKey('del');
    else if (!$('#card-enter').hidden && e.key === 'Enter') cardUse();
    else if (e.key === 'Escape') { card.panel.hidden = true; refocusGame(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  // ☰ MENU: apre/chiude il menu dell'emulatore (restart, salvataggi nel browser, impostazioni); altrimenti resta nascosto
  $('#btn-emu').addEventListener('click', () => {
    const open = document.body.classList.toggle('ejs-menu');
    $('#btn-emu').classList.toggle('on', open);
    if (!open) refocusGame();
  });

  // ---------- tastiera ----------
  addEventListener('keydown', (e) => {
    if (current === 'game') return; // in gioco comanda EmulatorJS
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return; // si sta scrivendo (es. la chiave)
    const k = e.key;
    if (current === 'power' && (k === 'Enter' || k === ' ' || k === 'x')) return powerOn();
    if (current !== 'menu') return;
    if (k === 'ArrowLeft') select(sel - 1);
    else if (k === 'ArrowRight') select(sel + 1);
    else if (k === 'Enter' || k === ' ' || k === 'x') confirm();
    else if (k === 'Escape' || k === 'Backspace' || k === 'o') back();
    else return;
    e.preventDefault();
  });

  // ---------- swipe ----------
  let sx = null;
  $('#carousel').addEventListener('pointerdown', (e) => { sx = e.clientX; });
  addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) > 40) select(sel + (dx < 0 ? 1 : -1));
  });

  // ---------- niente zoom per sbaglio sui telefoni ----------
  // Alcuni browser (soprattutto quelli dentro le app su iPhone) ignorano user-scalable=no: un doppio tocco sullo
  // schermo del gioco o tra i tasti del controller ingrandiva la pagina (segnalato 2026-10-09). Si blocca il secondo
  // tocco ravvicinato e il pizzico, ma non sui pulsanti/campi: RESET e NEW CARD usano il doppio tocco apposta.
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const onControl = e.target.closest && e.target.closest('button:not(.pad button), input, a, select, textarea, .keys');
    if (!onControl && now - lastTouchEnd < 350) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });
  for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) {
    document.addEventListener(ev, (e) => { if (!(e.target.closest && e.target.closest('input, textarea'))) e.preventDefault(); }, { passive: false });
  }
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });

  // ---------- joypad (menu); in gioco lo gestisce EmulatorJS ----------
  // Mappatura "standard": 0 = ✕ (basso), 1 = ○ (destra), 2 = □ (sinistra), 3 = △ (alto), 14/15 = croce sx/dx.
  const padState = {};
  function padConnected() {
    let list = [];
    try { list = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean); } catch { /* bloccato dalla pagina che ci incornicia */ }
    return list;
  }
  function updatePadUI() {
    const n = padConnected().length;
    $('#pad-status').hidden = !n;
    $('#pad-hint-power').textContent = n ? '🎮 GAMEPAD CONNECTED' : 'TAP · ENTER · GAMEPAD';
  }
  // ---------- joypad in gioco: li legge PSX, non EmulatorJS ----------
  // Il sistema di EmulatorJS è fragile (2026-10-09, Xbox 360 su Windows): non assegna i joypad già collegati,
  // li cerca per posizione invece che per numero, usa la disposizione Nintendo. Rattoppato tre volte e "ogni tanto"
  // ancora fermo. Ora: EmulatorJS non riceve joypad (gamepadSelection vuota) e PSX legge navigator.getGamepads()
  // ogni 8 ms e manda i tasti al gioco, con la stessa mappa PlayStation del giocatore 2 (PAD_MAP: ✕ basso, ○ destra,
  // □ sinistra, △ alto, croce, levetta sinistra = croce, grilletti = L2/R2). Il primo joypad che preme un tasto è il
  // giocatore 1, il secondo il giocatore 2 (un dispositivo "fantasma" che non preme mai non occupa posti).
  const localPads = new Map(); // "id_numero" → { player, state }
  function localPadLoop() {
    const E = window.EJS_emulator;
    if (current !== 'game' || !E || !E.started || vs.role === 'guest' || vs.role === 'watcher') return;
    try { if (Array.isArray(E.gamepadSelection) && E.gamepadSelection.some(Boolean)) E.gamepadSelection.fill(''); } catch {}
    const gm = E.gameManager;
    for (const p of padConnected()) {
      const key = `${p.id}_${p.index}`;
      const now = {};
      for (const [btn, id] of Object.entries(PAD_MAP)) now[id] = !!(p.buttons[btn] && (p.buttons[btn].pressed || p.buttons[btn].value > 0.5));
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      now[6] = now[6] || ax < -0.5; now[7] = now[7] || ax > 0.5; now[4] = now[4] || ay < -0.5; now[5] = now[5] || ay > 0.5;
      let pad = localPads.get(key);
      if (!pad) {
        if (!Object.values(now).some(Boolean)) continue; // aspetta il primo tasto
        pad = { player: [...localPads.values()].length, state: {} };
        localPads.set(key, pad);
        report('pad', { player: pad.player + 1, id: p.id.slice(0, 40), mapping: p.mapping || 'none' });
        if (pad.player === 0) toast('GAMEPAD = PLAYER 1', 1800);
      }
      for (const id of Object.keys(now)) {
        if (now[id] !== !!pad.state[id]) { try { gm.simulateInput(pad.player, Number(id), now[id] ? 1 : 0); } catch {} }
      }
      pad.state = now;
    }
  }
  setInterval(localPadLoop, 8);
  addEventListener('gamepadconnected', (e) => {
    updatePadUI();
    if (current === 'game') document.body.classList.add('pad-off'); // joypad vero: via il controller a schermo
    toast('GAMEPAD CONNECTED: ' + (e.gamepad.id.split('(')[0].trim() || 'OK').toUpperCase()); });
  addEventListener('gamepaddisconnected', () => { updatePadUI(); toast('GAMEPAD DISCONNECTED'); });

  function pollPads() {
    if (current !== 'game') {
      for (const p of padConnected()) {
        const pressed = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
        const ax = p.axes[0] || 0;
        const now = {
          x: pressed(0), o: pressed(1), t: pressed(3), start: pressed(9),
          left: pressed(14) || ax < -0.6, right: pressed(15) || ax > 0.6,
        };
        const prev = padState[p.index] || {};
        const hit = (k) => now[k] && !prev[k];
        if (current === 'power' && (hit('x') || hit('start'))) powerOn();
        else if (current === 'menu') {
          if (hit('left')) select(sel - 1);
          if (hit('right')) select(sel + 1);
          if (hit('x') || hit('start')) confirm();
          if (hit('o')) back();
        }
        padState[p.index] = now;
      }
    }
    requestAnimationFrame(pollPads);
  }

  // ---------- avvio ----------
  updatePadUI();
  setupPad();
  loadCatalog();
  // ritorno da ◄ GAMES: dritti alla scelta dei dischi
  try { if (sessionStorage.getItem('ts-go-menu')) { sessionStorage.removeItem('ts-go-menu'); show('menu'); setTimeout(checkPageHz, 300); } } catch {}
  requestAnimationFrame(pollPads);
})();
