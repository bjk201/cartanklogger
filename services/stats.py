"""Statistik-Layer auf Basis vereinheitlichter Charge-Sicht.

Grundprinzipien:
  - TeslaMate ist Primärquelle für Charge-Historie.
  - EVCC ergänzt Home-Charging (Wallbox, PV, Odometer, Loadpoint).
  - Home-Kosten = EVCC-Wallbox-kWh * (PV-Anteil * Einspeisevgütung
    + Grid-Anteil * Preisperiode). Opportunitätskosten via Feed-in.
  - Externe Kosten = TeslaMate cost oder manuelle Korrektur.
  - Ladeverluste = echtes (wall_kwh - battery_kwh), falls beide vorhanden.
  - Home wird NICHT doppelt gezählt (EVCC ist führend, TM-Home nur für Verlust).

CableSession-Logik (Match-Einheit):
  - 1 EVCC-Session = führende CableSession (Einstecken -> Ausstecken)
  - n TeslaMate-Charges innerhalb desselben Kabel-Zeitfensters = Teilereignisse
  - battery_kwh = Summe der TeslaMate charge_energy_added
  - wall_kwh / Kosten = EVCC (führend)
"""
from collections import defaultdict
from datetime import datetime, timedelta

# Konstante für geschätzten Ladeverlust, falls keine echten Daten vorliegen.
# Wird NUR als Fallback genutzt und in der API als Schaetzung markiert.
ESTIMATED_LOSS_FACTOR = 0.15


def _parse_dt(val):
    """ISO-String -> naive datetime (Zeitzone verwerfen)."""
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    s = str(val).replace("Z", "").replace("+00:00", "")
    try:
        return datetime.fromisoformat(s[:19])
    except Exception:
        try:
            return datetime.fromisoformat(s)
        except Exception:
            return None


def _is_home_external_row(r):
    """True, wenn eine external_sessions-Zeile eine TM-Home-Ladung ist
    (doppeltes Tracking mit EVCC)."""
    text = f"{r.get('location_name') or ''} {r.get('address') or ''}".lower()
    markers = ["zuhause", "garage", "wallbox", "home"]
    return any(m in text for m in markers)


def compute_home_energy_split(wall_kwh, solar_percentage):
    solar = max(0.0, min(100.0, float(solar_percentage or 0.0)))
    pv = wall_kwh * solar / 100.0
    grid = max(0.0, wall_kwh - pv)
    return round(pv, 3), round(grid, 3)


def compute_home_cost_row(row, price_lookup):
    """Kosten für eine Home-Session neu berechnen (immer aktuell).

    Nutzt price_lookup(kind, date) -> float für grid/feedin.
    Liefert Dict mit pv_kwh, grid_kwh, grid_cost, pv_cost, total_cost, price_per_kwh.
    """
    created = _parse_dt(row.get("created")) or datetime.now()
    charged = float(row.get("charged_kwh") or 0)
    if charged <= 0:
        return {"pv_kwh": 0, "grid_kwh": 0, "grid_cost": 0, "pv_cost": 0,
                "total_cost": 0, "price_per_kwh": 0}
    solar = row.get("solar_percentage") or 0
    pv_kwh, grid_kwh = compute_home_energy_split(charged, solar)
    grid_price = price_lookup("grid", created) if price_lookup else 0.32
    feedin_price = price_lookup("feedin", created) if price_lookup else 0.08
    grid_cost = round(grid_kwh * grid_price, 4)
    pv_cost = round(pv_kwh * feedin_price, 4)
    total = round(grid_cost + pv_cost, 4)
    price_per_kwh = round(total / charged, 4) if charged else 0
    return {
        "pv_kwh": pv_kwh, "grid_kwh": grid_kwh,
        "grid_cost": grid_cost, "pv_cost": pv_cost,
        "total_cost": total, "price_per_kwh": price_per_kwh,
    }


