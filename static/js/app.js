// CarTankLogger Dashboard JS
let currentDays = 365;
let charts = {};

const fmtEUR = (v) => (v == null ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"}));
const fmtKwh = (v) => (v == null ? "–" : Number(v).toLocaleString("de-DE", {minimumFractionDigits:1, maximumFractionDigits:1}) + " kWh");
const fmtPct = (v) => (v == null ? "–" : Number(v).toLocaleString("de-DE", {maximumFractionDigits:1}) + " %");

async function loadAll() {
  const stats = await (await fetch(`/api/stats?days=${currentDays}`)).json();
  const sess = await (await fetch(`/api/sessions`)).json();
  const merged = await (await fetch(`/api/merged`)).json();
  const trip = await (await fetch(`/api/roadtrip`)).json();
  const chartData = await (await fetch(`/api/charts`)).json();
  __chartData = chartData;
  __statsData = stats;
  renderSummary(stats);
  renderCharts(stats);
  renderHome(sess.home);
  renderExt(sess.external);
  renderMerged(merged, trip.per_day || [], stats.totals || {});
  renderRoadtrip(trip);
  renderStats(chartData);
  renderExtra();
}

function renderSummary(s) {
  const t = s.totals, h = s.home, e = s.external, x = s.extra;
  const cards = [
    {t:"Zuhause Energie", v:fmtKwh(h.kwh), s:`${fmtKwh(h.grid_kwh)} Netz · ${fmtKwh(h.pv_kwh)} PV`, c:"primary"},
    {t:"Zuhause Kosten", v:fmtEUR(h.cost), s:`${fmtEUR(h.grid_cost)} Netz · ${fmtEUR(h.pv_cost)} PV`, c:"success"},
    {t:"Extern Energie", v:fmtKwh(e.kwh), s:`${e.count} Sitzungen · ${fmtPct(e.share_pct)} der Energie`, c:"info"},
    {t:"Extern Kosten", v:fmtEUR(e.cost), s:`${fmtEUR(e.cost_per_kwh)}/kWh Ø`, c:"info"},
    {t:"Extra-Kosten", v:fmtEUR(x.total), s:`${x.count} Einträge`, c:"warning"},
    {t:"Gesamt (TCO)", v:fmtEUR(t.tco), s:"Laden + Extra", c:"dark"},
    {t:"Kosten / km", v:fmtEUR(t.cost_per_km)+" /km", s:`${Number(t.distance_km).toLocaleString("de-DE")} km gefahren`, c:"secondary"},
    {t:"Verbrauch", v:fmtKwh(t.consumption_kwh_per_100km)+" /100km", s:`von der Wand · Akku ≈ ${fmtKwh(t.consumption_net_kwh_per_100km)}`, c:"secondary"},
    {t:"PV-Anteil", v:fmtPct(h.pv_share_pct), s:"Solar am Zuhause-Laden", c:"success"},
  ];
  document.getElementById("summaryCards").innerHTML = cards.map(c => `
    <div class="col-6 col-md-3 col-lg-2">
      <div class="card text-white bg-${c.c} h-100">
        <div class="card-body py-2">
          <div class="small opacity-75">${c.t}</div>
          <div class="fs-6 fw-bold">${c.v}</div>
          <div class="small opacity-75">${c.s}</div>
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
  const m = s.monthly;
  if (charts.monthly) charts.monthly.destroy();
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
    <td><button class="btn btn-sm btn-outline-secondary editBtn" data-type="home" data-id="${r.id}">✏️</button></td>
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
    if (r.evcc && r.evcc.length) {
      for (const e of r.evcc) {
        detail += `<li>EVCC ${e.created ? e.created.slice(11,16) : ""} · ${fmtKwh(e.charged_kwh)} · ${fmtEUR(e.total_cost)} · PV ${fmtPct(e.solar_percentage)}</li>`;
      }
    }
    if (r.tm_home && r.tm_home.length) {
      for (const t of r.tm_home) {
        detail += `<li class="text-muted">TeslaMate ${t.address || ""}: added ${fmtKwh(t.added)} / used ${fmtKwh(t.used)} → Verlust ${fmtKwh(t.used - t.added)} (${t.n_frags} Teil-Lad.)</li>`;
      }
    }
    if (!(r.evcc && r.evcc.length) && !(r.tm_home && r.tm_home.length)) detail += "<li>–</li>";
    detail += '</ul></div><div class="col-md-6">';
    detail += '<strong>🔌 Extern</strong><ul class="mb-0 ps-3">';
    if (r.tm_ext && r.tm_ext.length) {
      for (const t of r.tm_ext) {
        detail += `<li>${t.address || "Extern"} ${t.start ? t.start.slice(11,16) : ""}–${t.end ? t.end.slice(11,16) : ""}: ${fmtKwh(t.added)} · ${fmtEUR(t.cost)} (${t.n_frags} Teil-Lad.)</li>`;
      }
    } else {
      detail += "<li>–</li>";
    }
    detail += "</ul></div></div>";

    const stationBadges = (r.stations || []).map(s => {
      const isExt = !/garage|dammstr/i.test(s);
      return `<span class="badge ${isExt ? 'bg-warning text-dark' : 'bg-success'} me-1">${s}</span>`;
    }).join("");

    return `<tr>
      <td>${r.day || "–"}</td>
      <td>${stationBadges}</td>
      <td>${fmtKwh(r.home_kwh)}</td>
      <td>${fmtEUR(r.home_cost)}</td>
      <td>${r.home_kwh > 0 ? fmtPct(r.home_solar_pct) : "–"}</td>
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
    <td><button class="btn btn-sm btn-outline-secondary editBtn" data-type="external" data-id="${r.id}">✏️</button></td>
  </tr>`).join("");
}


async function renderExtra() {
  const rows = await (await fetch(`/api/extra-costs`)).json();
  const tb = document.querySelector("#tblExtra tbody");
  const labels = {purchase:"Anschaffung", service:"Service", accessory:"Zubehör", insurance:"Versicherung", tax:"Steuer", other:"Sonstiges"};
  tb.innerHTML = rows.map(r => `<tr data-id="${r.id}">
    <td>${r.date||""}</td><td>${labels[r.category]||r.category}</td>
    <td>${r.description||""}</td><td>${fmtEUR(r.amount)}</td>
    <td>${r.odometer!=null?Number(r.odometer).toLocaleString("de-DE"):"–"}</td>
    <td><button class="btn btn-sm btn-outline-secondary editBtn" data-type="extra" data-id="${r.id}">✏️</button></td>
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
  if (row.raw) flags.push("Original-Rohdaten erhalten");
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
  const cfg = await (await fetch(`/api/config`)).json();
  if (cfg.app && cfg.app.mock_mode) {
    document.getElementById("mockBadge").style.display = "";
  }
  await ensureCsrf();
  loadAll();
}
init();




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

// --- Roadtrip / Reise-Ansicht (iOS Roadtrip-App-Stil) ---
let tripMap = null;
let tripChart = null;

function renderRoadtrip(data) {
  window.__lastTrip = data;
  const t = data.totals || {};

  // 1) Kennzahlen-Kacheln
  document.getElementById("tripCards").innerHTML = [
    kpi("🛣️ Gesamt km", t.km?.toLocaleString("de-DE") + " km"),
    kpi("⚡ Geladen", t.kwh?.toLocaleString("de-DE", {minimumFractionDigits:1}) + " kWh"),
    kpi("💶 Ausgaben", fmtEUR(t.cost)),
    kpi("🔋 Ø Verbrauch", t.avg_consumption_kwh_100km?.toLocaleString("de-DE", {minimumFractionDigits:1}) + " kWh/100km"),
    kpi("💡 Ø Kosten", fmtEUR(t.avg_cost_per_100km) + "/100km"),
    kpi("📆 Tage", t.n_days),
  ].join("");

  // Karte erst bauen, wenn der Tab sichtbar ist (sonst Groesse 0 -> Fehler).
  // Beim initialen Laden nichts tun; _drawTripMap() wird via shown.bs.tab
  // getriggert, sobald der Reise-Tab geklickt wird.
  window.__tripStops = data.stops || [];
  if (window.__tripTabVisible && window.L) _drawTripMap();

  // 3) Tagesbalken (km / kWh / €)
  const days = (data.per_day || []).slice().reverse(); // chronologisch
  const maxKm = Math.max(...days.map(d => d.km), 1);
  const maxKwh = Math.max(...days.map(d => d.kwh), 1);
  const maxEur = Math.max(...days.map(d => d.cost), 1);
  document.getElementById("tripDays").innerHTML = days.map(d => `
    <div class="border rounded p-2">
      <div class="d-flex justify-content-between small fw-bold">
        <span>${d.day}</span>
        <span class="text-muted">${d.km.toLocaleString("de-DE")} km · ${fmtKwh(d.kwh)} · ${fmtEUR(d.cost)}</span>
      </div>
      <div class="progress mt-1" style="height:8px">
        <div class="progress-bar bg-info" style="width:${(d.km/maxKm*100)}%"></div>
      </div>
      <div class="progress mt-1" style="height:8px">
        <div class="progress-bar bg-success" style="width:${(d.kwh/maxKwh*100)}%"></div>
      </div>
      <div class="progress mt-1" style="height:8px">
        <div class="progress-bar bg-warning" style="width:${(d.cost/maxEur*100)}%"></div>
      </div>
      <div class="small text-muted mt-1">${d.stations.map(s => `<span class="badge bg-secondary me-1">${s}</span>`).join("")}</div>
    </div>`).join("");

  // 4) Chart kWh vs € pro Tag (nur wenn Tab sichtbar, sonst 0px Fehler)
  const labels = days.map(d => d.day);
  const tripCtx = document.getElementById("chartTrip");
  if (tripCtx && window.Chart && !(tripCtx.clientWidth === 0 && tripCtx.offsetParent === null)) {
    if (tripChart) tripChart.destroy();
    tripChart = new Chart(tripCtx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "kWh", data: days.map(d => d.kwh), backgroundColor: "#198754", yAxisID: "y" },
          { label: "€", data: days.map(d => d.cost), backgroundColor: "#ffc107", yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: { position: "left", title: { display: true, text: "kWh" } },
          y1: { position: "right", title: { display: true, text: "€" }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }
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

// Leaflet-Karte: erst zeichnen wenn Tab sichtbar (sonst Groesse 0)
function _initTripMapLazy() {
  if (tripMap || !window.L) return;
  tripMap = L.map("tripMap").setView([49.05, 9.25], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19
  }).addTo(tripMap);
  // Wenn der Tab spaeter sichtbar wird, Groesse neu berechnen
  window.__tripTabVisible = false;
}

function _drawTripMap() {
  if (!window.L) return;
  if (!tripMap) _initTripMapLazy();
  if (!tripMap) return;
  // Nur zeichnen, wenn der Reise-Pane wirklich sichtbar ist (sonst 0px ->
  // Leaflet zeigt keine Kacheln). Falls noch display:none (waehrend Bootstrap-
  // Fade-In), wiederholen via requestAnimationFrame, bis sichtbar.
  const pane = document.getElementById("tabTrip");
  if (pane && getComputedStyle(pane).display === "none") {
    requestAnimationFrame(_drawTripMap);
    return;
  }
  // Groesse neu berechnen (Tab war evtl. versteckt -> 0px). Mehrfach, damit
  // auch nach dem Bootstrap-Fade-In die Kacheln erscheinen.
  tripMap.invalidateSize();
  setTimeout(() => tripMap.invalidateSize(), 200);
  setTimeout(() => tripMap.invalidateSize(), 500);
  tripMap.eachLayer(l => { if (l instanceof L.Marker) tripMap.removeLayer(l); });
  const stops = window.__tripStops || [];
  if (stops.length) {
    const bounds = [];
    stops.forEach(s => {
      const m = L.marker([s.lat, s.lng]).addTo(tripMap);
      m.bindPopup(`<b>${s.address}</b><br>${s.day}<br>${fmtKwh(s.kwh)} · ${fmtEUR(s.cost)}`);
      bounds.push([s.lat, s.lng]);
    });
    tripMap.fitBounds(bounds, { padding: [30, 30] });
  }
}

// Tab-Wechsel: Reise/Statistik/Home-Tab sichtbar -> neu zeichnen (sonst Canvas 0px)
let __chartData = null;
let __statsData = null;
document.querySelectorAll('[data-bs-toggle="tab"]').forEach(tab => {
  tab.addEventListener("shown.bs.tab", (e) => {
    const target = e.target.getAttribute("data-bs-target");
    if (target === "#tabTrip") {
      window.__tripTabVisible = true;
      // Karte zeichnen: nach Fade-In (Bootstrap ~150ms) + mehrfaches invalidateSize.
      if (window.L) {
        setTimeout(_drawTripMap, 150);
        setTimeout(_drawTripMap, 350);
      }
      if (window.__lastTrip) setTimeout(() => renderRoadtrip(window.__lastTrip), 30);
    } else if (target === "#tabStats") {
      window.__tripTabVisible = false;
      if (__chartData) setTimeout(() => renderStats(__chartData), 30);
    } else if (target === "#tabHome") {
      if (__statsData) setTimeout(() => renderCharts(__statsData), 30);
    }
  });
  // Fallback: falls shown.bs.tab nicht feuert (Bootstrap-Versionen),
  //zeichne Karte direkt beim Klick auf den Reise-Tab.
  tab.addEventListener("click", () => {
    if (tab.getAttribute("data-bs-target") === "#tabTrip" && window.L) {
      setTimeout(_drawTripMap, 200);
    }
  });
});
}
