# Migration Rules: CarTankLogger 1.0 → 2.0

**Status:** Verbidlich für Dry-Run-Importer  
**Version:** 1.0  
**Datum:** 2026-08-01

---

## 1. Grundprinzipien

1. **Keine Datenvernichtung** – Legacy-DB bleibt schreibgeschützt.
2. **Nachvollziehbarkeit** – Jeder importierte Datensatz trägt Metadaten: `legacy_source`, `legacy_table`, `legacy_id`, `imported_at`, `import_status`.
3. **Idempotenz** – Wiederholter Import erzeugt keine Duplikate (Upsert basierend auf `legacy_source + legacy_table + legacy_id`).
4. **Quarantäne statt Löschen** – Unklare Daten werden mit Status `quarantine` und Grund gekennzeichnet, nicht verworfen.
5. **Dry-Run First** – Standardmodus ist `--dry-run`. Nur explizites `--apply` schreibt in die Zieldatenbank.

---

## 2. Quellen-Zuordnung (Source Type Mapping)

| Legacy-Tabelle | Legacy `source` | Neuer `source_type` | Priorität | Begründung |
|----------------|-----------------|---------------------|-----------|------------|
| `home_sessions` | `evcc` | `home` | 1 (führend) | Primäre Quelle für Home-Charging. EVCC misst physikalisch an der Wallbox. |
| `external_sessions` | `teslamate` | `external` | 1 (führend) | TeslaMate Supercharger sind explizit extern. |
| `external_sessions` | `teslamate` | `home` | 2 (falls Home) | Nur wenn Location eindeutig Home (Wallbox/Garage/Zuhause) – **Quarantäne** |
| `external_sessions` | `teslamate` | `import` | 3 (unklar) | Alle anderen unklaren Locations → Review |

---

## 3. Doppelzählungs-Schutz (Deduplication Rules)

### 3.1 Erkennung potenzieller Dopplungen
Eine TeslaMate-Session (`external_sessions`) gilt als **potenzieller Doppelzähler** zu einer EVCC-Session (`home_sessions`), wenn **ALLE** Kriterien zutreffen:

1. **Zeitliche Überlappung**: 
   - `external.started_at` liegt innerhalb von `[home.created - 30min, home.finished + 30min]`
   - ODER `external.finished_at` liegt innerhalb desselben Fensters

2. **Orts-Ähnlichkeit**:
   - `external.location_name` enthält "Wallbox", "Home", "Garage", "Zuhause" (case-insensitive)
   - ODER `home.loadpoint` ähnelt `external.location_name` (Fuzzy-Match)

3. **Energienähe**:
   - `|external.energy_kwh - home.charged_kwh| / home.charged_kwh < 0.15` (15% Toleranz)

### 3.2 Behandlung bei Erkennung
| Szenario | Aktion | Import-Status |
|----------|--------|---------------|
| EVCC-Session existiert, TeslaMate matcht | **Nur EVCC importieren** (führend) | TeslaMate: `duplicate_suppressed` |
| Nur TeslaMate vorhanden, Location = Home | Import als `source_type=home` mit Warnung | `quarantine:possible_home_duplicate` |
| TeslaMate Location = Supercharger | Import als `source_type=external` | `imported` |
| Unklar | Import als `source_type=import` | `quarantine:ambiguous_source` |

### 3.3 Dokumentation
Jede unterdrückte Dopplung wird in der Quarantäne-Tabelle/Datei protokolliert mit:
- `legacy_id` der unterdrückten Session
- `matched_legacy_id` der führenden Session
- `match_rule` (welche Regel gegriffen hat)
- `match_score` (Zeitdiff, Energiediff)

---

## 4. Feld-Mapping Regeln

### 4.1 `home_sessions` → `sessions` (source_type = "home")

| Ziel-Feld | Quelle | Transformation |
|-----------|--------|----------------|
| `id` | Auto (PK) | – |
| `source_id` | `evcc_session_id` | String-Cast |
| `source_type` | Konstante | `"home"` |
| `date` | `created` | ISO-String → DateTime (UTC) |
| `location` | `loadpoint` | Direct |
| `energy_kwh` | `charged_kwh` | Direct (Float) |
| `cost_eur` | `total_cost` | Direct (Float) |
| `odometer_km` | `odometer` | Direct (Float) |
| `distance_km` | **NULL** | Nicht aus Home ableitbar (später via Drives) |
| `note` | `vehicle` + `soc_start`/`soc_end` | `"Vehicle: {vehicle}, SoC: {soc_start}→{soc_end}%"` |
| `legacy_source` | Konstante | `"evcc"` |
| `legacy_table` | Konstante | `"home_sessions"` |
| `legacy_id` | `id` | Integer |
| `imported_at` | `NOW()` | Timestamp |
| `import_status` | Berechnet | `"imported"` / `"quarantine:..."` |

### 4.2 `external_sessions` → `sessions` (source_type = "external" | "home" | "import")

| Ziel-Feld | Quelle | Transformation |
|-----------|--------|----------------|
| `source_id` | `teslamate_session_id` | String-Cast |
| `source_type` | **Regel-basiert** | Siehe Abschnitt 2 |
| `date` | `started_at` | ISO-String → DateTime (UTC) |
| `location` | `location_name` | Direct |
| `energy_kwh` | `energy_kwh` | Direct (Float) |
| `cost_eur` | `cost_total` | Direct (Float) |
| `odometer_km` | `odometer_start` | Direct (Float) |
| `distance_km` | **NULL** | Nicht direkt ableitbar |
| `note` | `provider` + `soc_start`/`soc_end` | `"{provider}, SoC: {soc_start}→{soc_end}%"` |
| `legacy_source` | Konstante | `"teslamate"` |
| `legacy_table` | Konstante | `"external_sessions"` |
| `legacy_id` | `id` | Integer |
| `imported_at` | `NOW()` | Timestamp |
| `import_status` | Berechnet | `"imported"` / `"quarantine:..."` / `"duplicate_suppressed"` |

