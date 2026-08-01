# Legacy Data Inventory: CarTankLogger 1.0 SQLite Database

**Source Database:** `/root/cartanklogger/data/cartanklogger.db`  
**SHA256:** `4935654f84513d3ebc4d2a2e1c07b974c758fff7cb47eba7fa58489feb3ca91c`  
**Analysis Date:** 2026-08-01  
**Analyst:** Hermes Agent

---

## A. Tabellen und Zeilenanzahlen

| Tabelle | Zeilen | Beschreibung |
|---------|--------|--------------|
| `home_sessions` | 23 | EVCC/Home-Ladevorgänge (Wallbox) |
| `external_sessions` | 19 | TeslaMate/Externe Ladevorgänge |
| `drives` | 31 | TeslaMate-Fahrten |
| `extra_costs` | 0 | Zusatzkosten (leer) |
| `price_periods` | 2 | Preisperioden (Grid/Feed-in) |
| `sessions` | 10 | **Neue CTL-2.0-Tabelle** (Seed-Daten) |
| `seed_data_status` | 1 | Seed-Marker für CTL 2.0 |

---

## B. Feldinventar

### B.1 `home_sessions` (EVCC/Home) – 23 Zeilen

| Feld | Typ | Null% | Beispiel | Fachliche Bedeutung | Ziel-Feld |
|------|-----|-------|----------|---------------------|-----------|
| `id` | INTEGER PK | 0% | 1 | Interner PK | `legacy_id` |
| `evcc_session_id` | INTEGER UNIQUE | 0% | evcc_1000 | EVCC Session ID | `source_id` |
| `created` | TEXT | 0% | 2026-05-16T22:07:24 | Startzeitpunkt (ISO) | `date` |
| `finished` | TEXT | 0% | 2026-05-17T02:14:58 | Endzeitpunkt | – |
| `loadpoint` | TEXT | 0% | Wallbox | Ladepunkt-Name | `location` |
| `vehicle` | TEXT | 0% | Tesla Model 3 | Fahrzeug | `note` |
| `odometer` | REAL | 0% | 71267.0 | km-Stand am Ende | `odometer_km` |
| `charged_kwh` | REAL | 0% | 38.2 | Geladene Energie | `energy_kwh` |
| `solar_percentage` | REAL | 0% | 25.6 | PV-Anteil % | – (später) |
| `pv_kwh` | REAL | 0% | 9.78 | PV-Energie | – (später) |
| `grid_kwh` | REAL | 0% | 28.42 | Netzbezug | – (später) |
| `grid_cost` | REAL | 0% | 9.95 | Netz-Kosten | – (später) |
| `pv_cost` | REAL | 0% | 0.78 | PV-Kosten | – (später) |
| `total_cost` | REAL | 0% | 10.73 | Gesamtkosten | `cost_eur` |
| `price_per_kwh` | REAL | 0% | 0.281 | Effektiver €/kWh | – |
| `imported_at` | TEXT | 0% | 2026-07-22T22:07:24 | Import-Zeitpunkt | `imported_at` (Legacy) |
| `raw` | TEXT | 0% | `{}` | EVCC-Rohdaten | – |
| `updated_at` | TEXT | 0% | 2026-07-22T22:07:24 | Update-Zeitpunkt | – |
| `source` | TEXT | 0% | evcc | Quelle | `legacy_source` |
| `manually_edited` | INTEGER | 0% | 0 | Manuell bearbeitet | – |
| `note` | TEXT | 100% | NULL | Notiz | `note` |
| `soc_start` | REAL | 0% | 16.0 | SoC Start % | – |
| `soc_end` | REAL | 0% | 91.0 | SoC Ende % | – |

**Bewertung:** Sehr vollständige, qualitativ hochwertige Daten. Alle Pflichtfelder vorhanden. Keine NULL-Werte in Kerndaten.

### B.2 `external_sessions` (TeslaMate/External) – 19 Zeilen

