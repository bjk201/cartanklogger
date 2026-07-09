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

## Installation auf Alpine Docker LXC (Homeserver)

```bash
# 1. Repo klonen
git clone https://github.com/bjk201/cartanklogger.git
cd cartanklogger

# 2. Docker-Netzwerk anlegen (EVCC + TeslaMate müssen beitreten)
docker network create home-net
docker network connect home-net <evcc-container>
docker network connect home-net <teslamate-container>

# 3. Starten
docker compose up -d --build
```

App erreichbar auf **http://<host>:8881**.

### Verbindung konfigurieren

In `config.yaml` (oder später in der Web-UI unter *Verwaltung*):

```yaml
evcc:
  host: "evcc"          # Container-Name oder IP
  port: 7070
  password: ""          # EVCC Admin-Passwort
  # api_token: ""       # alternativ: EVCC API-Token (Authorization: Bearer)
teslamate:
  url: "http://teslamate:4000/api"   # GraphQL-Endpoint
  # api_token: ""       # falls abgesichert
```

Danach in der Web-UI → **Daten abrufen → Alle synchronisieren**.

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
