# SPEC — TweetStation v0 (locale)

## Pagine (server `server.mjs`, Node senza dipendenze)
- `GET /` — interfaccia (accensione → menu dischi → gioco).
- `GET /r/<id>` e `GET /play/<id>` — stessa interfaccia, con il gioco `<id>` già selezionato e i meta tag della Player Card:
  `twitter:card=player`, `twitter:player=<PUBLIC_URL>/play/<id>`, `twitter:player:width/height=600`, `twitter:image`, `og:*`.
  `<id>` sconosciuto → meta generici, nessun errore.
- `GET /api/games` — catalogo da `games.json`, con `available` (tutti i file esistono) e `bytes` totali.
- `GET /games/<id>/<file>` — solo file elencati nel catalogo per quel gioco (niente path traversal), con `Range` (206) e `Content-Length`.
- Nessun header che impedisca l'iframe (`X-Frame-Options` assente).

## Giochi
- `games.json`: `{ id, title, year, color, cue, files[] }`. I file stanno in `games/<id>/` (ignorata da git: mai committare giochi).
- Caricamento nell'emulatore: `EJS_gameUrl` = il `.cue`; le tracce `.bin` via `EJS_externalFiles` (percorso relativo = stessa cartella del cue).
  Un file singolo `.chd`/`.pbp`/`.iso`/`.zip`/`.7z` va direttamente in `EJS_gameUrl`.
- "Carica il tuo": `<input type=file multiple>`; i file restano nel browser (blob URL), nessun upload.

## Emulatore
- EmulatorJS **4.2.3** da CDN con versione fissata (`https://cdn.emulatorjs.org/4.2.3/data/`), core `psx` → `pcsx_rearmed`
  (BIOS sostitutivo interno: nessun BIOS Sony). Niente thread (dentro l'iframe di X non c'è cross-origin isolation).
- Touch: gamepad virtuale di EmulatorJS. Joypad: Gamepad API (EmulatorJS in gioco; il menu lo legge da sé).

## Interfaccia
- Quadrata 1:1 (riquadro X 600×600), funziona anche a schermo intero e a larghezza telefono.
- Stile PS1 originale (non copia di loghi/marchi Sony): accensione con suono sintetizzato, menu con dischi che girano,
  scanline CRT, simboli △ ○ ✕ □ come legenda comandi.
- Comandi menu: tocco, frecce/Invio/Esc, joypad (croce, ✕ = conferma, ○ = indietro).
