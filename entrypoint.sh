#!/bin/sh
set -e

# Bind-Mounts (./data, ./config.yaml) werden auf dem Host oft als root angelegt
# und sind damit fuer den Laufzeit-User NICHT schreibbar. Das fuehrt zu:
#   sqlite3.OperationalError: unable to open database file
# und verhindert das Speichern von Einstellungen (config.yaml) aus der UI.
# Hier richten wir die Rechte vor dem Start ein.
#
# Hinweis: su-exec scheitert in manchen LXC/Docker-Setups an
#   "setgroups: Operation not permitted"
# deshalb starten wir die App hier direkt (kein User-Wechsel noetig,
# da die Dateirechte oben passend gesetzt wurden).
mkdir -p /app/data
chown -R "$(id -u):$(id -g)" /app/data 2>/dev/null || true
if [ -f /app/config.yaml ]; then
  chown "$(id -u):$(id -g)" /app/config.yaml 2>/dev/null || true
  chmod 664 /app/config.yaml 2>/dev/null || true
fi

exec python app.py
