# Dry-Run Migration Report

**Timestamp:** 2026-08-01T12:19:36.742596
**Source DB:** /root/cartanklogger/data/cartanklogger.db
**Target DB:** /root/cartanklogger/data/cartanklogger-ctl20.db
**Mode:** APPLY

## A. Quellzahlen

- EVCC/Home-Sessions: 23
- TeslaMate/External-Sessions: 19
- Potenzielle TeslaMate-Home-Dubletten: 1
- Unklare Datensätze (Quarantäne): 0

## B. Zielzahlen

- Importierte Home-Sessions: 23
- Importierte External-Sessions: 18
- Quarantäne/Review-Einträge: 0
- Nicht importiert (Dubletten unterdrückt): 1

## C. Quarantäne-Details

| Legacy Source | Legacy Table | Legacy ID | Reason | Details |
|---------------|--------------|-----------|--------|---------|
| teslamate | external_sessions | 15 | duplicate_suppressed | {'matched_home_id': 17, 'match_rule': 'time_location_energy', 'match_details': ' |

## D. Doppelzählungsschutz

- Verhinderte potenzielle Doppelzählungen: 1
- Matching-Regel: Zeitfenster ±30min + Location-Keywords (Wallbox/Home/Garage/Zuhause) + Energie-Diff ≤15%
- Alle 19 externen Sessions waren Supercharger → keine Dopplungen in diesem Datensatz

