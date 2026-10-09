# Configurazione del VPS (psxsol0lev.xyz, Contabo Cloud VPS 4, Ubuntu 24.04)

Copie dei file installati sul server, **senza segreti** (il segreto del ponte sta solo in `/etc/psx/turn.env` sul VPS,
la credenziale del tunnel solo in `/etc/cloudflared/`). Servono a ricostruire il server se si perde.

| File qui | Sul VPS | A cosa serve |
|---|---|---|
| psx.service | /etc/systemd/system/ | PSX come servizio protetto (utente psx, solo 127.0.0.1, sola lettura tranne saves/) |
| turnserver.conf | /etc/turnserver.conf | server ponte per il VERSUS col 5G (coturn) |
| 00-psx-hardening.conf | /etc/ssh/sshd_config.d/ | SSH solo con chiave |
| psx.local | /etc/fail2ban/jail.d/ | blocco di chi sbaglia gli accessi SSH |
| 99-psx-hardening.conf | /etc/sysctl.d/ | difese di rete del kernel |
| 52psx-reboot | /etc/apt/apt.conf.d/ | riavvio automatico alle 05:00 dopo aggiornamenti di sicurezza |
| psx-backup, psx-backup.timer | /usr/local/bin/, /etc/systemd/system/ | copia notturna delle memory card |
| ufw.txt | ufw + /etc/ufw/before.rules | firewall: solo SSH (limitato) e porte del ponte, limite pacchetti per indirizzo |

Accesso: `ssh root@YOUR_SERVER_IP` (solo dal PC che ha la chiave). Pubblicare: `npm run deploy`.
