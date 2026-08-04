// CarTankLogger Dashboard JS - Neue Version mit korrigierten IDs
let currentDays = 365;
let customFrom = null;   // YYYY-MM-DD oder null
let customTo = null;
let charts = {};

function _statsUrl() {
  if (customFrom && customTo) {
    return `/api/stats?from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
  }
  return `/api/stats?days=${currentDays}`;
}

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  if (customFrom && customTo) {
    el.textContent = `${customFrom} bis ${customTo}`;
  } else if (currentDays >= 9999) {
    el.textContent = "Alle Daten";
  } else {
    el.textContent = `Letzte ${currentDays} Tage`;
  }
}

const fmtEUR = (v) => (v == null || v === "" || isNaN(Number(v)) ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"}));
const fmtKwh = (v) => (v == null || v === "" || isNaN(Number(v)) ? "–" : Number(v).toLocaleString("de-DE", {minimumFractionDigits:1, maximumFractionDigits:1}) + " kWh");
const fmtPct = (v) => (v == null || v === "" || isNaN(Number(v)) ? "–" : Number(v).toLocaleString("de-DE", {maximumFractionDigits:1}) + " %");
// Deutsche Datumsanzeige TT.MM.JJJJ (Punkt 13). Akzeptiert ISO-Strings,
// Date-Objekte oder schon formatierte Werte.
function fmtDateDE(v) {
  if (v == null || v === "") return "–";
  let s = String(v).trim();
  // Zeitanteil abschneiden (2026-07-02T00:00:00 -> 2026-07-02)
  if (s.includes("T")) s = s.split("T")[0];
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s; // schon anders formatiert -> unveraendert
}
// Zahl sicher auf n Nachkommastellen runden (auch bei String-Eingabe).
function num(v, n = 2) {
  const x = Number(v);
  return isNaN(x) ? "–" : x.toLocaleString("de-DE", {minimumFractionDigits:n, maximumFractionDigits:n});
}

function _rangeParams() {
  if (customFrom && customTo) {
    return `from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
  }
  return `days=${currentDays}`;
}

async function loadAll() {
  // Jeder Fetch einzeln abgesichert: ein API-Fehler darf nicht die
  // gesamte Anzeige leeren.
  const rp = _rangeParams();
  async function safeJson(url, fallback) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(url + " -> " + r.status);
      return await r.json();
    } catch (e) {
      console.error("loadAll fetch fehlgeschlagen:", e);
      return fallback;
    }
  }

  const stats = await safeJson(`/api/stats?${rp}`, {totals:{}, home:{}, external:{}, extra:{}});
  const sess  = await safeJson(`/api/sessions?${rp}`, {home:[], external:[]});
  const merged = await safeJson(`/api/merged?${rp}`, []);
  const trip  = await safeJson(`/api/roadtrip?${rp}`, {per_day:[], stops:[]});
  const chartData = await safeJson(`/api/charts?${rp}`, {});
  const statData = await safeJson(`/api/statistics?${rp}`, {});
  const socData = await safeJson(`/api/soc?${rp}`, {});
  const dailyKm = await safeJson(`/api/daily-km?${rp}`, {days:[], summary:{}});
  __chartData = chartData;
  __statsData = stats;
  __statData = statData;
  try { renderSummary(stats); } catch(e){ console.error("renderSummary", e); }
  try { renderCharts(stats); } catch(e){ console.error("renderCharts", e); }
  try { renderHome(sess.home); } catch(e){ console.error("renderHome", e); }
  try { renderExt(sess.external); } catch(e){ console.error("renderExt", e); }
  try { renderMerged(merged, trip.per_day || [], stats.totals || {}); } catch(e){ console.error("renderMerged", e); }
  try { renderRoadtrip(trip); } catch(e){ console.error("renderRoadtrip", e); }
  try { renderStats(chartData); } catch(e){ console.error("renderStats", e); }
  try { renderStatistics(statData); } catch(e){ console.error("renderStatistics", e); }
  try { renderSocCharts(socData); } catch(e){ console.error("renderSocCharts", e); }
  try { renderDailyKm(dailyKm); } catch(e){ console.error("renderDailyKm", e); }
  try { renderExtra(); } catch(e){ console.error("renderExtra", e); }
}

