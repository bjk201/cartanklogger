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

# Cache-Buster: APP_VERSION muss eine Zahl (Unix-Timestamp) sein, damit der
# Browser beim Deploy die neue app.js holt. Falls sie leer, "unknown" oder KEIN
# gueltiger Timestamp ist (z.B. Portainer reicht den Literal-String
# "$(date +%s)" durch), setzen wir die echte Startzeit.
case "$APP_VERSION" in
  ''|unknown|*\$*|*[!0-9]*) APP_VERSION="$(date +%s)" ;;
esac
export APP_VERSION

exec python app.py
