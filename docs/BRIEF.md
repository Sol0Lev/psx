# BRIEF — TweetStation

## Goal (parole del proprietario, 2026-10-09)
> "si voglio farlo, considera che è un mio test quindi poi non sarà pubblico, iniziamo lo sviluppo"
> (riferito a: embeddare la PS1 dentro X come Tweetboy ha fatto col Game Boy Advance)
> "mettiamo sia carica un gioco che tre giochi pre caricati sul server ok?"
> "il layout dentro il link di x deve essere accattivante stile retro ps1 insomma"
> "deve esserci se possibile la possibilità di collegare anche il joypad"

## Decisioni del proprietario
- Test personale, non pubblico.
- Giochi: 3 precaricati sul server + pulsante "carica il tuo" (file dal dispositivo, non va mai sul server).
- Prima tutto in locale; hosting si sceglie dopo.
- Come provarlo su X: si decide dopo.
- Priorità: telefono (app X), comandi touch.
- Interfaccia in stile retro PS1. Joypad supportato.

## Riferimenti
- Tweetcraft (Minecraft in X): Player Card `twitter:card=player` + clone JS + WebSocket. Letto 2026-10-09.
- Tweetboy (GBA in X): Player Card + EmulatorJS core `mgba`. Letto 2026-10-09.
- Rischio: le regole delle Player Card vietano esperienze interattive; nel 2015 Twitter spense i giochi DOS dell'Internet Archive.
