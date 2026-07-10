#!/bin/sh
set -e

# Bind-Mounts (./data, ./config.yaml) werden auf dem Host oft als root angelegt
# und sind damit fuer den Laufzeit-User (cartank, uid 1000) NICHT schreibbar.
# Das fuehrt zu:
#   sqlite3.OperationalError: unable to open database file
# und verhindert das Speichern von Einstellungen (config.yaml) aus der UI.
# Hier richten wir die Rechte vor dem Start:
chown -R cartank:cartank /app/data 2>/dev/null || true
if [ -f /app/config.yaml ]; then
  chown cartank:cartank /app/config.yaml 2>/dev/null || true
  chmod 664 /app/config.yaml 2>/dev/null || true
fi

# Als cartank starten (kein root im Hauptprozess)
exec su-exec cartank:cartank python app.py
