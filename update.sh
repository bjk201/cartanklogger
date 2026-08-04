#!/usr/bin/env bash
#
# CarTankLogger 2.0 – Auto-Update für CTL 2.0 (V1 archiviert)
# ---------------------------------------------------------
# Einfach ausführen:  ./update.sh
#
# Was passiert:
#   1. git pull (neuester Code von GitHub)
#   2. CTL 2.0 (FastAPI Backend) neu bauen & starten -> Port 13132
#   3. Frontend neu bauen & starten -> Port 5173
#   4. Gesundheits-Checks für beide Services
#
# Verwendet reines 'docker' (kein docker-compose), weil docker-compose < v2
# auf manchen Hosts das neue Image-Format nicht lesen kann
# (KeyError: 'ContainerConfig').

set -euo pipefail

cd "$(dirname "$0")"

# ============================================================
# KONFIGURATION – NUR NOCH CTL 2.0
# ============================================================

# --- CTL 2.0 (FastAPI Backend) ---
CTL20_APP_NAME="cartanklogger-backend"
CTL20_IMAGE="${CTL20_APP_NAME}:latest"
CTL20_HOST_PORT=13132
CTL20_CONTAINER_PORT=8000
CTL20_DB_PATH="/app/data/cartanklogger-ctl20.db"
CTL20_CONFIG_FILE="/app/config.yaml"
CTL20_BUILD_CONTEXT="./backend"
CTL20_DOCKERFILE="backend/Dockerfile"

# --- Frontend (React/Vite) ---
FE_APP_NAME="cartanklogger-frontend"
FE_IMAGE="${FE_APP_NAME}:latest"
FE_HOST_PORT=5173
FE_CONTAINER_PORT=5173
FE_BUILD_CONTEXT="./frontend"
FE_DOCKERFILE="frontend/Dockerfile"

# --- Allgemein ---
BUILD_TIME="$(date +%s)"
COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo "n/a")"

# Umgebung aus .env laden (falls vorhanden), z.B. MOCK_MODE
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

MOCK_MODE="${MOCK_MODE:-false}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:13131,http://127.0.0.1:13131,http://localhost:13132,http://127.0.0.1:13132}"

# ============================================================
# HILFSFUNKTIONEN
# ============================================================

log_step() {
  echo ""
  echo "==> $1"
}

log_info() {
  echo "    $1"
}

log_success() {
  echo "✅ $1"
}

log_error() {
  echo "❌ $1" >&2
}

stop_container() {
  local name="$1"
  log_info "Stoppe Container: ${name}"
  docker rm -f "${name}" 2>/dev/null || true
}

build_image() {
  local image="$1"
  local context="$2"
  local dockerfile="$3"
  local label="$4"

  log_info "Baue Image: ${image} (${label})"
  docker build --no-cache \
    --build-arg "BUILD_TIME=${BUILD_TIME}" \
    --build-arg "COMMIT_HASH=${COMMIT_HASH}" \
    -t "${image}" \
    -f "${dockerfile}" \
    "${context}"
}

wait_for_health() {
  local url="$1"
  local name="$2"
  local max_attempts=20
  local attempt=1

  log_info "Warte auf ${name} (${url})..."

  while [ $attempt -le $max_attempts ]; do
    if curl -sf -o /dev/null "${url}" 2>/dev/null; then
      log_success "${name} ist bereit (${url})"
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done

  log_error "${name} antwortet nicht nach ${max_attempts} Versuchen"
  return 1
}

show_container_logs() {
  local name="$1"
  local lines="${2:-30}"
  echo "--- Letzte ${lines} Zeilen von ${name} ---"
  docker logs --tail "${lines}" "${name}" 2>&1 || true
  echo "--- Ende Logs ---"
}

# ============================================================
# MAIN
# ============================================================

echo "============================================================"
echo "CarTankLogger 2.0 Deployment - Build: ${BUILD_TIME} - Commit: ${COMMIT_HASH}"
echo "============================================================"

# ------------------------------------------------------------
# 1. CODE AKTUALISIEREN
# ------------------------------------------------------------
log_step "git pull (neuester Code)"
git pull --ff-only

