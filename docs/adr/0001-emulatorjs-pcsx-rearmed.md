# ADR 0001 — EmulatorJS 4.2.3 + pcsx_rearmed, da CDN

Data: 2026-10-09 · Stato: accettato

**Contesto.** Serve un emulatore PS1 che giri nel browser del telefono, dentro un iframe di X.
Tweetboy usa EmulatorJS (core mgba), quindi la strada è già provata dentro X per il GBA.

**Decisione.** EmulatorJS 4.2.3 (ultima release GitHub, 2025-07-05, verificata 2026-10-09) da `cdn.emulatorjs.org/4.2.3/`.
Core `pcsx_rearmed`: il più leggero per PS1, ha un BIOS HLE incorporato (niente BIOS Sony da distribuire). Senza thread.

**Conseguenze.** Dipendiamo dal CDN di EmulatorJS; prima di andare online conviene copiarlo sul nostro hosting.
EmulatorJS è GPL-3.0: ok per uso personale; se il codice si distribuisce, va distribuito GPL.
