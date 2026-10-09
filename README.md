# PSX

A playable PS1 inside an X (Twitter) post: an X Player Card that boots a PlayStation emulator
(EmulatorJS + pcsx_rearmed, WebAssembly) right in the feed — on desktop, iPhone, iPad and Android.

Live: https://psxsol0lev.xyz

## Features

- Disc menu, on-screen controller (touch + mouse), keyboard and gamepad (Xbox/PlayStation layout).
- **VERSUS 1 vs 1** over WebRTC: P1 streams video + audio, P2 sends inputs. Lobby code, quick match, spectators.
  TURN relay (coturn, short-lived credentials) for mobile networks.
- **Memory card online**: random 12-digit code + personal PIN (scrypt), saves from any device.
- **UNDO**: rewind a wrong character pick (stick click, Backspace or the UNDO button).
- CLIP recording (MP4), mute, per-game preview images for the card.
- Games streamed in 512 KB chunks from CHD files: fast start, no full download.

## Run locally

```
npm ci
npm start      # http://localhost:8787   (card page: /r/psx)
npm test
```

**No games are included.** Use only discs you own: put them in `games/<id>/` (ignored by git) and add an
entry to `games.json`. `convert.mjs` turns .cue/.bin into CHD (needs `chdman` from MAME).

Online: set `PUBLIC_URL=https://your-domain` (X shows the playable card only over https).
Optional env: `TWITTER_SITE=@account`, `TURN_SECRET` + `TURN_URLS` for the relay.
Server setup used in production (Ubuntu, systemd hardening, Cloudflare tunnel, coturn, ufw, fail2ban):
`deploy/vps/`. Deploy: `PSX_HOST=root@<ip> PSX_KEY=~/.ssh/<key> npm run deploy`.

Design docs (Italian): `docs/BRIEF.md`, `docs/SPEC.md`, `docs/adr/`, `LESSONS.md`.

## Licenses

- `public/ejs/` is [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3, GPL-3.0 (see `public/ejs/LICENSE.txt`);
  the pcsx_rearmed core is GPL-2.0.
- PlayStation is a trademark of Sony Interactive Entertainment. This project is not affiliated with Sony.
  No BIOS or game images are distributed.