function renderSummary(s) {
  const t = s.totals || {}, h = s.home || {}, e = s.external || {}, x = s.extra || {};
  const monthly = s.monthly || [];
  const curMonth = monthly.length ? monthly[monthly.length - 1] : null;
  const costThisMonth = curMonth ? (curMonth.home_cost + curMonth.ext_cost + curMonth.extra) : 0;

  const homeKwh = t.home_kwh || 0;
  const extKwh = t.ext_kwh || 0;
  const homeShare = (homeKwh + extKwh) > 0 ? Math.round(homeKwh / (homeKwh + extKwh) * 100) : 0;
  const tco = t.tco || 0;

  // P1.2: 8 Kern-Entscheidungs-KPIs (Kosten -> Nutzung -> Effizienz -> Quellen)
  // Jede Kachel mit Tooltip (title) zur Berechnung.
  const cards = [
    {icon:"💶", t:"Gesamtkosten", v:fmtEUR(tco + (x.extra_total||0)), s:`Laden + Extra-Kosten im Zeitraum`, c:"success",
     tip:"Laden (Zuhause+Extern) plus alle Extra-Kosten (Anschaffung, Versicherung, Steuer, Service, Zubehör) im gewählten Zeitraum."},
    {icon:"💡", t:"Kosten / 100 km", v:fmtEUR(t.tco_per_100km)+" /100km", s:`TCO ${fmtEUR(tco)}`, c:"warning",
     tip:"Gesamtkosten durch gefahrene km × 100. Die wichtigste Alltagskennzahl: was dich jedes gefahrene 100-km-Stück wirklich kostet."},
    {icon:"🛣️", t:"Gefahrene km", v:Number(t.distance_km||0).toLocaleString("de-DE")+" km", s:"aus TeslaMate-Fahrten", c:"secondary",
     tip:"Summe der gefahrenen km aus TeslaMate-Drives im Zeitraum (echte Fahrten, nicht Tacho-Differenz)."},
    {icon:"⚡", t:"Geladene kWh", v:fmtKwh(t.kwh), s:`Zuhause ${fmtKwh(homeKwh)} · Extern ${fmtKwh(extKwh)}`, c:"primary",
     tip:"Gesamte geladene Energie im Zeitraum, aufgeteilt nach Zuhause (Wallbox) und Extern (Supercharger/öffentlich)."},
    {icon:"🔋", t:"Verbrauch", v:fmtKwh(t.consumption_kwh_per_100km)+" /100km", s:`Akku ≈ ${fmtKwh(t.consumption_net_kwh_per_100km)} (geschätzt)`, c:"info",
     tip:"Durchschnittsverbrauch kWh/100km ab Wand (brutto). 'Akku' ist der geschätzte Netto-Verbrauch ab Batterie (~15% Ladeverlust abgezogen)."},
    {icon:"☀️", t:"PV-Anteil", v:fmtPct(h.pv_share_pct), s:`${fmtKwh(h.pv_kwh||0)} PV von ${fmtKwh(homeKwh)}`, c:"success",
     tip:"Anteil des Zuhause-Stroms, der aus eigener PV kam. Höher = günstiger und grüner geladen."},
    {icon:"🏠", t:"Zuhause vs. Extern", v:`${homeShare} % Zuhause`, s:`${fmtKwh(homeKwh)} zu Hause · ${fmtKwh(extKwh)} extern`, c:"primary",
     tip:"Anteil der geladenen Energie, der zu Hause (Wallbox) geladen wurde. Extern = Fremdladung (teurer)."},
    {icon:"🔌", t:"Ø Preis / kWh", v:fmtEUR(t.avg_price_per_kwh)+" /kWh", s:"Mischpreis alle Ladevorgänge", c:"dark",
     tip:"Gewichteter Durchschnittspreis über alle Ladevorgänge (Zuhause-Stromkosten + Extern-Preise), gewichtet nach geladener kWh."},
  ];
  document.getElementById("kpiCards").innerHTML = cards.map(c => `
    <div class="col-6 col-md-4 col-lg-3">
      <div class="card kpi-card text-white bg-${c.c} h-100" ${c.tip ? `title="${c.tip}"` : ""}>
        <div class="card-body py-2">
          <div class="kpi-label opacity-75"><span class="kpi-icon">${c.icon}</span> ${c.t}</div>
          <div class="kpi-value">${c.v}</div>
          <div class="kpi-sub">${c.s}</div>
        </div>
      </div>
    </div>`).join("");
}

