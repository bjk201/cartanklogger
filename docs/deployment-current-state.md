# Current Deployment State: CarTankLogger

**Analysis Date:** 2026-08-01  
**Analyst:** Hermes Agent

---

## 1. Was macht `update.sh` aktuell?

Das Skript `./update.sh` ist der **einzige Deploy-Mechanismus** für CTL 1.0 (Legacy Flask).

### Ablauf:
1. `git pull --ff-only` – holt neuesten Code
2. `docker rm -f cartanklogger` – stoppt & entfernt alten Container
3. `docker build --no-cache -t cartanklogger:latest .` – baut Image neu (mit BUILD_TIME Cache-Buster)
4. `docker run -d` – startet neuen Container:
   - Name: `cartanklogger`
   - Port: `13131:5000`
   - Volumes: `./config.yaml:/app/config.yaml` (Datei-Mount!), `./data:/app/data`
   - Env: `CONFIG_PATH=/app/config.yaml`, `DB_PATH=/app/data/cartanklogger.db`, `MOCK_MODE`
5. Healthcheck: 20× `curl http://localhost:13131` (2s Pause)
6. Bei Fehler: `docker logs --tail 30` + Exit 1

### Eigenschaften:
- `set -euo pipefail` – strikte Fehlerbehandlung
- Idempotent: mehrfaches Ausführen problemlos
- Kein Rollback (alter Container wird gelöscht bevor neuer startet)
- Nutzt **reines `docker`**, kein `docker-compose` (wegen Portainer/v2-Kompatibilität)

---

## 2. Images & Container

| Komponente | Image | Container | Port (Host:Container) | Build-Context |
|------------|-------|-----------|----------------------|---------------|
| CTL 1.0 (Legacy) | `cartanklogger:latest` | `cartanklogger` | 13131:5000 | `.` (Root) |
| CTL 2.0 (Backend) | `cartanklogger-backend:latest` | `cartanklogger-backend` | 13132:8000 | `./backend` |

**Aktuell:** Nur CTL 1.0 wird via `update.sh` gemanagt. CTL 2.0 läuft manuell gestartet.

---

## 3. Volumes & Datenpfade

| Host-Pfad | Container-Pfad | Nutzung |
|-----------|----------------|---------|
| `./data` | `/app/data` | SQLite-DB (`cartanklogger.db`) – **gemeinsam genutzt!** |
| `./config.yaml` | `/app/config.yaml` | CTL 1.0 Config (Datei-Mount) |
| `./config/` | `/app/config` | CTL 2.0 Config (Verzeichnis-Mount in compose) |

**KRITISCH:** Beide Services teilen sich dieselbe SQLite-Datei (`cartanklogger.db`). CTL 2.0 nutzt eigene Tabellen (`sessions`, `seed_data_status`, `import_quarantine`), aber **dasselbe File**.

---

## 4. Ports

| Service | Host-Port | Container-Port | Protokoll |
|---------|-----------|----------------|-----------|
| CTL 1.0 | 13131 | 5000 | HTTP |
| CTL 2.0 | 13132 | 8000 | HTTP |

---

## 5. CTL 1.0 Rebuild & Deploy

Ausschließlich über `./update.sh`. Kein CI/CD, kein Portainer-Autodeploy (außer man konfiguriert Portainer auf das Git-Repo mit `docker-compose.yml`).

---

## 6. Fehlerbehandlung & Rollback

- **Fehlerbehandlung:** `set -euo pipefail` + Healthcheck-Loop + Log-Ausgabe bei Timeout
- **Rollback:** **Nicht implementiert**. Alter Container wird *vor* Build gelöscht. Bei Build-Fehler läuft **gar nichts** mehr.
- **Retry:** Manuelles erneutes `./update.sh`

---

## 7. Erneut ausführen von `update.sh`

- **Problemlos:** `docker rm -f` räumt auf, `--no-cache` erzwingt frischen Build
- **Risiko:** Kein Rollback bei gescheitertem Build

---

## 8. Wiederverwendbar für CTL 2.0

| Element | Wiederverwendbar? | Anpassung nötig |
|---------|-------------------|-----------------|
| Git-Pull & Build-Logik | ✅ Ja | Separater Build-Context (`./backend`) |
| Container-Stop/Start | ✅ Ja | Eigener Name, Port, DB-Pfad |
| Healthcheck | ✅ Ja | Endpoint `/health` statt `/` |
| Volume-Mounts | ⚠️ Teilweise | **Eigene DB-Datei** für CTL 2.0 zwingend |
| Env-Variablen | ⚠️ Teilweise | `ALLOWED_ORIGINS`, `DB_PATH` anpassen |
| Config-Mount | ❌ Nein | CTL 1.0 nutzt Datei-Mount, CTL 2.0 Verzeichnis-Mount |

---

## Zusammenfassung: Handlungsbedarf für CTL 2.0 Integration

1. **Eigene DB-Datei** für CTL 2.0: `cartanklogger-ctl20.db` (nicht Dry-Run!)
2. **update.sh erweitern** um CTL-2.0-Block (nach CTL-1.0-Block)
3. **Dockerfile (Backend)** – Healthcheck hinzufügen, DB_PATH Default anpassen
4. **docker-compose.yml** – CTL 2.0 DB-Pfad korrigieren
5. **Dokumentation** in README