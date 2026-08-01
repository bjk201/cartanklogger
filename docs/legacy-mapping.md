# Legacy Mapping: CarTankLogger 1.0 $\rightarrow$ 2.0

Dieses Dokument dient der Dokumentation der Geschäftslogik und Datenstrukturen des alten Flask/Jinja-Systems, um eine fehlerfreie Migration auf das neue FastAPI/React-Backend zu gewährleisten.

## 1. Datenquellen & Felder

### 1.1 EVCC (Home Sessions)
*   **Fokus:** Strombezug im Haus, Ladung am Netz.
*   **Wichtige Felder:**
    *   `date`: Datum des Ladevorgangs.
    *   `energy_kwh`: Gesamtenergie (kWh).
    *   `cost_eur`: Gesamtkosten des Ladevorgangs.
    *   `odometer_km`: Kilometerstand am Ende des Vorgangs.
    *   `location`: Meist "Home" oder spezifische Wallbox-Bezeichnung.

### 1.2 TeslaMate (External Sessions)
*   **Fokus:** Ladevorgänge an öffentlichen Säulen (DC/AC).
*   **Wichtige Felder:**
    *   `date`: Zeitpunkt/Datum des Ladevorgangs.
    *   `energy_kwh`: Gelieferte Energie.
    *   `cost_eur`: Kosten (oft über Drittanbieter-Integrationen/Mocks).
    *   `location`: Name des Superchargers/Ladestations.
    *   `is_dc`: Unterscheidung zwischen AC und DC.

## 2. Das neue Read-Model (MVP API Contract)

Der neue Endpunkt `GET /api/overview/recent-sessions?limit=10` liefert ein vereinheitlichthes Modell.

| Feld | Beschreibung | Quelle (Mapping) |
| :--- | :--- | :--- |
| `id` | Eindeutige ID (e.g. `home:42`, `external:42`) | `{source_type}:{original_id}` |
| `date` | ISO-Zeitstempel | `date` |
| `source_type` | `home` \| `external` \| `import` | Herkunft des Datensatzes |
| `location` | Name des Ortes | `location` |
| `energy_kwh` | Energie in kWh | `energy_kwh` |
| `cost_eur` | Kosten in EUR | `cost_eur` |
| `odometer_km` | Kilometerstand | `odometer_km` |
| `distance_km` | Berechnete Distanz (falls verfügbar) | Delta zwischen zwei Odometer-Ständen |
| `note` | Freitext | `note` |

## 3. Wichtige Regeln & Logik

### 3.1 Vermeidung von Doppelzählungen
*   **Problem:** Ein Ladevorgang könnte sowohl in EVCC als auch in TeslaMate auftauchen (z.B. wenn EVCC die Daten auch synchronisiert).
*   **Regel:** Die `source_type` muss strikt getrennt werden. Ein Datensatz darf nur einmal in der globalen Liste erscheinen. Vorrang hat die Quelle mit der präziseren Timestamp-Auflösung.

### 3.2 Sortierung & Limitierung
*   **Global:** Alle Quellen werden zu einem Stream zusammengeführt.
*   **Sortierung:** Primär nach `date` absteigend.
*   **Limitierung:** Erst nach der Sortierung wird das `limit` angewendet.

### 3.3 Offene Entscheidungen (Phase 2+)
*   **PV-Anteil:** Aktuell nicht im MVP, muss später über Differenzberechnung (Netz vs. Eigenverbrauch) ermittelt werden.
*   **Ladeverluste:** Berechnung erfordert präzise Vergleichswerte zwischen Batteriezustand und gelieferter Energie.
*   **Preisperioden:** Integration von dynamischen Stromtarifen erfordert API-Anbindung oder CSV-Import.

---
*Dokumentation erstellt von Hermes Agent am 2026-08-01.*
