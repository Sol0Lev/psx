# ADR 0002 — Formato dei giochi: cue+bin ora, CHD dopo

Data: 2026-10-09 · Stato: accettato (provvisorio)

**Contesto.** Tekken 3 (USA) estratto = 1 cue + 3 bin = 688 MB. Il telefono scarica tutto e lo tiene in memoria.
Servire il `.7z` (460 MB) costringerebbe il browser a decomprimere: memoria doppia, rischio crash su telefono.

**Decisione.** Per ora cue + bin serviti separatamente (`EJS_gameUrl` = cue, `EJS_externalFiles` = bin). Nessuna decompressione.

**Dopo.** Convertire in CHD (un file solo, compresso, letto nativamente da pcsx_rearmed) con `chdman` di MAME:
serve scaricare MAME da mamedev.org → ok del proprietario per il download.
