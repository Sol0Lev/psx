# LESSONS

- **EmulatorJS 4.2.3, `EJS_externalFiles` scrive file vuoti** (2026-10-09): passa un `ArrayBuffer` a `FS.writeFile`,
  che accetta solo stringhe/typed array → i `.bin` risultano 0 byte e pcsx_rearmed apre il menu di RetroArch invece del gioco.
  Sintomo: "Main Menu / Load Content" dopo il caricamento. Correzione in `public/app.js` (`patchGameManager`):
  si avvolge `EJS_GameManager.prototype.writeFile` convertendo in `Uint8Array`.
- **Nomi file senza spazi**: con `EJS_gameUrl` URL, EmulatorJS salva il file col nome URL-encoded (`Tekken%203...cue`).
  Usare nomi semplici (`tekken3.cue`, `track1.bin`) e riscrivere il cue.
- **Cache**: i file dell'app vanno serviti `no-cache` (o con `?v=`), altrimenti il browser tiene la versione vecchia per un'ora.
- **Il gamepad virtuale di EmulatorJS non ha un layout PS1**: per `psx` usa quello SNES (X/Y/A/B). Si passa `EJS_VirtualGamepadSettings`.
- **`FS.createLazyFile` non funziona sul thread principale** ("Cannot do synchronous binary XHRs outside webworkers"):
  EmulatorJS gira sul main thread. Soluzione: nodo FS con `stream_ops.read` proprio + XHR sincrono testuale
  (`overrideMimeType('text/plain; charset=x-user-defined')`, `charCodeAt & 0xff`). Vedi `mountStreamFile` in `public/app.js`.
- **Il pannello browser di Claude rallenta il rendering** (rAF ~2/s anche a pagina ferma): le misure di fps lì non valgono.
- **Diagnosi**: leggere `EJS_emulator.gameManager.FS` (`readdir('/')`, `stat(file).size`) dice subito se i file sono arrivati interi.