# ------------------------------------------------------------
# 2. CTL 2.0 (FASTAPI BACKEND) DEPLOYEN
# ------------------------------------------------------------
log_step "CTL 2.0 (FastAPI Backend) deployen"

stop_container "${CTL20_APP_NAME}"

build_image "${CTL20_IMAGE}" "${CTL20_BUILD_CONTEXT}" "${CTL20_DOCKERFILE}" "CTL 2.0 Backend"

# DB-Datei für CTL 2.0 explizit ausgeben
CTL20_DB_FILE="$(pwd)/data/cartanklogger-ctl20.db"
log_info "CTL 2.0 Datenbank: ${CTL20_DB_FILE}"

# shellcheck disable=SC2086
docker run -d \
  --name "${CTL20_APP_NAME}" \
  --restart unless-stopped \
  -p "${CTL20_HOST_PORT}:${CTL20_CONTAINER_PORT}" \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/data:/app/data" \
  -e CONFIG_PATH="${CTL20_CONFIG_FILE}" \
  -e DB_PATH="${CTL20_DB_PATH}" \
  -e MOCK_MODE="${MOCK_MODE}" \
  -e ALLOWED_ORIGINS="${ALLOWED_ORIGINS}" \
  "${CTL20_IMAGE}"

if wait_for_health "http://localhost:${CTL20_HOST_PORT}/health" "CTL 2.0"; then
  log_success "CTL 2.0 läuft auf http://localhost:${CTL20_HOST_PORT}"

  # DB-Typ im Log kennzeichnen
  if [ -f "${CTL20_DB_FILE}" ]; then
    log_info "CTL 2.0 running with PRODUCTION database (cartanklogger-ctl20.db)"
  else
    log_info "CTL 2.0 running with EMPTY database (first start)"
  fi
else
  log_error "CTL 2.0 Start fehlgeschlagen"
  show_container_logs "${CTL20_APP_NAME}"
  exit 1
fi

# ------------------------------------------------------------
# 3. FRONTEND DEPLOYEN
# ------------------------------------------------------------
log_step "Frontend (React/Vite) deployen"

stop_container "${FE_APP_NAME}"

build_image "${FE_IMAGE}" "${FE_BUILD_CONTEXT}" "${FE_DOCKERFILE}" "Frontend"

docker run -d \
  --name "${FE_APP_NAME}" \
  --restart unless-stopped \
  -p "${FE_HOST_PORT}:${FE_CONTAINER_PORT}" \
  -v "$(pwd)/frontend:/app" \
  -v "/app/node_modules" \
  -e VITE_API_BASE=/api \
  "${FE_IMAGE}"

if wait_for_health "http://localhost:${FE_HOST_PORT}" "Frontend"; then
  log_success "Frontend läuft auf http://localhost:${FE_HOST_PORT}"
else
  log_error "Frontend Start fehlgeschlagen"
  show_container_logs "${FE_APP_NAME}"
  exit 1
fi

# ------------------------------------------------------------
# 4. ZUSAMMENFASSUNG
# ------------------------------------------------------------
echo ""
echo "============================================================"
echo "✅ DEPLOYMENT ERFOLGREICH ABGESCHLOSSEN (CTL 2.0 only)"
echo "============================================================"
echo ""
echo "Services:"
echo "  CTL 2.0 (FastAPI Backend): http://localhost:${CTL20_HOST_PORT}"
echo "                            API Docs: http://localhost:${CTL20_HOST_PORT}/docs"
echo "  Frontend (React/Vite)     : http://localhost:${FE_HOST_PORT}"
echo ""
echo "Datenbank:"
echo "  CTL 2.0 : $(pwd)/data/cartanklogger-ctl20.db"
echo ""
echo "Container:"
echo "  ${CTL20_APP_NAME}  (Port ${CTL20_HOST_PORT})"
echo "  ${FE_APP_NAME}   (Port ${FE_HOST_PORT})"
echo ""
echo "Build-Info:"
echo "  Zeitstempel: ${BUILD_TIME}"
echo "  Commit:      ${COMMIT_HASH}"
echo "============================================================"