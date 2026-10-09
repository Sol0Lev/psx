#!/bin/sh
# Pubblica PSX sul VPS (psxsol0lev.xyz): test, copia del codice e della pagina, riavvio, controllo dal dominio.
# Uso:  npm run deploy              solo codice e pagina
#       npm run deploy -- thps      anche il gioco games/thps (dopo averlo aggiunto a games.json)
# Server e chiave da variabili: PSX_HOST=root@<ip> PSX_KEY=~/.ssh/<chiave> npm run deploy
set -e
HOST=${PSX_HOST:?imposta PSX_HOST=root@<ip-del-server>}
SSH="ssh -i ${PSX_KEY:-$HOME/.ssh/id_ed25519} -o IdentitiesOnly=yes -o BatchMode=yes"
cd "$(dirname "$0")/.."

npm test

for id in "$@"; do
  [ -d "games/$id" ] || { echo "manca games/$id"; exit 1; }
  echo "carico games/$id…"
  tar -cf - "games/$id" | $SSH $HOST "tar -xf - -C /srv/psx && chown -R root:root /srv/psx/games/$id"
done

tar -cf - server.mjs netplay.mjs cards.mjs convert.mjs games.json package.json package-lock.json public \
  | $SSH $HOST 'set -e; cd /srv/psx; tar -xf -
      chown -R root:root public server.mjs netplay.mjs cards.mjs convert.mjs games.json package.json package-lock.json
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
      systemctl restart psx; sleep 2; systemctl is-active psx'

curl -fsS -o /dev/null -w "https://psxsol0lev.xyz/r/psx → %{http_code}\n" https://psxsol0lev.xyz/r/psx
