# CarTankLogger 2.0

**Tesla-Lade-Tracking, EVCC- & TeslaMate-Integration, mit Kostenallokation und Reifen-Service.**

[![Backend](https://img.shields.io/badge/Backend-FastAPI-009688.svg)](#)
[![Frontend](https://img.shields.io/badge/Frontend-React%2018%20%2B%20Vite-61DAFB.svg)](#)
[![DB](https://img.shields.io/badge/Database-SQLite-003B57.svg)](#)
[![Deploy](https://img.shields.io/badge/Deploy-Docker-2496ED.svg)](#)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📋 Inhalt

1. [Überblick](#-überblick)
2. [Features](#-features)
3. [Schnellstart (Deployment)](#-schnellstart-deployment)
4. [Manuelle Entwicklung](#-manuelle-entwicklung)
5. [Architektur](#-architektur)
6. [API-Referenz](#-api-referenz)
7. [Konfiguration](#-konfiguration)
8. [Datenmodell](#-datenmodell)
9. [Testing & Wartung](#-testing--wartung)
10. [Troubleshooting](#-troubleshooting)

---

## 🎯 Überblick

**CarTankLogger 2.0 (CTL 2.0)** ist ein Self-Hosted-Dashboard für **Tesla-Ladevorgänge** und **Fahrzeug-Wartung**. Es kombiniert Daten aus zwei Quellen:

- **EVCC** (`Electric Vehicle Charge Controller`) — Wallbox-Ladevorgänge inkl. PV-Anteil
- **TeslaMate** — Fahrten, Standort, Verbrauch, Akkuzustand via GraphQL-API

Daraus entsteht eine **einheitliche Sicht** auf Kosten, Verbrauch, PV-Eigenverbrauch, Fahrzeug-km-Stand, Reifenwechselhistorie und Service-Einträge — mit automatischem **Matching** zwischen EVCC-Sessions und TeslaMate-Drives.

### Warum CTL 2.0?

- **Eine Datenbank, eine Wahrheit** — nicht zwei parallele Apps wie bei der Legacy-CTL-1.0
- **Type-safe API** — Pydantic-Schemas + OpenAPI 3.1 Swagger-UI
- **Live + Offline-fähig** — `MOCK_MODE` für Tests ohne EVCC/TeslaMate
- **Reifen-Modul** — Mehrfach-Montage mit automatisch berechneten km pro Satz
- **TM-Kostenexport** — Allokation der Stromkosten aus EVCC-Sessions auf TeslaMate-Drives

---

## ✨ Features

### Übersicht (KPI-Dashboard)
- **8 Live-KPIs** aus echtem TM-Datenabgleich (Energie, Kosten, €/kWh, €/Session, Ladeverluste, km-Stand)
- **6 Trend-Charts** (Chart.js): Energie/Session, Verbrauch kWh/100km, €/kWh, €/100km, kumulierte km, tägliche Energie
- **Sessions-Tabelle** mit PV-Anteil in % und kWh
- **Monatsvergleich** (Energie, PV-Anteil, km)
- **Zeitraum-Filter**: 7 / 30 / 90 / 365 Tage, Alles, benutzerdefiniert

### Sessions
- Alle Ladevorgänge (EVCC + TeslaMate) mit Sortierung, Filter, Pagination
- **TM-Kostenexport** pro Session: Status (pending/approved/executed), Allokations-Drilldown
- **Matching-Engine** ordnet EVCC-Sessions den TM-Drives zu (regelbasiert + Override)

### Fahrzeug
- **Service & Wartung** — Eintragen, Editieren, Löschen (z. B. Inspektion, Werkstattbesuche)
- **Reifen** — Mehrfach-Montage pro Satz, automatisch berechnete **gefahrene km pro Satz** aus TM-Drives
- **Aktionen pro Reifensatz**: Mount, Demount, Archive, Replace-Tire, Sync-Odometer

### Datenquellen (Einstellungen)
- **EVCC & TeslaMateAPI** Verbindungsstatus + Test-Button
- **Sync-Button** für manuellen Datenabgleich
- Live-Anzeige ob EVCC und TeslaMateAPI **erreichbar** sind

### UI / UX
- **Dark / Light Mode** mit CSS Variables + localStorage + System-Preference
- **Mobile-first Responsive** (Breakpoints 480 / 768 / 1024)
- **Sidebar collapsible** auf Desktop, **Drawer** auf Mobile
- **State-Views** für Loading / Error / Empty / PartialError — keine toten Screens
- **0 Console-Errors / 0 React-Warnings** im Live-Betrieb

---

## 🚀 Schnellstart (Deployment)

### Voraussetzungen

- **Docker** ≥ 20.10 (Host oder via SSH)
- **Git** (für `git pull`)
- Optional: **Portainer** mit Git-Repository-Stack (für Auto-Rebuild bei Push)

### Single-Command-Deploy

```bash
cd /path/to/cartanklogger
./update.sh
```

Das Skript macht **alles** automatisch:

1. `git pull --ff-only` (lädt neuesten Stand von GitHub)
2. Baut Image `cartanklogger-backend:latest` (Python 3.12-slim)
3. Baut Image `cartanklogger-frontend:latest` (Node 20-alpine + Vite-Build)
4. Startet beide Container mit korrekten Mounts (`./data`, `./config`)
5. **Healthcheck** auf `/health` (Backend) und `/` (Frontend)
6. **DNS-Check** falls TeslaMate-DB-Netzwerk in `.env` konfiguriert
7. **Log-Dump** (letzte 30 Zeilen) bei Fehler

### Erreichbar nach Deploy

| Service | URL | Zweck |
|---|---|---|
| **Frontend (SPA)** | `http://<HOST>:5173` | Dashboard |
| **Backend API** | `http://<HOST>:13132` | FastAPI + WebSocket |
| **API Docs (Swagger)** | `http://<HOST>:13132/docs` | Interaktive Doku |
| **OpenAPI JSON** | `http://<HOST>:13132/openapi.json` | Schema-Import |
| **Healthcheck** | `http://<HOST>:13132/health` | Container-Health |

### Docker Compose (Portainer-Stack-Alternative)

```bash
docker compose up -d --build
```

Die `docker-compose.yml` ist auf **Portainer-Stacks** optimiert (Git-Repository-Stack → Auto-Deploy bei Push).

> ⚠️ **Auf manchen Hosts funktioniert `docker compose`** (v2 CLI) **nicht** mit dem Image-Format (`KeyError: 'ContainerConfig'`).
> Dann stattdessen `./update.sh` benutzen.

---

## 🛠️ Manuelle Entwicklung

### Backend (Python 3.12, FastAPI, SQLAlchemy)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# DB-Pfad (default: ../data/cartanklogger-ctl20.db)
export DB_PATH=$(realpath ../data/cartanklogger-ctl20.db)
export CONFIG_PATH=$(realpath ../config/config.yaml)
export MOCK_MODE=false
export ALLOWED_ORIGINS="http://localhost:5173"

uvicorn app.main:app --host 0.0.0.0 --port 13132 --reload
```

### Frontend (Node 20, React 18, Vite 5, TypeScript)

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173 mit Proxy /api → http://localhost:13132
```

**Production-Build:**

```bash
npm run build         # → frontend/dist/ (statische Dateien)
npm run preview       # lokaler Preview-Server
```

### Wichtige ENV-Variablen (Dev)

| Variable | Default | Zweck |
|---|---|---|
| `DB_PATH` | `/app/data/cartanklogger-ctl20.db` | SQLite-Pfad |
| `CONFIG_PATH` | `/app/config/config.yaml` | YAML-Config |
| `MOCK_MODE` | `false` | Wenn `true`: keine externen API-Calls, Mock-Daten |
| `ALLOWED_ORIGINS` | `http://localhost:13132,http://localhost:5173` | CORS Origins (Komma-separiert) |
| `TESLAMATE_DB_*` | — | Direktzugriff auf TM-Postgres (host/port/user/password/name) |
| `TESLAMATE_DB_NETWORK` | — | Docker-Netzwerk-Name (z. B. `teslamate_default`) |
| `EVCC_HOST`, `EVCC_PORT`, `EVCC_PASSWORD`, `EVCC_API_TOKEN` | — | EVCC-Verbindung |
| `TESLAMATE_URL`, `TESLAMATE_API_TOKEN` | — | TeslaMate-API-URL + Token |
| `TZ` | `Europe/Berlin` | Zeitzone für Datums-Bucket-Gruppierung |

---

## 🏛️ Architektur

### Datenfluss

```
EVCC (Wallbox) ──┐
                ├─→  FastAPI Backend  ─→  SQLite (cartanklogger-ctl20.db)
TeslaMateAPI ───┘                          ─→  Matching-Engine
TeslaMateDB ──── (optional direkt) ─────────→  Allokation
                                              │
                                              ▼
                                       React SPA (5173)
                                       ─→  Echtzeit-KPIs, Charts
                                       ─→  Reifen-Logik
                                       ─→  TM-Kostenexport-UI
```

### Backend-Layout

```
backend/
├── Dockerfile                       # python:3.12-slim + uvicorn
├── requirements.txt
├── app/
│   ├── main.py                      # FastAPI-App + Router-Registrierung
│   ├── config.py                    # Pydantic Settings (ENV-driven)
│   ├── database.py                  # SQLAlchemy Engine + Session
│   ├── api/                         # FastAPI Router (10 Module)
│   │   ├── overview.py              # KPIs, Charts, Summary
│   │   ├── sessions.py              # Sessions-Liste + Detail + Match
│   │   ├── statistics.py            # Aggregationen
│   │   ├── vehicle.py               # Service + Reifen
│   │   ├── extra_costs.py           # Extra-Kosten (CRUD)
│   │   ├── matching.py              # Dry-Run + Live-Matching
│   │   ├── matching_override.py     # User-Overrides
│   │   ├── matching_raw.py          # Roh-Daten-Inspektor
│   │   ├── matching_unmatched.py    # Was noch zu matchen ist
│   │   ├── tm_cost_export.py        # Kostenallokation
│   │   └── datasource.py            # Settings + Sync
│   ├── models/                      # SQLAlchemy ORM-Modelle
│   ├── schemas/                     # Pydantic Request/Response-Schemas
│   ├── repositories/               # DB-Query-Layer
│   └── services/                    # Business-Logik (Clients, Matching, Allokation)
├── scripts/
│   └── import_legacy_sqlite.py      # Einmaliger Import der CTL-1.0-DB
└── tests/
    ├── test_matching_consistency.py
    └── test_tm_cost_export.py
```

### Frontend-Layout

```
frontend/
├── Dockerfile                       # node:20-alpine + Vite build + serve-static
├── package.json                     # chart.js, lucide-react, react-router-dom v6
├── tsconfig.json
├── vite.config.ts                   # /api → http://localhost:13132, HMR.host
├── index.html
├── serve-static.mjs                 # SPA-Server + API-Proxy (für Container)
├── spa_fallback.py                  # Optional: SPA-Fallback für nginx
└── src/
    ├── main.tsx                     # ReactDOM.createRoot
    ├── App.tsx                      # Router + Layout
    ├── app/
    │   ├── ThemeContext.tsx         # Light/Dark + localStorage
    │   └── TimeRangeContext.tsx     # Globaler Zeitraum-Filter
    ├── components/                  # Wiederverwendbare UI-Bausteine
    │   ├── Sidebar.tsx + .css       # Navigation + Live-Status
    │   ├── TopBar.tsx + .css        # Zeitraum + Sync + Theme-Toggle
    │   ├── KpiCard.tsx + .css       # KPI mit Trend-Pfeil
    │   ├── SessionsTable.tsx + .css # Desktop-Tabelle
    │   ├── SessionMobileCard.tsx    # Mobile Card View
    │   ├── TmCostExportPanel.tsx    # Allokations-Panel
    │   └── StateViews.tsx + .css    # Loading/Error/Empty/PartialError
    ├── features/
    │   └── overview/
    │       ├── OverviewPage.tsx      # KPI-Dashboard (Hauptseite)
    │       └── OverviewPage.css
    ├── pages/
    │   ├── SessionsPage.tsx + .css  # Alle Ladevorgänge + TM-Export
    │   ├── StatisticsPage.tsx + .css
    │   ├── VehiclePage.tsx + .css   # Service + Reifen
    │   ├── DataSourcesPage.tsx + .css  # Settings (DataSources)
    │   └── *PlaceholderPage.tsx     # Routen-Stubs für Erweiterung
    ├── lib/
    │   ├── apiClient.ts             # Zentrales fetch + Error-Handling
    │   └── chartTooltip.ts + .css
    ├── styles/
    │   ├── global.css               # CSS Variables, Reset, Theme
    │   └── layout.css
    └── types/
        └── api.ts                   # TypeScript Interfaces
```

### Routing

### Aktive Routen (Sidebar-Navigation)

| Pfad | Seite | Status |
|---|---|---|
| `/` | Overview (KPIs, Charts, Sessions) | ✅ live |
| `/statistics` | Statistik | ✅ live |
| `/vehicle` | Service & Wartung + Reifen | ✅ live |
| `/sessions` | Sessions-Liste + TM-Kostenexport | ✅ live |
| `/settings` | Datenquellen (EVCC, TeslaMate) | ✅ live |
| `/tm-cost-export` | Redirect → `/sessions` | ✅ (eingegliedert) |

> Die im Frontend vorhandenen `*PlaceholderPage.tsx` (Preise, Extra-Kosten, Import-Review) sind für künftige Erweiterungen vorbereitet, aktuell aber **nicht** in der Sidebar verlinkt. Die zugehörigen Backend-Endpoints sind bereits implementiert (siehe API-Referenz unten).

---

## 📡 API-Referenz

**Aktuelle Stand:** **41 Endpoints, 50 HTTP-Methoden** (`/openapi.json`).

### Highlights

#### Health & Status

```bash
GET /health                     # → {ok, data_source, evcc, teslamateapi}
GET /api/status                 # → Detail-Status beider Quellen
```

#### Overview

```bash
GET /api/overview/summary             # Hauptseite-Aggregate
GET /api/overview/recent-sessions     # Liste letzter N Sessions
                                       #   ?limit=10
```

#### Sessions

```bash
GET    /api/sessions                   # Paginierte Liste, Filter, Sort
GET    /api/sessions/{id}              # Detail inkl. Matches
PUT    /api/sessions/{id}              # Edit (Notes, Manual-Cost)
DELETE /api/sessions/{id}              # Löschen
POST   /api/sessions/{id}/match        # Manuell mit TM-Charge verknüpfen
GET    /api/sessions/{id}/matches      # Alle Matches
DELETE /api/sessions/{id}/match/{tid}  # Match auflösen
GET    /api/sessions/tm-sums           # TM-Aggregate pro Session
GET    /api/sessions/export-states     # Batch TM-Export-Status
```

#### TM-Kostenexport (Allokation)

```bash
GET    /api/tm-cost-export                       # Liste Allokationen
POST   /api/tm-cost-export/refresh               # Allokations-Lauf starten
GET    /api/tm-cost-export/{evcc_session_id}     # Detail
POST   /api/tm-cost-export/{evcc_session_id}/approve
POST   /api/tm-cost-export/{evcc_session_id}/execute
POST   /api/tm-cost-export/{evcc_session_id}/rollback
```

#### Fahrzeug (Service + Reifen)

```bash
GET /api/vehicle/info                            # VIN, Modell, Odometer
GET /api/vehicle/records                         # Services + Tires (gruppiert)
POST   /api/vehicle/records                      # Eintrag anlegen
PUT    /api/vehicle/records/{id}                 # Edit
DELETE /api/vehicle/records/{id}                 # Löschen
POST   /api/vehicle/records/{id}/archive         # Reifen archivieren
POST   /api/vehicle/records/{id}/unarchive
POST   /api/vehicle/records/{id}/mount           # Reifen montieren
POST   /api/vehicle/records/{id}/demount
PUT    /api/vehicle/records/{id}/replace-tire
POST   /api/vehicle/records/{id}/sync-odometer   # Sync mit TM
```

#### Matching

```bash
GET /api/matching/dry-run                # Dry-Run-Vorschau
GET /api/matching/dry-run/live           # Live-Matching-Status
GET /api/matching/dry-run/status
GET /api/matching/raw-data               # Roh-Daten-Inspektor
GET /api/matching/unmatched              # Was nicht gematched wurde
GET    /api/matching/overrides
POST   /api/matching/overrides
GET    /api/matching/overrides/charge/{tid}
DELETE /api/matching/overrides/{oid}
```

#### Settings / DataSources

```bash
GET   /api/settings/data-sources          # Aktuelle Konfiguration
POST   /api/settings/data-sources         # Konfiguration ändern
POST   /api/settings/data-sources/test    # Verbindung testen
POST   /api/settings/data-sources/sync    # Manueller Sync
```

#### Extra-Kosten

```bash
GET    /api/extra-costs
POST   /api/extra-costs
PUT    /api/extra-costs/{id}
DELETE /api/extra-costs/{id}
```

#### Statistiken

```bash
GET /api/statistics                # Aggregierte Stats (Charts-Roh-Daten)
GET /api/statistics/overview       # Übersicht
```

> 📘 **Swagger-UI mit "Try it out":** `http://<HOST>:13132/docs`

---

## ⚙️ Konfiguration

### `config/config.yaml` (auto-erzeugt beim ersten Start)

Wird aus `config.example.yaml` kopiert, falls nicht vorhanden. **Nicht in Git versioniert** (in `.gitignore`).

```yaml
evcc:
  host: 192.168.1.15
  port: 7070
  api_token: "..."
  password: "..."

teslamateapi:
  url: "http://192.168.1.21:8080/api/v1/"
  api_token: "..."

teslamate_db:                # Optional: direkter DB-Zugriff
  host: "database"
  port: 5432
  user: "teslamate"
  password: "..."
  name: "teslamate"

# Sync-Intervalle, Match-Toleranzen, etc.
```

### `.env` (Environment für Docker)

```env
MOCK_MODE=false                              # 'true' = ohne EVCC/TM
TZ=Europe/Berlin
SECRET_KEY=                                  # leer = auto aus DB-Pfad
ALLOWED_ORIGINS=http://localhost:5173

# Nur für TeslaMate-Direktzugriff (DB)
TESLAMATE_DB_HOST=database
TESLAMATE_DB_PORT=5432
TESLAMATE_DB_USER=teslamate
TESLAMATE_DB_PASSWORD=...
TESLAMATE_DB_NAME=teslamate
TESLAMATE_DB_NETWORK=teslamate_default        # Docker-Netzwerk-Name
```

### `.env.example` mitgeliefert

Vorlage im Repo mit allen dokumentierten Variablen + Kommentaren.

---

## 🗃️ Datenmodell

SQLite, eine Datei pro Service-Generation (`cartanklogger-ctl20.db`).

| Tabelle | Zweck |
|---|---|
| `datasource` | Aktive Datenquelle-Konfiguration |
| `session` | Ladevorgang (EVCC oder TeslaMate) |
| `session_match` | Verbindung EVCC↔TM |
| `matching_override` | Manueller Override für automatische Matches |
| `vehicle_record` | Service- oder Reifen-Eintrag (Record-Typ unterscheidet) |
| `tire_mount` | Historie wann welcher Reifen montiert wurde |
| `tm_cost_export` | Allokations-Lauf (welche EVCC-Kosten auf welche TM-Drive) |
| `extra_cost` | Manuell eingetragene Kosten (z. B. Wäsche, Vignette) |

### Match-Logik

EVCC-Sessions und TeslaMate-Drives werden über **Zeit + Geokoordinaten + Akkustand** gematched.
**Override** haben Vorrang (`matching_override.override_target`).
Konflikte werden in `session_match.conflict_reason` dokumentiert.

### Reifen-Logik

Reifen durchlaufen eine **State-Machine**:

```
created → mounted → (drives) → archived
            ↑                ↓
            └─── replace ───┘
```

Pro Satz wird `vehicle_record` (Record-Type=Tire) angelegt; jeder Mount/Unmount erzeugt einen
`tire_mount`-Eintrag mit Datum + Odometer. **Gefahrene km pro Satz** = Summe der TM-Drives
zwischen Mount und Demount — live aus `teslamateapi`.

---

## 🧪 Testing & Wartung

### Backend-Tests

```bash
cd backend
pytest tests/
# oder einzeln:
python -m pytest tests/test_matching_consistency.py -v
python -m pytest tests/test_tm_cost_export.py -v
```

### Healthcheck live

```bash
curl -s http://localhost:13132/health | python3 -m json.tool
```

Erwartete Antwort (Live-Modus):

```json
{
  "ok": true,
  "service": "cartanklogger-backend",
  "version": "2.0.0",
  "database": "connected",
  "data_source": "live",
  "data_source_description": "Live-Modus: EVCC und TeslaMateAPI konfiguriert",
  "evcc_configured": true,
  "teslamateapi_configured": true
}
```

### Snapshot-DB / Backup

```bash
# DB-Snapshot vor jedem Update:
cp data/cartanklogger-ctl20.db data/cartanklogger-ctl20.db.$(date +%Y%m%d)

# Source-Tarball (siehe Backup-Skill):
mkdir -p /root/backups && \
  tar --exclude='cartanklogger/.venv' \
      --exclude='cartanklogger/frontend/node_modules' \
      --exclude='cartanklogger/frontend/dist' \
      -czf /root/backups/cartanklogger-$(date +%Y%m%d).tar.gz \
      cartanklogger/
```

### Logs ansehen

```bash
docker logs --tail 50 cartanklogger-backend
docker logs --tail 50 cartanklogger-frontend -f       # Live-Tail
```

### Image neu bauen ohne Cache

```bash
docker build --no-cache -t cartanklogger-backend:latest -f backend/Dockerfile backend/
docker build --no-cache -t cartanklogger-frontend:latest -f frontend/Dockerfile frontend/
```

### Migrations / DB-Schema-Reset

```bash
# CTL 2.0 erzeugt Tabellen beim Start automatisch aus SQLAlchemy-Modellen.
# Datenverlust: DB löschen + Container neu starten (nur für Dev!):
rm data/cartanklogger-ctl20.db
docker restart cartanklogger-backend
```

### Production-Import (CTL 1.0 → CTL 2.0)

```bash
# Einmalig (Backup nicht vergessen!):
cd backend
python scripts/import_legacy_sqlite.py \
    --from ../data/cartanklogger.db \
    --to ../data/cartanklogger-ctl20.db
```

Reports: `docs/production-import-report.md` (siehe Migrations-Skripte in `docs/`).

---

## 🔧 Troubleshooting

### Frontend zeigt 404

**Ursache:** `./frontend` ist nach `git pull` als leeres Verzeichnis gemountet, aber `dist/` ist gitignored.
**Fix:** `./update.sh` neu ausführen — es baut `dist/` neu im Image. **Kein Bind-Mount** auf `./frontend:/app`!

### Backend startet, aber `data_source: mock`

**Ursache:** `MOCK_MODE=true` in `.env`, oder EVCC/TM nicht erreichbar.
**Fix:**
```bash
curl http://localhost:13132/api/status   # zeigt Erreichbarkeit beider Quellen
# Wenn "reachable: false":
# - EVCC_HOST / TESLAMATE_URL prüfen
# - Docker-Netzwerk prüfen (TESLAMATE_DB_NETWORK)
```

### Matching findet nichts

1. **Dry-Run-Modus aktivieren:** `/api/matching/dry-run` (DB-only)
2. **Live-Matching triggern:** Button "Daten synchronisieren" in `/settings`
3. **Roh-Daten prüfen:** `/api/matching/raw-data`
4. **Override anlegen:** `/api/matching/overrides`

### TM-Kostenexport ist leer

**Wichtig:** Die Liste zeigt nur **bereits allokierte** Einträge. Erst nach `POST /api/tm-cost-export/refresh` (Button "Berechnen" in der UI) werden neue Allokations-Läufe gestartet.

### CORS-Fehler im Browser

`ALLOWED_ORIGINS` in `.env` muss die **exakte Origin** enthalten (mit Port, ohne Pfad):
```env
ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.199:5173
```

### Container-Logs zeigen nichts

```bash
docker logs --tail 100 cartanklogger-backend
docker logs --tail 100 cartanklogger-frontend
```

Bei Startfehler gibt `./update.sh` die letzten 30 Zeilen automatisch aus.

---

## 📦 Was **nicht** mehr im Repo ist (bereits aufgeräumt)

- ❌ CTL 1.0 (Flask, jQuery, `static/`, `templates/`) — vollständig archiviert und aus Git entfernt
- ❌ Pre-2.0 React-Code (`src/`-Wurzel, `app.js`)
- ❌ Einmal-Migrations-Reports (`docs/dry-run-report*`, `docs/production-import-report*`)
- ❌ Obsolete Wurzel-Build-Configs (`package.json`, `tsconfig.json`, `vite.config.ts`)
- ❌ Wurzelfix-Test-Files (`test_*.py`, `STEP_2_CHECKS_COMPLETE.md`, `TESTING_REPORT.md`)

Alles Aktive liegt jetzt **nur** in `backend/` (FastAPI) und `frontend/` (React+Vite).

---

## 📄 Lizenz

MIT — siehe [LICENSE](LICENSE). © 2026 bjk201.

---

## 🏷️ Repository-Info

- **Branch:** `main`
- **Remote:** `git@github.com:bjk201/cartanklogger.git`
- **Status:** ✅ Production-ready, Live-Modus aktiv
- **Stack:** Python 3.12 (FastAPI) · Node 20 (React 18 + Vite 5 + TS) · SQLite 3 · Docker 28