---

## 5. Kosten-Import-Regeln

| Situation | Regel |
|-----------|-------|
| `total_cost` / `cost_total` vorhanden & > 0 | **Übernehmen** als `cost_eur` (Importwert) |
| Kosten = 0 oder NULL | `cost_eur = NULL`, Status: `quarantine:missing_cost` |
| `manual_price = 1` (TeslaMate) | Flag in `note` aufnehmen: `"manual_price=true"` |
| PV/Grid-Aufteilung (Home) | **Nicht** beim Import berechnen. Rohwerte (`grid_kwh`, `pv_kwh`, `grid_cost`, `pv_cost`) in `note` oder separater JSON-Spalte für spätere Auswertung speichern. |
| Preisperioden | Werden **nicht** retroaktiv angewendet. Legacy-Kosten bleiben unverändert. |

---

## 6. Längere Sessions / Tagesgrenzen

- EVCC-Sessions können über Mitternacht laufen (`created` ≠ `finished` Tag).
- **MVP-Regel:** Session **nicht** aufteilen. Ursprünglicher Zeitraum bleibt erhalten.
- `date` = `created` (Startzeitpunkt).
- Tagesaggregation ist Reporting-Thema (später).

---

## 7. Unklare Daten / Quarantäne-Kategorien

Jeder Datensatz, der nicht sauber importiert werden kann, erhält einen `import_status`:

| Status | Bedeutung | Beispiel |
|--------|-----------|----------|
| `imported` | Erfolgreich importiert | – |
| `quarantine:missing_timestamp` | Kein gültiges Datum | – |
| `quarantine:missing_energy` | Energie = 0 oder NULL | – |
| `quarantine:missing_cost` | Kosten = 0 oder NULL | – |
| `quarantine:missing_odometer` | km-Stand = 0 oder NULL | – |
| `quarantine:possible_duplicate` | Dopplung erkannt, unterdrückt | TeslaMate matcht EVCC |
| `quarantine:ambiguous_source` | Location nicht eindeutig Home/External | "Parkplatz", "Firmenparkplatz" |
| `quarantine:invalid_value` | Werte außerhalb Plausibilität | Energie > 200 kWh, km > 1M |
| `duplicate_suppressed` | Explizit als Duplikat nicht importiert | TeslaMate Home-Doppelte |

**Wichtig:** Quarantäne-Datensätze **werden in die Zieldatenbank geschrieben** (mit `source_type="import"`), aber mit `import_status` gekennzeichnet. So gehen keine Daten verloren und Review ist möglich.

---

## 8. Ziel-Schema Erweiterung (Minimal für Import)

Die bestehende `sessions`-Tabelle wird um folgende Spalten erweitert (Migration via ALTER TABLE oder Neuanlage):

```sql
ALTER TABLE sessions ADD COLUMN legacy_source VARCHAR(50);
ALTER TABLE sessions ADD COLUMN legacy_table VARCHAR(50);
ALTER TABLE sessions ADD COLUMN legacy_id INTEGER;
ALTER TABLE sessions ADD COLUMN imported_at DATETIME;
ALTER TABLE sessions ADD COLUMN import_status VARCHAR(50);
-- Optional: UNIQUE Constraint für Idempotenz
CREATE UNIQUE INDEX ux_sessions_legacy 
  ON sessions (legacy_source, legacy_table, legacy_id);
```

**Hinweis:** Die `id`-Spalte der neuen `sessions`-Tabelle bleibt Auto-Increment PK. Die API-ID (`home:123`) wird zur Laufzeit aus `source_type + source_id` konstruiert.

---

## 9. Dry-Run Ablauf

1. **Parameter prüfen**: `--source-db`, `--target-db` Pflicht.
2. **Schema vorbereiten**: Ziel-DB Tabellen anlegen (inkl. Erweiterungen).
3. **Home importieren**: Alle 23 `home_sessions` → `source_type=home`.
4. **External analysieren**: Für jede der 19 `external_sessions` Dopplungsprüfung gegen Home.
5. **External importieren**: Nach Regeln (2/3/4) zuordnen.
6. **Statistik sammeln**: Zähler für alle Kategorien.
7. **Report schreiben**: JSON + Markdown.
8. **Bei `--apply`**: Transaktion committen, sonst Rollback.

---

## 10. Validierungsschwellen (Plausibilität)

| Feld | Min | Max | Bei Verstoß |
|------|-----|-----|-------------|
| `energy_kwh` | 0.1 | 200 | `quarantine:invalid_value` |
| `cost_eur` | 0 | 1000 | `quarantine:invalid_value` |
| `odometer_km` | 0 | 1,000,000 | `quarantine:invalid_value` |
| `date` | 2020-01-01 | NOW()+1day | `quarantine:invalid_value` |

---

## 11. Idempotenz-Garantie

- **Unique Key**: `(legacy_source, legacy_table, legacy_id)`
- Bei Re-Import: `INSERT ... ON CONFLICT(legacy_source, legacy_table, legacy_id) DO UPDATE SET ...`
- `imported_at` wird auf neuen Wert gesetzt, `import_status` neu berechnet.
- Seed-Daten (`seed_data_status`) werden **ignoriert** (nur für CTL-2.0-Seed relevant).

---

*Ende der Migrationsregeln. Diese Regeln sind Basis für den Importer-Code.*