function renderCharts(s) {
  const h = s.home, e = s.external, x = s.extra;
  const srcEl = document.getElementById("sourcePieChart");
  const monEl = document.getElementById("mainChart");
  // Source-Daten global merken, damit drawSourceChart() sie auch im
  // Statistik-Tab zeichnen kann (chartSource liegt jetzt dort).
  window.__sourceData = { grid: h.grid_kwh || 0, pv: h.pv_kwh || 0, ext: e.kwh || 0 };
  if (!srcEl || !monEl || !window.Chart) return;
  if (srcEl.clientWidth === 0 && srcEl.offsetParent === null) return; // Tab verborgen
  // Source donut
  const srcData = [h.grid_kwh, h.pv_kwh, e.kwh];
  if (charts.source) charts.source.destroy();
  charts.source = new Chart(srcEl, {
    type: "doughnut",
    data: { labels: ["Zuhause Netz", "Zuhause PV", "Extern"],
      datasets: [{ data: srcData, backgroundColor: ["#0d6efd","#198754","#0dcaf0"] }]},
    options: { plugins: { legend: { position: "bottom" } } }
  });
  // Monthly stacked
  const m = s.monthly || [];
  if (charts.monthly) charts.monthly.destroy();
  if (!m.length) {
    // Kein Monats-Aggregat vorhanden -> Chart nicht zeichnen (kein Crash)
    if (monEl) monEl.innerHTML = '<div class="text-muted small p-2">Keine Monatsdaten verfügbar</div>';
  } else {
    charts.monthly = new Chart(monEl, {
    type: "bar",
    data: { labels: m.map(d=>d.month),
      datasets: [
        { label:"Zuhause", data: m.map(d=>d.home_cost), backgroundColor:"#198754" },
        { label:"Extern", data: m.map(d=>d.ext_cost), backgroundColor:"#0dcaf0" },
        { label:"Extra", data: m.map(d=>d.extra), backgroundColor:"#ffc107" },
      ]},
    options: { plugins:{legend:{position:"bottom"}}, scales:{ x:{stacked:true}, y:{stacked:true} } }
  });
  }
}

// Energie nach Quelle (Donut) – unabhaengig vom Tab zeichnen
function drawSourceChart() {
  const sd = window.__sourceData;
  const srcEl = document.getElementById("sourcePieChart");
  if (!srcEl || !window.Chart || !sd) return;
  if (srcEl.clientWidth === 0 && srcEl.offsetParent === null) {
    requestAnimationFrame(drawSourceChart);
    return;
  }
  if (charts.source) charts.source.destroy();
  charts.source = new Chart(srcEl, {
    type: "doughnut",
    data: { labels: ["Zuhause Netz", "Zuhause PV", "Extern"],
      datasets: [{ data: [sd.grid, sd.pv, sd.ext], backgroundColor: ["#0d6efd","#198754","#0dcaf0"] }]},
    options: { plugins: { legend: { position: "bottom" } } }
  });
}