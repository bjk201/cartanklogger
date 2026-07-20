// CarTankLogger Dashboard JS
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

const fmtEUR = (v) => (v == null ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"}));
const fmtKwh = (v) => (v == null ? "–" : Number(v).toLocaleString("de-DE", {minimumFractionDigits:1, maximumFractionDigits:1}) + " kWh");
const fmtPct = (v) => (v == null ? "–" : Number(v).toLocaleString("de-DE", {maximumFractionDigits:1}) + " %");

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
  try { renderExtra(); } catch(e){ console.error("renderExtra", e); }
}

function renderSummary(s) {
  const t = s.totals || {}, h = s.home || {}, e = s.external || {}, x = s.extra || {};
  const monthly = s.monthly || [];
  // Kosten diesen Monat = letzter (aktuellster) Monat in der Monatsliste
  const curMonth = monthly.length ? monthly[monthly.length - 1] : null;
  const costThisMonth = curMonth ? (curMonth.home_cost + curMonth.ext_cost + curMonth.extra) : 0;

  // Zuhause vs. Extern: Anteil an geladener Energie
  const homeKwh = t.home_kwh || 0;
  const extKwh = t.ext_kwh || 0;
  const homeShare = (homeKwh + extKwh) > 0 ? Math.round(homeKwh / (homeKwh + extKwh) * 100) : 0;

  const cards = [
    {icon:"💶", t:"Kosten diesen Monat", v:fmtEUR(costThisMonth), s:curMonth ? curMonth.month : "–", c:"success"},
    {icon:"⚡", t:"Geladene Energie", v:fmtKwh(t.kwh), s:`Zuhause ${fmtKwh(homeKwh)} · Extern ${fmtKwh(extKwh)}`, c:"primary"},
    {icon:"🛣️", t:"Gefahrene km", v:Number(t.distance_km||0).toLocaleString("de-DE")+" km", s:"Tacho-Stand (max)", c:"secondary"},
    {icon:"💡", t:"Kosten / 100 km", v:fmtEUR(t.tco_per_100km)+" /100km", s:`TCO ${fmtEUR(t.tco)}`, c:"warning"},
    {icon:"🔋", t:"Verbrauch", v:fmtKwh(t.consumption_kwh_per_100km)+" /100km", s:`Akku ≈ ${fmtKwh(t.consumption_net_kwh_per_100km)} (geschätzt)`, c:"info"},
    {icon:"☀️", t:"PV-Anteil", v:fmtPct(h.pv_share_pct), s:`${fmtKwh(h.pv_kwh||0)} PV von ${fmtKwh(homeKwh)}`, c:"success"},
    {icon:"🏠", t:"Zuhause vs. Extern", v:`${homeShare} % Zuhause`, s:`${fmtKwh(homeKwh)} zu Hause · ${fmtKwh(extKwh)} extern`, c:"primary"},
    {icon:"🔌", t:"Ladeverluste", v:fmtKwh(t.home_loss_kwh), s:"Wallbox → Akku (Differenz)", c:"dark"},
  ];
  document.getElementById("summaryCards").innerHTML = cards.map(c => `
    <div class="col-6 col-md-4 col-lg-3">
      <div class="card kpi-card text-white bg-${c.c} h-100">
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
  const srcEl = document.getElementById("chartSource");
  const monEl = document.getElementById("chartMonthly");
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

function renderHome(rows) {
  const tb = document.querySelector("#tblHome tbody");
  tb.innerHTML = rows.map(r => `<tr data-id="${r.id}">
    <td>${r.created ? r.created.slice(0,10) : "–"}</td>
    <td>${r.loadpoint||""}</td><td>${r.vehicle||""}</td>
    <td>${fmtKwh(r.charged_kwh)}</td><td>${fmtPct(r.solar_percentage)}</td>
    <td>${fmtKwh(r.grid_kwh)}</td><td>${fmtKwh(r.pv_kwh)}</td>
    <td>${fmtEUR(r.grid_cost)}</td><td>${fmtEUR(r.pv_cost)}</td>
    <td>${fmtEUR(r.total_cost)}</td><td>${r.price_per_kwh||""}</td>
    <td>${r.odometer!=null?Number(r.odometer).toLocaleString("de-DE"):"–"}</td>
    <td>
      <button class="btn btn-sm btn-outline-secondary editBtn" data-type="home" data-id="${r.id}">✏️</button>
      <button class="btn btn-sm btn-outline-danger delBtn" data-type="home" data-id="${r.id}" title="Löschen">🗑️</button>
    </td>
  </tr>`).join("");
}

function renderMerged(rows, perDay, totals) {
  // --- KPI-Kacheln (wichtigste Infos auf einen Blick) ---
  const days = rows.length;
  const totKwh = rows.reduce((a, r) => a + (r.total_kwh || 0), 0);
  const totCost = rows.reduce((a, r) => a + (r.total_cost || 0), 0);
  const totKm = (perDay || []).reduce((a, d) => a + (d.km || 0), 0);
  const extKwh = rows.reduce((a, r) => a + (r.ext_kwh || 0), 0);
  const homeLoss = rows.reduce((a, r) => a + (r.home_loss || 0), 0);
  const cons = totKm > 0 ? totKwh / (totKm / 100) : 0;
  const consNet = cons * (1 - 0.15); // ~15% Ladeverluste -> Akku (≈ Tesla)
  const tco = (totals && totals.tco) || 0;
  const tco100 = (totals && totals.tco_per_100km) || 0;
  document.getElementById("mergedKpis").innerHTML = [
    kpiStat("🛣️ Gefahrene km", `${Math.round(totKm).toLocaleString("de-DE")} km`),
    kpiStat("⚡ Geladene kWh", `${totKwh.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`),
    kpiStat("💶 Ausgaben (Energie)", fmtEUR(totCost)),
    kpiStat("💰 TCO gesamt", fmtEUR(tco), `inkl. Anschaffung/Versicherung/Steuer`),
    kpiStat("💡 TCO / 100km", `${tco100.toLocaleString("de-DE", {minimumFractionDigits:2})} €`),
    kpiStat("🔋 Ø Verbrauch", `${cons.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh/100km`, `von der Wand · Akku ≈ ${consNet.toLocaleString("de-DE", {minimumFractionDigits:1})}`),
    kpiStat("🔌 Extern", `${extKwh.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`),
    kpiStat("📉 Ladeverlust", `${homeLoss.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`),
  ].join("");

  // --- Tages-Balkendiagramm km + kWh ---
  const mergedChartDay = (perDay || []).slice().reverse();
  const labels = mergedChartDay.map(d => d.day);
  if (window.Chart) {
    if (window.__mergedDayChart) window.__mergedDayChart.destroy();
    const ctx = document.getElementById("mergedDayChart");
    if (ctx) {
      window.__mergedDayChart = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "km", data: mergedChartDay.map(d => d.km), backgroundColor: "#6f42c1", yAxisID: "y" },
            { label: "kWh", data: mergedChartDay.map(d => d.kwh), backgroundColor: "#198754", yAxisID: "y1" },
          ],
        },
        options: {
          responsive: true,
          scales: {
            y: { position: "left", title: { display: true, text: "km" } },
            y1: { position: "right", title: { display: true, text: "kWh" }, grid: { drawOnChartArea: false } },
          },
        },
      });
    }
  }

  // --- Tabelle ---
  const tb = document.querySelector("#tblMerged tbody");
  tb.innerHTML = rows.map((r, i) => {
    // Aufklapp-Detail: Zuhause (EVCC einzeln + TM-Zuhause) und Extern getrennt
    let detail = '<div class="row"><div class="col-md-6">';
    detail += '<strong>🏠 Zuhause</strong><ul class="mb-2 ps-3">';
    const tmHomeKwh = (r.tm_home || []).reduce((a, t) => a + (t.added || 0), 0);
    if (r.evcc && r.evcc.length) {
      for (const e of r.evcc) {
        detail += `<li>EVCC ${e.created ? e.created.slice(11,16) : ""} · ${fmtKwh(e.charged_kwh)} · ${fmtEUR(e.total_cost)} · PV ${fmtPct(e.solar_percentage)}</li>`;
      }
    }
    if (r.tm_home && r.tm_home.length) {
      for (const t of r.tm_home) {
        detail += `<li class="text-muted">TeslaMate ${t.label || t.address || ""}: added ${fmtKwh(t.added)} / used ${fmtKwh(t.used)} → Verlust ${fmtKwh(t.used - t.added)} (${t.n_frags} Teil-Lad.)</li>`;
      }
    }
    if (!(r.evcc && r.evcc.length) && !(r.tm_home && r.tm_home.length)) detail += "<li>–</li>";
    detail += '</ul></div><div class="col-md-6">';
    detail += '<strong>🔌 Extern</strong><ul class="mb-0 ps-3">';
    if (r.tm_ext && r.tm_ext.length) {
      for (const t of r.tm_ext) {
        detail += `<li>${t.label || t.address || "Extern"} ${t.start ? t.start.slice(11,16) : ""}–${t.end ? t.end.slice(11,16) : ""}: ${fmtKwh(t.added)} · ${fmtEUR(t.cost)} (${t.n_frags} Teil-Lad.)</li>`;
      }
    } else {
      detail += "<li>–</li>";
    }
    detail += "</ul></div></div>";

    // Badges: Zuhause + Extern klar getrennt, nur wenn an dem Tag auch wirklich was da ist
    const stationBadges = [];
    if ((r.evcc && r.evcc.length) || (r.tm_home && r.tm_home.length)) {
      stationBadges.push('<span class="badge bg-success me-1">🏠 Zuhause</span>');
    }
    if (r.tm_ext && r.tm_ext.length) {
      const extNames = [...new Set((r.tm_ext || []).map(t => t.label || t.address || "Extern"))];
      for (const n of extNames) {
        stationBadges.push(`<span class="badge bg-warning text-dark me-1">🔌 ${n}</span>`);
      }
    }
    const badgeHtml = stationBadges.join(" ") || '<span class="badge bg-secondary">–</span>';

    // Zuhause-kWh fuer die Spalte: EVCC fuehrend (Wallbox misst exakt, was
    // aus der Wand ging). TM-Zuhause ist DIESELBE Ladung wie EVCC (nur aus
    // zweiter Quelle erfasst) -> NICHT dazuzaehlen (Doppelzaehlung!). Nur wenn
    // an dem Tag UEBERHAUPT kein EVCC da ist, TM added als Fallback zeigen.
    const evKwh = r.home_kwh || 0;
    const homeKwhShown = evKwh > 0 ? evKwh
                         : (r.tm_home && r.tm_home.length ? tmHomeKwh : 0);

    return `<tr>
      <td>${r.day || "–"}</td>
      <td>${badgeHtml}</td>
      <td>${fmtKwh(homeKwhShown)}</td>
      <td>${fmtEUR(r.home_cost || 0)}</td>
      <td>${homeKwhShown > 0 ? fmtPct(r.home_solar_pct) : "–"}</td>
      <td>${r.home_loss ? fmtKwh(r.home_loss) : "–"}</td>
      <td>${r.ext_kwh > 0 ? fmtKwh(r.ext_kwh) : "–"}</td>
      <td>${r.ext_kwh > 0 ? fmtEUR(r.ext_cost) : "–"}</td>
      <td><strong>${fmtKwh(r.total_kwh)}</strong></td>
      <td><strong>${fmtEUR(r.total_cost)}</strong></td>
      <td><button class="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="collapse" data-bs-target="#m${i}">▾</button></td>
    </tr>
    <tr class="collapse-row"><td colspan="11" class="p-0">
      <div class="collapse" id="m${i}"><div class="p-2 bg-light">${detail}</div></div>
    </td></tr>`;
  }).join("");
}

function renderExt(rows) {
  const tb = document.querySelector("#tblExt tbody");
  const srcBadge = (r) => {
    if (r.cost_total > 0 && r.manual_price == 1) return '<span class="badge bg-success">manuell</span>';
    if (r.cost_total > 0) return '<span class="badge bg-secondary">TeslaMate</span>';
    return '<span class="badge bg-warning text-dark">fehlt</span>';
  };
  tb.innerHTML = rows.map(r => `<tr data-id="${r.id}">
    <td>${r.started_at ? r.started_at.slice(0,10) : "–"}</td>
    <td>${r.location_name||r.address||""}</td><td>${r.provider||""}</td>
    <td>${fmtKwh(r.energy_kwh)}</td>
    <td class="cost">${fmtEUR(r.cost_total)}</td><td>${r.price_per_kwh||""}</td>
    <td>${r.odometer_start!=null?Number(r.odometer_start).toLocaleString("de-DE"):"–"}</td>
    <td>${srcBadge(r)}</td>
    <td>
      <button class="btn btn-sm btn-outline-secondary editBtn" data-type="external" data-id="${r.id}">✏️</button>
      <button class="btn btn-sm btn-outline-danger delBtn" data-type="external" data-id="${r.id}" title="Löschen">🗑️</button>
    </td>
  </tr>`).join("");
}


async function renderExtra() {
  const tb = document.querySelector("#tblExtra tbody");
  if (!tb) return;
  let rows = [];
  try {
    const r = await fetch(`/api/extra-costs`);
    if (!r.ok) throw new Error("extra-costs -> " + r.status);
    rows = await r.json();
  } catch (e) {
    console.error("renderExtra fetch fehlgeschlagen:", e);
    tb.innerHTML = '<tr><td colspan="6" class="text-danger small">Extra-Kosten konnten nicht geladen werden.</td></tr>';
    return;
  }
  const labels = {purchase:"Anschaffung", service:"Service", accessory:"Zubehör", insurance:"Versicherung", tax:"Steuer", other:"Sonstiges"};
  tb.innerHTML = (rows || []).map(r => `<tr data-id="${r.id}">
    <td>${r.date||""}</td><td>${labels[r.category]||r.category}</td>
    <td>${r.description||""}</td><td>${fmtEUR(r.amount)}</td>
    <td>${r.odometer!=null?Number(r.odometer).toLocaleString("de-DE"):"–"}</td>
    <td>
      <button class="btn btn-sm btn-outline-secondary editBtn" data-type="extra" data-id="${r.id}">✏️</button>
      <button class="btn btn-sm btn-outline-danger delBtn" data-type="extra" data-id="${r.id}" title="Löschen">🗑️</button>
    </td>
  </tr>`).join("");
}

// ---------------------------------------------------------------------------
// Bearbeiten-Drawer (Offcanvas) + CSRF
// ---------------------------------------------------------------------------
const EDIT_SCHEMAS = {
  home: {
    title: "Zuhause-Ladung (EVCC) bearbeiten",
    endpoint: id => `/api/home-sessions/${id}`,
    fields: [
      {key:"created", label:"Erstellt (Datum/Zeit)", type:"datetime-local", src:"created"},
      {key:"finished", label:"Beendet (Datum/Zeit)", type:"datetime-local", src:"finished"},
      {key:"odometer", label:"KM-Stand", type:"number", step:"0.1", src:"odometer"},
      {key:"vehicle", label:"Fahrzeug", type:"text", src:"vehicle"},
      {key:"loadpoint", label:"Ladepunkt", type:"text", src:"loadpoint"},
      {key:"solar_percentage", label:"PV-Anteil (%)", type:"number", step:"0.1", src:"solar_percentage"},
      {key:"note", label:"Notiz", type:"text", src:"note"},
    ],
  },
  external: {
    title: "Externe Ladung (TeslaMate) bearbeiten",
    endpoint: id => `/api/external/${id}`,
    fields: [
      {key:"started_at", label:"Beginn (Datum/Zeit)", type:"datetime-local", src:"started_at"},
      {key:"finished_at", label:"Ende (Datum/Zeit)", type:"datetime-local", src:"finished_at"},
      {key:"address", label:"Adresse", type:"text", src:"address"},
      {key:"provider", label:"Anbieter", type:"text", src:"provider"},
      {key:"energy_kwh", label:"Energie (kWh)", type:"number", step:"0.01", src:"energy_kwh"},
      {key:"odometer_start", label:"KM-Stand", type:"number", step:"0.1", src:"odometer_start"},
      {key:"cost_total", label:"Kosten gesamt (€)", type:"number", step:"0.01", src:"cost_total"},
      {key:"price_per_kwh", label:"€/kWh (optional)", type:"number", step:"0.0001", src:"price_per_kwh"},
      {key:"manual_price", label:"Manueller Preis", type:"checkbox", src:"manual_price"},
      {key:"note", label:"Notiz", type:"text", src:"note"},
    ],
  },
  extra: {
    title: "Extra-Kosten bearbeiten",
    endpoint: id => `/api/extra-costs/${id}`,
    fields: [
      {key:"date", label:"Datum", type:"date", src:"date"},
      {key:"category", label:"Kategorie", type:"select", options:["purchase","service","accessory","insurance","tax","other"], src:"category"},
      {key:"description", label:"Beschreibung", type:"text", src:"description"},
      {key:"amount", label:"Betrag (€)", type:"number", step:"0.01", src:"amount"},
      {key:"odometer", label:"KM-Stand", type:"number", step:"0.1", src:"odometer"},
      {key:"note", label:"Notiz", type:"text", src:"note"},
    ],
  },
};

function toLocalInput(iso) {
  if (!iso) return "";
  // ISO -> input[type=datetime-local] (YYYY-MM-DDTHH:MM)
  return String(iso).slice(0, 16);
}

async function openEdit(type, id) {
  const schema = EDIT_SCHEMAS[type];
  if (!schema) return;
  // Aktuellen Datensatz laden
  let row = {};
  if (type === "home") {
    const all = await (await fetch(`/api/sessions`)).json();
    row = (all.home || []).find(r => r.id == id) || {};
  } else if (type === "external") {
    const all = await (await fetch(`/api/sessions`)).json();
    row = (all.external || []).find(r => r.id == id) || {};
  } else if (type === "extra") {
    const all = await (await fetch(`/api/extra-costs`)).json();
    row = (all || []).find(r => r.id == id) || {};
  }

  document.getElementById("editDrawerTitle").textContent = schema.title;
  document.getElementById("editId").value = id;
  document.getElementById("editType").value = type;
  const fieldsEl = document.getElementById("editFields");
  fieldsEl.innerHTML = schema.fields.map(f => {
    const val = row[f.src] ?? "";
    let control;
    if (f.type === "select") {
      const opts = f.options.map(o => `<option value="${o}" ${o===val?"selected":""}>${o}</option>`).join("");
      control = `<select class="form-select form-select-sm" id="f_${f.key}">${opts}</select>`;
    } else if (f.type === "checkbox") {
      control = `<input class="form-check-input" type="checkbox" id="f_${f.key}" ${val?"checked":""}>`;
    } else if (f.type === "datetime-local") {
      control = `<input class="form-control form-control-sm" type="datetime-local" id="f_${f.key}" value="${toLocalInput(val)}">`;
    } else if (f.type === "date") {
      control = `<input class="form-control form-control-sm" type="date" id="f_${f.key}" value="${String(val).slice(0,10)}">`;
    } else {
      control = `<input class="form-control form-control-sm" type="${f.type}" id="f_${f.key}" value="${val}" ${f.step?`step="${f.step}"`:""}>`;
    }
    return `<div class="mb-2"><label class="form-label small mb-1">${f.label}</label>${control}</div>`;
  }).join("");

  // Datenherkunft anzeigen
  const meta = document.getElementById("editMeta");
  const flags = [];
  if (row.source) flags.push(`Quelle: ${row.source}`);
  if (row.manually_edited) flags.push("manuell bearbeitet");
  else flags.push("importiert");
  if (row.updated_at) flags.push(`geändert am ${toLocalInput(row.updated_at).replace("T"," ")}`);
  if (row.has_raw) flags.push("Original-Rohdaten erhalten");
  meta.innerHTML = flags.join(" · ");

  document.getElementById("editDrawerError").classList.add("d-none");
  const drawer = bootstrap.Offcanvas.getOrCreateInstance(document.getElementById("editDrawer"));
  drawer.show();
}

function collectEditValues(type) {
  const schema = EDIT_SCHEMAS[type];
  const out = {};
  for (const f of schema.fields) {
    const el = document.getElementById(`f_${f.key}`);
    if (!el) continue;
    if (f.type === "checkbox") {
      out[f.key] = el.checked ? 1 : 0;
    } else if (f.type === "number") {
      out[f.key] = el.value === "" ? null : parseFloat(el.value);
    } else if (f.type === "datetime-local") {
      out[f.key] = el.value ? el.value.replace("T", " ") + ":00" : null;
    } else {
      out[f.key] = el.value;
    }
  }
  return out;
}

document.getElementById("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = document.getElementById("editType").value;
  const id = document.getElementById("editId").value;
  const schema = EDIT_SCHEMAS[type];
  const payload = collectEditValues(type);
  const errEl = document.getElementById("editDrawerError");
  try {
    const res = await fetch(schema.endpoint(id), {
      method: "PUT",
      headers: {"Content-Type":"application/json", "X-CSRFToken": getCsrfToken()},
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      errEl.textContent = "Fehler: " + (data.error || res.statusText);
      errEl.classList.remove("d-none");
      return;
    }
    bootstrap.Offcanvas.getInstance(document.getElementById("editDrawer"))?.hide();
    await loadAll();
  } catch (err) {
    errEl.textContent = "Fehler: " + err.message;
    errEl.classList.remove("d-none");
  }
});

// Event-Delegation für alle Edit-Buttons (Tabellen werden neu gerendert)
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".editBtn");
  if (btn) {
    openEdit(btn.dataset.type, btn.dataset.id);
  }
  const del = e.target.closest(".delBtn");
  if (del) {
    const type = del.dataset.type;
    const id = del.dataset.id;
    const ep = type === "home" ? `/api/home-sessions/${id}`
             : type === "external" ? `/api/external/${id}`
             : `/api/extra-costs/${id}`;
    if (!confirm("Wirklich löschen?")) return;
    (async () => {
      try {
        const res = await fetch(ep, {
          method: "DELETE",
          headers: {"X-CSRFToken": getCsrfToken()},
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          alert("Löschen fehlgeschlagen: " + (data.error || res.statusText));
          return;
        }
        await loadAll();
      } catch (err) {
        alert("Löschen fehlgeschlagen: " + err.message);
      }
    })();
  }
});

// CSRF-Token aus Meta-Tag bzw. Backend holen
let _csrfToken = null;
async function ensureCsrf() {
  if (_csrfToken) return _csrfToken;
  try {
    const r = await fetch(`/api/csrf`);
    const d = await r.json();
    _csrfToken = d.csrf_token;
  } catch (e) {
    _csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
  }
  document.querySelector('meta[name="csrf-token"]').content = _csrfToken;
  return _csrfToken;
}
function getCsrfToken() { return _csrfToken || document.querySelector('meta[name="csrf-token"]')?.content || ""; }


async function init() {
  try {
    const cfg = await (await fetch(`/api/config`)).json();
    if (cfg.app && cfg.app.mock_mode) {
      const badge = document.getElementById("mockBadge");
      if (badge) badge.style.display = "";
    }
  } catch (e) {
    console.error("init config laden fehlgeschlagen:", e);
  }
  await ensureCsrf();
  // Mehrfacher Versuch: beim F5 kann ein Fetch zeitweise fehlschlagen
  // (Cache/Config-Race). Nicht sofort mit leerem Fallback aufgeben.
  let attempt = 0;
  async function tryLoad() {
    attempt++;
    await loadAll();
  }
  await tryLoad();
  // Falls beim ersten Laden noch nichts da war (leere Fallbacks),
  // kurz danach erneut versuchen.
  setTimeout(async () => {
    const t = document.getElementById("summaryCards");
    if (t && t.children.length === 0) {
      await tryLoad();
    }
  }, 800);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}




// --- Statistik-Ansicht (Road-Trip-App-Stil: 4 Graphen + KPIs) ---
let statCharts = {};

function avg(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Einzelwerte-Linie + Flaeche + gestrichelte Durchschnittslinie
function drawStatChart(canvasId, labels, values, color, unit, dec) {
  if (statCharts[canvasId]) statCharts[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  // Canvas nicht sichtbar (Tab verborgen / Fade-In) -> 0px Breite -> Chart.js
  // zeichnet nicht. Dann warten (requestAnimationFrame), bis sichtbar, statt
  // komplett zu ueberspringen (sonst bleibt der Graph beim Tab-Wechsel leer).
  if (ctx.clientWidth === 0 && ctx.offsetParent === null) {
    requestAnimationFrame(() => drawStatChart(canvasId, labels, values, color, unit, dec));
    return;
  }
  const mean = avg(values);
  const meanLine = values.map(() => mean);
  statCharts[canvasId] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: unit, data: values,
          borderColor: color, backgroundColor: color + "22",
          fill: true, tension: 0.3, pointRadius: 2, spanGaps: true,
        },
        {
          label: "Ø", data: meanLine,
          borderColor: "#fff", borderDash: [6, 4], borderWidth: 1.5,
          pointRadius: 0, fill: false,
        },
      ],
    },
    options: {
      responsive: true, plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: false, ticks: { callback: v => v?.toLocaleString("de-DE") } } },
    },
  });
}

function renderStats(data) {
  const s = data.series || [];
  const k = data.kpis || {};
  const labels = s.map(d => d.day);

  // Gesamt-KPI-Kacheln
  document.getElementById("statsKpis").innerHTML = [
    kpiStat("⚡ Geladen", `${k.charged_total_kwh?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`),
    kpiStat("💶 Ausgaben", fmtEUR(k.total_cost)),
    kpiStat("🛣️ Gefahren", `${k.total_km?.toLocaleString("de-DE")} km`),
    kpiStat("🔋 Ø Verbrauch", `${k.avg_consumption?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh/100km`),
    kpiStat("💡 Ø Kosten", `${fmtEUR(k.avg_cost_100)}/100km`),
    kpiStat("🌱 CO₂", `${k.avg_co2?.toLocaleString("de-DE", {maximumFractionDigits:1})} g/kWh`),
  ].join("");

  // Home vs. External + TCO-Kacheln
  const t = data.totals || {};
  const tcoExtras = t.tco_with_extras ?? (t.cost_home_and_external + t.cost_extra);
  const tcoNoExtras = t.tco_without_extras ?? t.cost_home_and_external;
  document.getElementById("statsSecondary").insertAdjacentHTML("afterbegin", [
    kpiStat("🏠 Zuhause geladen", `${t.home_kwh?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`, `${t.cost_home ? fmtEUR(t.cost_home) : "–"}`),
    kpiStat("🔌 Extern geladen", `${t.ext_kwh?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`, `${t.cost_external ? fmtEUR(t.cost_external) : "–"}`),
    kpiStat("🚗 TCO (ohne Extras)", fmtEUR(tcoNoExtras)),
    kpiStat("📊 TCO (mit Extras)", fmtEUR(tcoExtras), `inkl. ${fmtEUR(t.cost_extra)} Nebenkosten`),
  ].join(""));

  // 4 Graphen (Tageswerte)
  drawStatChart("chartCons", labels, s.map(d => d.consumption), "#198754", "kWh/100km", 1);
  drawStatChart("chartPrice", labels, s.map(d => d.price_per_kwh), "#0d6efd", "€/kWh", 3);
  drawStatChart("chartCost100", labels, s.map(d => d.cost_per_100), "#ffc107", "€/100km", 2);
  drawStatChart("chartKm", labels, s.map(d => d.cum_km), "#6f42c1", "km", 0);

  // 5. Graph: Verbrauch pro Tag (plausible Tageswerte, odometer-basiert)
  const dayCons = s.map(d => d.consumption);
  drawStatChart("chartSoc", labels, dayCons, "#fd7e14", "kWh/100km", 1);
  const dayConsValid = dayCons.filter(v => v != null);
  const dayMean = dayConsValid.length ? dayConsValid.reduce((a,b)=>a+b,0)/dayConsValid.length : null;
  document.getElementById("kpiSocCons").textContent = dayMean != null ? dayMean.toLocaleString("de-DE", {minimumFractionDigits:1}) : "–";

  // Haupt-KPIs ueber Graphen
  document.getElementById("kpiCons").textContent = k.avg_consumption?.toLocaleString("de-DE", {minimumFractionDigits:1}) || "–";
  document.getElementById("kpiPrice").textContent = k.avg_price_kwh?.toLocaleString("de-DE", {minimumFractionDigits:3}) || "–";
  document.getElementById("kpiCost100").textContent = fmtEUR(k.avg_cost_100);
  document.getElementById("kpiKm").textContent = k.total_km?.toLocaleString("de-DE") || "–";

  // Sekundaer-KPIs + Kategorie-Karten
  const dcPct = k.dc_share_pct ?? 0;
  const pl = data.plausibility || {};
  document.getElementById("statsSecondary").innerHTML = [
    kpiStat("🔌 AC geladen", `${k.ac_kwh?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`),
    kpiStat("⚡ DC (Supercharger)", `${k.dc_kwh?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`),
    kpiStat("⚡ DC-Anteil", `${dcPct} %`),
    kpiStat("🔋 Ladeverlust", `${k.charging_loss_kwh?.toLocaleString("de-DE", {minimumFractionDigits:1})} kWh`, `${k.charging_loss_pct} % der geladenen Energie (AC 10% / DC 5%)`),
    kpiStat("📏 Reichweite", `${k.last_range?.toLocaleString("de-DE")} km`),
    kpiStat("🌱 CO₂ Ø", `${k.avg_co2?.toLocaleString("de-DE", {maximumFractionDigits:1})} g/kWh`),
    kpiStat("💡 AC Kosten", `${fmtEUR(k.ac_cost_per_100km)}/100km`),
    kpiStat("💡 DC Kosten", `${fmtEUR(k.dc_cost_per_100km)}/100km`),
    kpiStat("📊 Plausibilität", `${pl.lower}–${pl.upper}`, `Mittelwert ${pl.mean} ± 2σ kWh/100km (Ausreißer ausgeblendet)`),
  ].join("");
}

function renderStatistics(d) {
  if (!d) return;
  const months = d.monthly || [];
  const labels = months.map(m => m.month);
  // Monatsvergleich Kosten (gestapelt: home/ext/extra)
  if (window.Chart) {
    const mc = document.getElementById("statMonthlyCost");
    if (mc) {
      if (window.__statMc) window.__statMc.destroy();
      window.__statMc = new Chart(mc, { type:"bar", data:{ labels, datasets:[
        {label:"Zuhause", data: months.map(m=>m.home_cost), backgroundColor:"#198754"},
        {label:"Extern", data: months.map(m=>m.ext_cost), backgroundColor:"#0d6efd"},
        {label:"Extra", data: months.map(m=>m.extra), backgroundColor:"#ffc107"},
      ]}, options:{ responsive:true, scales:{x:{stacked:true}, y:{stacked:true, ticks:{callback:v=>v+" €"}}} } });
    }
    const mk = document.getElementById("statMonthlyKwh");
    if (mk) {
      if (window.__statMk) window.__statMk.destroy();
      window.__statMk = new Chart(mk, { type:"bar", data:{ labels, datasets:[
        {label:"Zuhause kWh", data: months.map(m=>m.home_kwh), backgroundColor:"#198754"},
        {label:"Extern kWh", data: months.map(m=>m.ext_kwh), backgroundColor:"#0d6efd"},
      ]}, options:{ responsive:true, scales:{x:{stacked:true}, y:{stacked:true, ticks:{callback:v=>v+" kWh"}}} } });
    }
    // Home vs Extern Donut (Kosten)
    const he = d.home_vs_extern || {};
    const heC = document.getElementById("statHomeExt");
    if (heC) {
      if (window.__statHe) window.__statHe.destroy();
      window.__statHe = new Chart(heC, { type:"doughnut", data:{ labels:["Zuhause","Extern"],
        datasets:[{ data:[he.home_cost||0, he.ext_cost||0], backgroundColor:["#198754","#0d6efd"] }] },
        options:{ responsive:true, plugins:{ legend:{position:"bottom"} } } });
    }
    // AC vs DC Donut
    const ac = d.ac_dc || {};
    const acC = document.getElementById("statAcDc");
    if (acC) {
      if (window.__statAc) window.__statAc.destroy();
      window.__statAc = new Chart(acC, { type:"doughnut", data:{ labels:["AC (Wallbox)","DC (Schnell)"],
        datasets:[{ data:[ac.ac_kwh||0, ac.dc_kwh||0], backgroundColor:["#6f42c1","#fd7e14"] }] },
        options:{ responsive:true, plugins:{ legend:{position:"bottom"} } } });
    }
    // Kosten nach Standorttyp (Balken)
    const bl = d.by_location || [];
    const blC = document.getElementById("statByLocation");
    if (blC) {
      if (window.__statBl) window.__statBl.destroy();
      window.__statBl = new Chart(blC, { type:"bar", data:{
        labels: bl.map(b=>b.type), datasets:[{ label:"kWh", data: bl.map(b=>b.kwh),
        backgroundColor:["#198754","#0d6efd","#ffc107","#6f42c1","#dc3545"].slice(0,bl.length) }] },
        options:{ responsive:true, plugins:{ legend:{display:false} }, scales:{ y:{ticks:{callback:v=>v+" kWh"}} } } });
    }
  }
  // Ø pro Ladevorgang Kacheln
  const apc = d.avg_per_charge || {};
  const el = document.getElementById("statAvgCards");
  if (el) {
    el.innerHTML = [
      kpiStat("🔌 Ladungen gesamt", `${apc.n_charges||0}`, "im Zeitraum"),
      kpiStat("⚡ Ø kWh/Ladung", `${(apc.avg_kwh||0).toLocaleString("de-DE",{minimumFractionDigits:1})} kWh`, "Zuhause (EVCC)"),
      kpiStat("💶 Ø Kosten/Ladung", fmtEUR(apc.avg_cost), "Zuhause (EVCC)"),
      kpiStat("⏱️ Ø Dauer/Ladung", `${(apc.avg_duration_h||0).toLocaleString("de-DE",{minimumFractionDigits:1})} h`, "alle Quellen"),
      kpiStat("🚀 Extern Ø kWh", `${(apc.ext_avg_kwh||0).toLocaleString("de-DE",{minimumFractionDigits:1})} kWh`, "Supercharger etc."),
      kpiStat("💸 Extern Ø Kosten", fmtEUR(apc.ext_avg_cost), "Supercharger etc."),
    ].join("");
  }
  // Heatmap als HTML-Grid (Wochentag x Stunde)
  const heat = d.heatmap || [];
  const hm = document.getElementById("statHeatmap");
  if (hm && heat.length === 7) {
    const maxV = Math.max(1, ...heat.flat());
    const days = ["Mo","Di","Mi","Do","Fr","Sa","So"];
    let html = '<div class="small mb-1">Zellenfarbe = Anzahl Ladevorgänge zu dieser Uhrzeit (dunkler = mehr)</div>';
    html += '<div style="overflow-x:auto"><table class="table table-sm" style="font-size:.7rem">';
    html += "<thead><tr><th></th>" + Array.from({length:24}, (_,h)=>`<th class="text-center">${h}</th>`).join("") + "</tr></thead><tbody>";
    for (let i=0;i<7;i++) {
      html += `<tr><td class="text-end fw-bold">${days[i]}</td>`;
      for (let h=0;h<24;h++) {
        const v = heat[i][h];
        const a = v / maxV;
        const bg = v === 0 ? "#f1f3f5" : `rgba(13,110,253,${0.15 + a*0.85})`;
        html += `<td class="text-center p-0" style="background:${bg};width:3.5%">${v||""}</td>`;
      }
      html += "</tr>";
    }
    html += "</tbody></table></div>";
    hm.innerHTML = html;
  }
}

function kpiStat(label, value, sub) {
  return `<div class="col-6 col-md-4 col-lg-2">
    <div class="card h-100 text-center shadow-sm">
      <div class="card-body py-2">
        <div class="text-muted small">${label}</div>
        <div class="fs-6 fw-bold">${value}</div>
        <div class="small opacity-75">${sub || ""}</div>
      </div>
    </div>
  </div>`;
}

// --- Roadtrip / Reise-Ansicht (Kacheln auf Hauptseite) ---
let tripChart = null;

function renderRoadtrip(data) {
  window.__lastTrip = data;
  const t = data.totals || {};

  // 1) Kennzahlen-Kacheln (OHNE "Gesamt km" - das ist der Tachostand = max odometer,
  //    der auf der Hauptseite nicht hierhin gehoert; stattdessen die nuetzlichen Werte)
  document.getElementById("tripCards").innerHTML = [
    kpi("⚡ Geladen", (t.kwh != null ? t.kwh : 0).toLocaleString("de-DE", {minimumFractionDigits:1}) + " kWh"),
    kpi("💶 Ausgaben", fmtEUR(t.cost)),
    kpi("🔋 Ø Verbrauch", (t.avg_consumption_kwh_100km != null ? t.avg_consumption_kwh_100km : 0).toLocaleString("de-DE", {minimumFractionDigits:1}) + " kWh/100km"),
    kpi("💡 Ø Kosten", fmtEUR(t.avg_cost_per_100km) + "/100km"),
    kpi("📆 Tage", t.n_days),
  ].join("");
}

function kpi(label, value) {
  return `<div class="col-6 col-md-4 col-lg-2">
    <div class="card h-100 text-center shadow-sm">
      <div class="card-body py-2">
        <div class="text-muted small">${label}</div>
        <div class="fs-5 fw-bold">${value}</div>
      </div>
    </div>
  </div>`;

// Tab-Wechsel: Statistik/Home-Tab sichtbar -> neu zeichnen (sonst Canvas 0px)
let __chartData = null;
let __statsData = null;
document.querySelectorAll('[data-bs-toggle="tab"]').forEach(tab => {
  tab.addEventListener("shown.bs.tab", (e) => {
    const target = e.target.getAttribute("data-bs-target");
    if (target === "#tabStats") {
      if (__chartData) setTimeout(() => { renderStats(__chartData); renderStatistics(__statData); }, 30);
    } else if (target === "#tabHome") {
      if (__statsData) setTimeout(() => renderCharts(__statsData), 30);
    }
  });
});

// --- Zeitraum-Auswahl (90T / 1J / All / eigener Bereich) ---
document.querySelectorAll('[data-days]').forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll('[data-days]').forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentDays = parseInt(btn.getAttribute("data-days"), 10);
    customFrom = null;
    customTo = null;
    updateRangeLabel();
    loadAll();
  });
});

const btnRange = document.getElementById("btnRange");
if (btnRange) {
  btnRange.addEventListener("click", () => {
    const from = document.getElementById("rangeFrom").value;
    const to = document.getElementById("rangeTo").value;
    if (!from || !to) {
      alert("Bitte Von- und Bis-Datum wählen.");
      return;
    }
    document.querySelectorAll('[data-days]').forEach(b => b.classList.remove("active"));
    customFrom = from;
    customTo = to;
    updateRangeLabel();
    loadAll();
  });
}

updateRangeLabel();
}

// --- SoC-Auswertung: Verteilungs- und Zeitdiagramme ---
function drawBarChart(canvasId, labels, values, color, unit) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  if (ctx.clientWidth === 0 && ctx.offsetParent === null) {
    requestAnimationFrame(() => drawBarChart(canvasId, labels, values, color, unit));
    return;
  }
  if (window.socCharts && window.socCharts[canvasId]) window.socCharts[canvasId].destroy();
  window.socCharts = window.socCharts || {};
  window.socCharts[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: unit, data: values,
        backgroundColor: color, borderRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { font: { size: 10 } } },
      },
    },
  });
}

function renderSocCharts(d) {
  if (!d || typeof d !== "object") return;
  const s = d.summary || {};
  // Zusammenfassungs-Kacheln
  const sumEl = document.getElementById("socSummary");
  if (sumEl) {
    const cards = [
      ["Ladungen", s.total ?? "–"],
      ["mit SoC-Daten", s.with_soc ?? "–"],
      ["Ø SoC Start", s.avg_soc_start != null ? s.avg_soc_start + " %" : "–"],
      ["Ø SoC Ende", s.avg_soc_end != null ? s.avg_soc_end + " %" : "–"],
      ["Ø Spanne", s.avg_span != null ? s.avg_span + " %" : "–"],
    ];
    sumEl.innerHTML = cards.map(([l, v]) =>
      `<div class="col-6 col-md-4 col-lg-2"><div class="border rounded p-2 text-center">
        <div class="small text-muted">${l}</div>
        <div class="fw-bold">${v}</div></div></div>`).join("");
  }
  // SoC-Verteilungen (10%-Faecher 0..100)
  const buckets = (arr) => (arr || []).map(x => `${x.bucket}–${x.bucket + 9}%`);
  const counts = (arr) => (arr || []).map(x => x.count);
  drawBarChart("chartSocStart", buckets(d.soc_start_hist),
               counts(d.soc_start_hist), "#0d6efd", "Ladungen");
  drawBarChart("chartSocEnd", buckets(d.soc_end_hist),
               counts(d.soc_end_hist), "#198754", "Ladungen");
  drawBarChart("chartSocSpan", buckets(d.charge_span),
               counts(d.charge_span), "#fd7e14", "Ladungen");
  // Wann geladen? (24h)
  const hours = d.by_hour || [];
  drawBarChart("chartSocHour",
               hours.map((_, i) => `${i}:00`), hours, "#6f42c1", "Ladungen");
  // Wo geladen? (Anbieter: Anzahl + kWh kombiniert als gestapelt)
  const provs = d.by_provider || [];
  const pCtx = document.getElementById("chartSocProvider");
  if (pCtx && window.Chart) {
    if (window.socCharts && window.socCharts["chartSocProvider"]) window.socCharts["chartSocProvider"].destroy();
    window.socCharts = window.socCharts || {};
    window.socCharts["chartSocProvider"] = new Chart(pCtx, {
      type: "bar",
      data: {
        labels: provs.map(p => p.provider),
        datasets: [
          { label: "Ladungen", data: provs.map(p => p.count), backgroundColor: "#0d6efd", borderRadius: 3 },
          { label: "kWh", data: provs.map(p => p.kwh), backgroundColor: "#ffc107", borderRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: "y",
        plugins: { legend: { display: true, labels: { font: { size: 10 } } } },
        scales: {
          x: { beginAtZero: true, ticks: { font: { size: 10 } } },
          y: { ticks: { font: { size: 10 } } },
        },
      },
    });
  }
}

// --- Sichtbare Versionsanzeige (Footer) ---
// Laedt /api/version und zeigt Build-Zeit + Commit, damit man sofort sieht,
// ob nach einem Update wirklich die neue Version im Browser laeuft.
(function showVersion() {
  fetch('/api/version').then(r => r.json()).then(v => {
    const el = document.getElementById('versionInfo');
    if (!el) return;
    let t = 'unbekannt';
    if (v.app_version && v.app_version !== 'unknown') {
      const ts = Number(v.app_version);
      if (!isNaN(ts)) {
        const d = new Date(ts * 1000);
        t = d.toLocaleString('de-DE');
      } else {
        t = v.app_version;
      }
    }
    el.innerHTML = `Build: <code>${t}</code> · Commit: <code>${v.commit || 'n/a'}</code>` +
      (v.mock ? ' · <span class="badge bg-warning text-dark">MOCK</span>' : '');
  }).catch(() => {
    const el = document.getElementById('versionInfo');
    if (el) el.textContent = 'Version nicht abrufbar';
  });
})();

// Eindeutiger Build-Marker (zum Verifizieren, ob der Browser die neue app.js laedt)
window.__APP_MARKER = "2026-07-17-final-r3";
