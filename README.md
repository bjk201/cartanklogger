# CarTankLogger

Vollständiges Ladekosten-Tracking für dein EV – kombiniert **EVCC** (Laden zuhause)
und **TeslaMate** (externes Laden) in einer einfachen Web-App, inkl. aller
Nebenkosten (Anschaffung, Service, Zubehör, Versicherung, Steuer).

Orientiert an Tank-Logging-Apps (Spritmonitor/Tankerkönig): Odometer-/KM-Stand,
Verbrauch (kWh/100 km), Kosten/km, monatliche Auswertung.

## Funktionsweise

- **Zuhause (EVCC):** EVCC liefert via REST-API die Ladevorgänge inkl.
  `solarPercentage` (PV-Anteil). Daraus wird aufgeteilt in
  - **Netz-Anteil** → bewertet mit dem zeitlich anpassbaren **Netzbezugspreis**
  - **PV-Anteil** → bewertet mit der **entgangenen Einspeisevergütung**
  (Opportunitätskosten: Strom, der sonst eingespeist worden wäre).
- **Extern (TeslaMate):** via GraphQL-API werden Supercharger-/Fremdsäulen-
  Ladevorgänge (Ort, Datum, kWh, KM-Stand) geholt. Den **belasteten Preis**
  trägst du pro Sitzung manuell ein.
- **Preise sind zeitabhängig:** Du legst Preisperioden an (z. B. „ab 2025-01-01
  0,40 €/kWh"). Jede Sitzung wird mit dem Preis bewertet, der zu ihrem Datum
  gültig war. Preisänderungen werden sofort auf alle Sitzungen angewendet
  (kein erneuter Sync nötig).

## Datenfluss

```
EVCC (REST /api/sessions)  ─┐
                            ├─► CarTankLogger (Flask + SQLite) ─► Dashboard / Verwaltung
TeslaMate (GraphQL /api)   ─┘
```

Die App speichert importierte Sitzungen lokal in SQLite. Manuelle Korrekturen
(Extern-Preise, Extra-Kosten, Preisperioden) leben in der App-DB – ein erneuter
Sync überschreibt nur, was sich an der Quelle geändert hat (Dedupe via ID).

## Installation auf Alpine LXC (Homeserver)

Voraussetzung: Ein Alpine-LXC, in dem Docker laufen kann (auf Proxmox/Host
muss das LXC die **Nesting**-/Docker-Funktion haben). Die App erreicht EVCC und
TeslaMate über ein gemeinsames Docker-Netzwerk – beide müssen dort hängen.

### 1. Docker im LXC einrichten (einmalig)

```bash
apk add docker docker-compose   # docker + compose-Plugin
rc-update add docker default
service docker start
```

### 2. Repo klonen

```bash
apk add git
git clone https://github.com/bjk201/cartanklogger.git
cd cartanklogger
```

### 3. Docker-Netzwerk anlegen und EVCC + TeslaMate verbinden

```bash
docker network create home-net
# Containernamen anpassen – 'evcc' und 'teslamate' sind Beispiele:
docker network connect home-net evcc
docker network connect home-net teslamate
```

> Die Containernamen findest du mit `docker ps`. Sie müssen exakt zu den
> Hostnamen in `config.yaml` passen (siehe unten).

### 4. Verbindung in config.yaml prüfen/anpassen

```yaml
evcc:
  host: evcc            # Container-Name von EVCC (auf home-net)
  port: 7070
  password: ""          # EVCC Admin-Passwort
teslamate:
  url: http://teslamate:4000/api   # GraphQL-Endpoint
```

Falls dein EVCC-Container anders heißt, hier eintragen (oder später in der
Web-UI unter *Verwaltung → Verbindung*).

### 5. Starten

```bash
docker compose up -d --build
```

### 6. Öffnen

Die App lauscht im Container auf Port 5000, nach außen auf **13131**:

```
http://<LXC-IP>:13131
```

LXC-IP herausfinden:

```bash
ip -4 addr show eth0   # bzw. die verwendete Schnittstelle
```

Öffne diese URL im Browser deines Macs (oder jedem Gerät im Heimnetz).
Erster Start → in der Web-UI *Verwaltung → Testdaten einspielen* (optional zum
Ausprobieren) oder sofort *Daten abrufen → Alle synchronisieren*.

### 7. Logs / Neustart

```bash
docker compose logs -f cartanklogger   # Logs verfolgen
docker compose restart cartanklogger   # neu starten
docker compose pull && docker compose up -d --build   # nach git pull aktualisieren
```

App erreichbar auf **http://<host>:13131**.

> **Hinweis:** Chart.js/Bootstrap werden per CDN geladen → die Oberfläche
> braucht Internet. Für rein lokalen Betrieb kannst du die Libs vendor-n.
> (API/CSV funktioniert auch offline.)

## Preise & PV-Einspeisevergütung

Unter *Verwaltung → Preisperioden* legst du an:
- **Netz:** z. B. 0,32 €/kWh ab 2020-01-01, 0,40 €/kWh ab 2025-01-01
- **Einspeisung:** z. B. 0,08 €/kWh (deine EEG-Vergütung)

Jede Home-Sitzung wird mit dem zum Sitzungsdatum gültigen Satz bewertet.

## Externe Preise & Extra-Kosten

- *Verwaltung → Externe Ladevorgänge*: belasteten Preis je Sitzung eintragen.
- *Verwaltung → Extra-Kosten*: Anschaffung/Service/Zubehör/Versicherung/Steuer
  mit Datum, Betrag und optionalem KM-Stand.

## Testen ohne echte Instanzen (Mock-Modus)

```bash
MOCK_MODE=true DB_PATH=/tmp/ctl.db CONFIG_PATH=config.yaml python app.py
```
Dann in der Web-UI *Testdaten einspielen (Seed)*. Liefert realistische
Beispiel-Sitzungen + Extra-Kosten.

## API-Überblick

| Endpoint | Methode | Zweck |
|---|---|---|
| `/api/sync/evcc` | POST | EVCC-Sitzungen importieren |
| `/api/sync/teslamate` | POST | TeslaMate-Sitzungen importieren |
| `/api/sync/all` | POST | beide |
| `/api/sessions` | GET | alle Sitzungen (Home + Extern) |
| `/api/stats?days=365` | GET | aggregierte Kennzahlen |
| `/api/price-periods` | GET/POST/DELETE | zeitabhängige Preise |
| `/api/recompute` | POST | alle Home-Kosten neu bewerten |
| `/api/external/<id>/price` | PUT | manueller Extern-Preis |
| `/api/extra-costs` | GET/POST/DELETE | Nebenkosten |
| `/api/config` | GET/POST | Verbindungs-Einstellungen |
| `/api/debug/evcc` | GET | rohes EVCC-Sample (Feld-Check) |

## Technisches

- Python/Flask, SQLite (kein externer DB-Server nötig)
- EVCC: `POST /api/auth/login` → Cookie, dann `GET /api/sessions`
- TeslaMate: GraphQL `chargingSessions` (Query A `chargeEnergyAdded`, Fallback B `energyAdded`)
- Alpine-basiertes Docker-Image (`python:3.12-alpine`)