| Feld | Typ | Null% | Beispiel | Fachliche Bedeutung | Ziel-Feld |
|------|-----|-------|----------|---------------------|-----------|
| `id` | INTEGER PK | 0% | 1 | Interner PK | `legacy_id` |
| `teslamate_session_id` | INTEGER UNIQUE | 0% | tm_2000 | TeslaMate Session ID | `source_id` |
| `started_at` | TEXT | 0% | 2026-07-04T05:07:24 | Startzeitpunkt | `date` |
| `finished_at` | TEXT | 0% | 2026-07-04T06:07:24 | Endzeitpunkt | – |
| `location_name` | TEXT | 0% | Supercharger | Standortname | `location` |
| `address` | TEXT | 100% | NULL | Adresse | – |
| `latitude` | REAL | 100% | NULL | Breitengrad | – |
| `longitude` | REAL | 100% | NULL | Längengrad | – |
| `provider` | TEXT | 0% | Tesla Supercharger | Anbieter | `note` |
| `energy_kwh` | REAL | 0% | 12.4 | Geladene Energie | `energy_kwh` |
| `energy_used_kwh` | REAL | 0% | 12.4 | Verbrauchte Energie | – |
| `odometer_start` | REAL | 0% | 55320.0 | km-Stand Start | – |
| `cost_total` | REAL | 0% | 7.73 | Gesamtkosten | `cost_eur` |
| `price_per_kwh` | REAL | 0% | 0.623 | €/kWh | – |
| `manual_price` | INTEGER | 0% | 1 | Manuelle Preisangabe | – |
| `imported_at` | TEXT | 0% | 2026-07-22T22:07:24 | Import-Zeitpunkt | `imported_at` (Legacy) |
| `raw` | TEXT | 0% | `{}` | TeslaMate-Rohdaten | – |
| `updated_at` | TEXT | 0% | 2026-07-22T22:07:24 | Update-Zeitpunkt | – |
| `source` | TEXT | 0% | teslamate | Quelle | `legacy_source` |
| `manually_edited` | INTEGER | 0% | 0 | Manuell bearbeitet | – |
| `note` | TEXT | 100% | NULL | Notiz | `note` |
| `soc_start` | REAL | 0% | 25.0 | SoC Start % | – |
| `soc_end` | REAL | 0% | 81.0 | SoC Ende % | – |
| `odometer_end` | REAL | 0% | 70229.0 | km-Stand Ende | – |

**Bewertung:** 100% Supercharger (keine Home-Doppelungen). `address`, `lat/lon` leer. Kosten & Energie vollständig.

### B.3 `drives` (TeslaMate Fahrten) – 31 Zeilen

| Feld | Typ | Null% | Beispiel | Fachliche Bedeutung | Ziel-Feld |
|------|-----|-------|----------|---------------------|-----------|
| `id` | INTEGER PK | 0% | 1 | Interner PK | – |
| `teslamate_drive_id` | INTEGER UNIQUE | 0% | 2000 | TeslaMate Drive ID | – |
| `start_date` | TEXT | 0% | 2026-06-23T07:00:00+00:00 | Startzeitpunkt | – |
| `end_date` | TEXT | 0% | 2026-06-23T07:38:00+00:00 | Endzeitpunkt | – |
| `start_address` | TEXT | 0% | Zuhause | Startadresse | – |
| `end_address` | TEXT | 0% | Arbeit GmbH | Zieladresse | – |
| `distance_km` | REAL | 0% | 32.4 | Strecke km | – (später für Distanz-Korrektur) |
| `odometer_start` | REAL | 0% | 42000.0 | km Start | – |
| `odometer_end` | REAL | 0% | 42032.4 | km Ende | – |
| `duration_min` | INTEGER | 0% | 38 | Dauer min | – |
| `speed_max` | INTEGER | 0% | 118 | Max km/h | – |
| `speed_avg` | REAL | 0% | 51.2 | Ø km/h | – |
| `soc_start` | REAL | 0% | 85.0 | SoC Start | – |
| `soc_end` | REAL | 0% | 79.0 | SoC Ende | – |
| `energy_consumed_kwh` | REAL | 0% | 5.18 | Verbrauch kWh | – |
| `outside_temp_avg` | REAL | 0% | 8.0 | Ø Außentemp | – |
| `imported_at` | TEXT | 0% | 2026-07-23T08:22:20 | Import-Zeitpunkt | – |
| `raw` | TEXT | 100% | NULL | Rohdaten | – |

