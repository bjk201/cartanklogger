#!/usr/bin/env bash
#
# CartTankLogger – Auto-Update
# ------------------------------------------------
# Einfach ausführen:  ./update.sh
#
# Was passiert:
#   1. git pull (neuester Code von GitHub)
#   2. alter Container wird gestoppt
#   3. Image wird neu gebaut (--no-cache => frischer Code)
#   4. Container wird neu gestartet (Config + Daten bleiben erhalten)
#   5. Gesundheits-Check (HTTP 200)
#
# Verwendet reines 'docker' (kein docker-compose), weil docker-compose < v2
# auf manchen Hosts das neue Image-Format nicht lesen kann
# (KeyError: 'ContainerConfig').
#
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="cartanklogger"
IMAGE="${APP_NAME}:latest"
HOST_PORT=13131
CONTAINER_PORT=5000

# Umgebung aus .env laden (falls vorhanden), z.B. MOCK_MODE
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "==> git pull (neuester Code)"
git pull --ff-only

echo "==> alter Container stoppen"
docker rm -f "${APP_NAME}" 2>/dev/null || true

echo "==> Image neu bauen (--no-cache => frischer Code; BUILD_TIME = Cache-Buster)"
BUILD_TIME="$(date +%s)" docker build --no-cache --build-arg BUILD_TIME="${BUILD_TIME}" -t "${IMAGE}" .

echo "==> Container starten"
# APP_VERSION wird im Dockerfile aus BUILD_TIME als ENV gesetzt (Cache-Buster);
# hier NICHT erneut -e APP_VERSION setzen, sonst ueberschreibt es mit leerem Wert.
# shellcheck disable=SC2086
docker run -d \
  --name "${APP_NAME}" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "$(pwd)/config.yaml:/app/config.yaml" \
  -v "$(pwd)/data:/app/data" \
  -e CONFIG_PATH=/app/config.yaml \
  -e DB_PATH=/app/data/cartanklogger.db \
  -e MOCK_MODE="${MOCK_MODE:-false}" \
  "${IMAGE}"

echo "==> warte auf Bereitschaft..."
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "http://localhost:${HOST_PORT}"; then
    echo "✅ CartTankLogger läuft auf http://localhost:${HOST_PORT}"
    exit 0
  fi
  sleep 2
done

echo "❌ Container antwortet nicht – letzte Logs:"
docker logs --tail 30 "${APP_NAME}" || true
exit 1