def build_stats_from_rows(home_rows, external_rows, extra_rows, price_lookup,
                          get_price_at, days=365, from_date=None, to_date=None, db=None):
    """Berechnet Statistiken aus den (bereits gefilterten) DB-Rows.

    home_rows      : home_sessions (EVCC-geführt, gematchte/externe Home)
    external_rows  : external_sessions (TeslaMate, externe Charges)
    extra_rows     : extra_costs
    price_lookup   : Funktion(kind, date) -> float (aus app.get_price_at)
    get_price_at   : s.o.
    db             : database connection für drives-Abfrage

    Liefert ein Dict im bisherigen build_stats-Format (kompatibel zur UI).
    """
    if from_date and to_date:
        cutoff = from_date + "T00:00:00"
        end = to_date + "T23:59:59"
    else:
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        end = None

    def in_range(d):
        d19 = (d or "")[:19]
        if not d19:
            return False
        if d19 < cutoff:
            return False
        if end and d19 > end:
            return False
        return True

    home = [dict(r) for r in home_rows if in_range(r.get("created"))]
    ext_all = [dict(r) for r in external_rows if in_range(r.get("started_at"))]
    # TM-Home (doppeltes Tracking) nur für Referenz/Ladeverlust, NICHT für Energie.
    # Erkennung über EVCC-Wallbox-Zeitfenster (nicht über Geofence-String, da TM
    # Heim-Ladungen oft falsch als "Oeffentliche Ladestation" labelt).
    def _pd(v):
        s = str(v or "").replace("Z", "").replace("+00:00", "")
        try:
            return datetime.fromisoformat(s[:19])
        except Exception:
            return None
    evcc_windows = []
    for r in home:
        sdt = _pd(r.get("created"))
        edt = _pd(r.get("finished")) or sdt
        if sdt is not None:
            evcc_windows.append((sdt, edt))
    def _tm_is_home(r):
        # FIRST: String-based exclusion (definitely NOT home)
        # This prevents real Superchargers from being misclassified as home
        # just because they happen to overlap with an EVCC time window.
        loc = f"{r.get('location_name') or ''} {r.get('address') or ''}".lower()
        if "supercharger" in loc or "ladestation" in loc or "öffentliche" in loc:
            return False  # Definitely not home
        # SECOND: Check time window match with EVCC (primary detection)
        # This catches TM home sessions even if mislabeled (e.g., as "Oeffentliche Ladestation")
        cdt = _pd(r.get("started_at"))
        if cdt is not None:
            for sdt, edt in evcc_windows:
                if sdt <= cdt <= edt:
                    return True
        # FALLBACK: String-based home detection (zuhause, garage, wallbox, home)
        return _is_home_external_row(r)
    ext = [r for r in ext_all if not _tm_is_home(r)]
    extras = [dict(r) for r in extra_rows if in_range(r.get("date"))]

    # --- Distanz: Summe Tageskilometer aus drives-Tabelle (nicht Odometer-Diff!) ---
    # Hole alle Drives im Zeitraum und summiere distance_km
    drives_q = "SELECT distance_km FROM drives WHERE start_date >= ?"
    drives_params = [cutoff] if not end else [cutoff, end]
    if end:
        drives_q = "SELECT distance_km FROM drives WHERE start_date >= ? AND start_date <= ?"
        drives_params = [cutoff, end]
    drives_rows = db.execute(drives_q, drives_params).fetchall()
    total_dist = sum(float(r[0] or 0) for r in drives_rows)

    # Odometer-Wert für Anzeige (letzter bekannter Stand) - NICHT für Berechnungen!
    odo_dated = []
    for e in home:
        try:
            odo_dated.append(((e.get("created") or "")[:19], float(e.get("odometer") or 0)))
        except Exception:
            pass
    for t in ext_all:
        try:
            odo_dated.append(((t.get("started_at") or "")[:19], float(t.get("odometer_start") or 0)))
        except Exception:
            pass
    odo_dated = [x for x in odo_dated if x[1] > 0]
    odo_dated.sort(key=lambda x: x[0])
    total_km_odo = odo_dated[-1][1] if odo_dated else 0.0

    # --- Energie & Kosten (wie im Original) ---
    home_kwh = sum(float(r.get("charged_kwh") or 0) for r in home)
    home_grid_cost = 0.0
    home_pv_cost = 0.0
    home_pv_kwh = 0.0
    home_grid_kwh = 0.0
    for r in home:
        c = compute_home_cost_row(r, price_lookup)
        home_grid_cost += c["grid_cost"]
        home_pv_cost += c["pv_cost"]
        home_pv_kwh += c["pv_kwh"]
        home_grid_kwh += c["grid_kwh"]
    home_cost = home_grid_cost + home_pv_cost

    # --- Externe Energie/Kosten (nur TeslaMate) ---
    ext_kwh = sum(float(r.get("energy_kwh") or 0) for r in ext)
    ext_cost = sum(float(r.get("cost_total") or 0) for r in ext)

    extra_total = sum(float(e.get("amount") or 0) for e in extras)
    extra_by_cat = {}
    for e in extras:
        extra_by_cat[e.get("category") or "Sonstiges"] = \
            round(extra_by_cat.get(e.get("category") or "Sonstiges", 0) + float(e.get("amount") or 0), 2)

    total_kwh = home_kwh + ext_kwh
    total_cost = home_cost + ext_cost + extra_total
    tco = total_cost

    cost_per_km = (total_cost / total_dist) if total_dist > 0 else 0
    tco_per_100km = (tco / total_dist * 100) if total_dist > 0 else 0
    consumption_bruto = (home_kwh / total_dist * 100) if total_dist > 0 else 0

    # --- Echter Ladeverlust (Wall - Akku) aus Daten ---
    # home_sessions hat charged_kwh (Wall). TM-Home hat energy_kwh (Akku).
    # WICHTIG: TeslaMate hat oft Datenluecken (Auto offline). Dann ist
    # tm_home_added << home_kwh und die Differenz ist KEINE Verlust, sondern
    # eine fehlende TM-Ladung. Verlust daher nur ansetzen, wenn TM die EVCC-
    # Wandmenge zu >=70% abdeckt (sonst Datenluecke -> keine Aussage, loss=0).
    # Nutzt die gleiche Erkennung wie fuer ext-Filterung (_tm_is_home).
    tm_home_rows = [r for r in ext_all if _tm_is_home(r)]
    tm_home_added = sum(float(r.get("energy_kwh") or 0) for r in tm_home_rows)
    tm_home_used = sum(float(r.get("energy_used_kwh") or r.get("energy_kwh") or 0) for r in tm_home_rows)
    home_loss = 0.0
    if home_kwh > 0 and tm_home_used > 0:
        used_cov = tm_home_used / home_kwh
        if 0.70 <= used_cov <= 1.30:
            loss = home_kwh - tm_home_used      # Wand(EVCC) - Wand(TM used) -> wall-to-wall
            loss_pct = loss / home_kwh if home_kwh > 0 else 0
            if -0.05 <= loss_pct <= 0.35:       # erlauben kleiner negativer Werte (Messungenauigkeit)
                home_loss = round(loss, 2)

    netto_is_estimate = True
    if home_loss > 0 and consumption_bruto > 0:
        real_netto = consumption_bruto * (1 - (home_loss / home_kwh if home_kwh > 0 else ESTIMATED_LOSS_FACTOR))
        consumption_netto = real_netto if real_netto > 0 else consumption_bruto * (1 - ESTIMATED_LOSS_FACTOR)
        netto_is_estimate = False
    else:
        consumption_netto = consumption_bruto * (1 - ESTIMATED_LOSS_FACTOR) if consumption_bruto else 0

    # --- Monatliche Aggregate ---
    monthly = {}
    for r in home:
        m = (r.get("created") or "")[:7]
        agg = monthly.setdefault(m, {"home_kwh": 0, "home_cost": 0, "ext_kwh": 0, "ext_cost": 0, "extra": 0})
        agg["home_kwh"] += float(r.get("charged_kwh") or 0)
        agg["home_cost"] += compute_home_cost_row(r, price_lookup)["total_cost"]
    for r in ext:
        m = (r.get("started_at") or "")[:7]
        agg = monthly.setdefault(m, {"home_kwh": 0, "home_cost": 0, "ext_kwh": 0, "ext_cost": 0, "extra": 0})
        agg["ext_kwh"] += float(r.get("energy_kwh") or 0)
        agg["ext_cost"] += float(r.get("cost_total") or 0)
    for e in extras:
        m = (e.get("date") or "")[:7]
        agg = monthly.setdefault(m, {"home_kwh": 0, "home_cost": 0, "ext_kwh": 0, "ext_cost": 0, "extra": 0})
        agg["extra"] += float(e.get("amount") or 0)
    monthly_list = []
    for m in sorted(monthly.keys()):
        a = monthly[m]
        monthly_list.append({
            "month": m,
            "home_kwh": round(a["home_kwh"], 2),
            "home_cost": round(a["home_cost"], 2),
            "ext_kwh": round(a["ext_kwh"], 2),
            "ext_cost": round(a["ext_cost"], 2),
            "extra": round(a["extra"], 2),
            "total_kwh": round(a["home_kwh"] + a["ext_kwh"], 2),
            "total_cost": round(a["home_cost"] + a["ext_cost"] + a["extra"], 2),
        })

    # ---- Monats-Daten-Auszug für statik.html KPIs ----
    # Extrahiere aktuellen Monat für statik.html KPIs (month metric = YYYY-MM)
    current_month = datetime.now().strftime("%Y-%m")
    # Monat-KPIs für statik.html: berechne Energie und Kosten pro Woche
    home_this_month = 0
    home_cost_this_month = 0
    ext_this_month = 0
    ext_cost_this_month = 0
    extra_this_month = 0

    # Durchlaufe alle Daten und aggregiere nur für den aktuellen Monat
    for r in home:
        m = (r.get("created") or "")[:7]
        if m == current_month:
            home_this_month += float(r.get("charged_kwh") or 0)
            home_cost_this_month += compute_home_cost_row(r, price_lookup)["total_cost"]

    for r in ext:
        m = (r.get("started_at") or "")[:7]
        if m == current_month:
            ext_this_month += float(r.get("energy_kwh") or 0)
            ext_cost_this_month += float(r.get("cost_total") or 0)

    for e in extras:
        m = (e.get("date") or "")[:7]
        if m == current_month:
            extra_this_month += float(e.get("amount") or 0)

    # PV-Anteil für statik.html (durchschnittlicher PV-Anteil für den gesamten Zeitraum)
    total_pv_kwh = home_pv_kwh
    pv_share_pct = round((total_pv_kwh / home_kwh * 100) if home_kwh > 0 else 0, 1)

    # ----- KPIs für API ---------
    stats = {
        "kpis": {
            'charged_total_kwh': round(total_kwh, 2),
            'total_cost': round(total_cost, 2),
            'total_km': round(total_km, 1),
            'avg_consumption': avg_consumption,
            'avg_cost_100': avg_cost_100,
            'avg_co2': avg_co2,
            'avg_price_kwh': avg_price_kwh,
            'ac_kwh': round(total_ac, 2),
            'dc_kwh': round(total_dc, 2),
            'dc_share_pct': round((total_dc / total_kwh * 100) if total_kwh > 0 else 0, 1),
            'charging_loss_kwh': total_charging_loss,
            'charging_loss_pct': round((total_charging_loss / total_kwh * 100) if total_kwh > 0 else 0, 1),
            'last_range': last_range,
            'total_kwh': round(total_kwh, 2),
            'home_kwh': round(home_kwh, 2),
            'ext_kwh': round(ext_kwh, 2),
            'home_loss_kwh': home_loss,
            'cost_home': round(home_cost, 2),
            'cost_external': round(ext_cost, 2),
            'cost_extra': round(extra_total, 2),
            'cost_home_and_external': round(home_cost + ext_cost, 2),
            'tco': round(tco, 2),
            'tco_per_100km': round(tco_per_100km, 2),
            'tco_with_extras': round(tco_with_extras, 2),
            'tco_without_extras': round(tco_without_extras, 2),
            'consumption_net_kwh_per_100km': round(consumption_netto, 2),
            # Monatliche KPIs (für statik.html)
            'cost_this_month': round(home_cost_this_month + ext_cost_this_month + extra_this_month, 2),
            'total_kwh_month': round(home_this_month + ext_this_month, 2),
            'month': current_month,
            'pv_share_pct': pv_share_pct,
            'consumption_kwh_per_100km': round(consumption_bruto, 2),
        },
        "series": [],  # (Tages-Series in app.build_stats ergänzt)
        "totals": {
            "kwh": round(total_kwh, 2),
            "home_kwh": round(home_kwh, 2),
            "ext_kwh": round(ext_kwh, 2),
            "cost_home": round(home_cost, 2),
            "cost_external": round(ext_cost, 2),
            "cost_home_and_external": round(home_cost + ext_cost, 2),
            "cost_extra": round(extra_total, 2),
            "tco_without_extras": round(home_cost + ext_cost, 2),
            "tco_with_extras": round(home_cost + ext_cost + extra_total, 2),
            "tco": round(tco, 2),
            "tco_per_100km": round(tco_per_100km, 2),
            "distance_km": round(total_km_odo, 1),
            "total_km": round(total_dist, 1),  # Summe Tageskilometer aus Drives
            "cost_per_km": round(cost_per_km, 3),
            "consumption_kwh_per_100km": round(consumption_bruto, 2),
            "consumption_net_kwh_per_100km": round(consumption_netto, 2),
            "netto_is_estimate": netto_is_estimate,
            "home_loss_kwh": round(home_loss, 2),
        },
        "monthly": monthly_list,
        "plausibility": {"home_loss_kwh": round(home_loss, 2), "netto_is_estimate": netto_is_estimate},
    }

    return stats