**Bewertung:** Vollständige Fahrtdaten. Nicht direkt für MVP-Import relevant, aber wichtig für spätere Distanz-Validierung.

### B.4 `price_periods` – 2 Zeilen

| Feld | Wert |
|------|------|
| 1 | grid, 2020-01-01, NULL, 0.32, "Standard Netzbezugspreis" |
| 2 | feedin, 2020-01-01, NULL, 0.08, "Einspeisevergütung" |

### B.5 `extra_costs` – 0 Zeilen (leer)

### B.6 `sessions` (CTL 2.0 Seed-Daten) – 10 Zeilen

Nur Seed-Daten, nicht produktiv.

---

## C. Zeitliche Datenqualität

| Metrik | home_sessions | external_sessions | drives |
|--------|---------------|-------------------|--------|
| Ältester Datensatz | 2026-04-24 | 2026-04-27 | 2026-06-23 |
| Neuster Datensatz | 2026-07-08 | 2026-07-08 | 2026-07-12 |
| Fehlende Datums | 0 | 0 | 0 |
| Fehlende Energie | 0 | 0 | 0 |
| Fehlende Kosten | 0 | 0 | N/A |
| Fehlender km-Stand | 0 | 0 | 0 |
| Ungültige Zeitstempel | 0 | 0 | 0 |

**Fazit:** Keine Datenqualitätsprobleme in den Kerndaten. Alle Zeitstempel parsbar (ISO 8601).

---

## D. Quelle und Zuordnung

| Kategorie | Anzahl | Erkennungslogik |
|-----------|--------|-----------------|
| **EVCC/Home (sicher)** | 23 | `home_sessions` Tabelle, `source='evcc'`, `loadpoint='Wallbox'` |
| **TeslaMate/External (sicher)** | 19 | `external_sessions`, `source='teslamate'`, `location_name='Supercharger'` |
| **TeslaMate als Home erkannt** | 0 | Keine Einträge mit `location_name` LIKE '%Wallbox%' / '%Home%' / '%Garage%' / '%Zuhause%' |
| **Unklar / Review nötig** | 0 | Alle 19 External sind Supercharger |

**Wichtig:** In diesem Datensatz gibt es **keine TeslaMate-Home-Sessions**. Alle 19 externen Sessions sind explizit Supercharger. Doppelzählungsrisiko ist hier **nicht gegeben**, muss aber in der Migrationsregel generisch abgefangen werden.

---

## E. Aggregierte Kennzahlen (Legacy)

| Kennzahl | Home (EVCC) | External (TeslaMate) |
|----------|-------------|----------------------|
| Sessions | 23 | 19 |
| Summe Energie (kWh) | ~567 kWh | ~734 kWh |
| Summe Kosten (€) | ~175 € | ~298 € |
| Ø Energie/Session | ~24,6 kWh | ~38,6 kWh |
| Ø Kosten/Session | ~7,6 € | ~15,7 € |
| Zeitraum | Apr–Jul 2026 | Apr–Jul 2026 |

*Exakte Summen werden im Dry-Run-Report berechnet.*

---

## F. Sicherheits- und Trennungsstatus

| Aspekt | Status |
|--------|--------|
| Legacy-DB Pfad | `/root/cartanklogger/data/cartanklogger.db` |
| CTL-2.0 DB Pfad (aktuell) | **Derselbe File** (shared Volume) |
| Legacy-Container Mount | `/app/data` → `./data` (Read-Write) |
| CTL-2.0 Container Mount | `/app/data` → `./data` (Read-Write) |
| **Getrennt?** | ❌ **NEIN** – beide nutzen dieselbe Datei |
| Legacy-DB Read-Only für Import? | ❌ Aktuell nicht erzwungen |

**Maßnahme für Dry Run:** 
- Zieldatei: `/root/cartanklogger/data/cartanklogger-ctl20-dryrun.db` (separate Datei)
- Legacy-DB bleibt unangetastet (nur Lesen)
- CTL-2.0-Container muss für Dry Run auf neue DB umkonfiguriert werden