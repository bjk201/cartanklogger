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
  renderSummary(stats);
  renderCharts(stats);
  renderHome(sess.home);
  renderExt(sess.external);
  renderMerged(merged);
  renderExtra();
}

function renderSummary(s) {
  const t = s.totals, h = s.home, e = s.external, x = s.extra;
  const cards = [
    {t:"Zuhause Energie", v:fmtKwh(h.kwh), s:`${fmtKwh(h.grid_kwh)} Netz · ${fmtKwh(h.pv_kwh)} PV`, c:"primary"},
    {t:"Zuhause Kosten", v:fmtEUR(h.cost), s:`${fmtEUR(h.grid_cost)} Netz · ${fmtEUR(h.pv_cost)} PV`, c:"success"},
    {t:"Extern Kosten", v:fmtEUR(e.cost), s:`${e.count} Sitzungen · ${fmtKwh(e.kwh)}`, c:"info"},
    {t:"Extra-Kosten", v:fmtEUR(x.total), s:`${x.count} Einträge`, c:"warning"},
    {t:"Gesamt (TCO)", v:fmtEUR(t.tco), s:"Laden + Extra", c:"dark"},
    {t:"Kosten / km", v:fmtEUR(t.cost_per_km)+" /km", s:`${Number(t.distance_km).toLocaleString("de-DE")} km gefahren`, c:"secondary"},
    {t:"Verbrauch", v:fmtKwh(t.consumption_kwh_per_100km)+" /100km", s:"Ø über gefahrene km", c:"secondary"},
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
  // Source donut
  const srcData = [h.grid_kwh, h.pv_kwh, e.kwh];
  if (charts.source) charts.source.destroy();
  charts.source = new Chart(document.getElementById("chartSource"), {
    type: "doughnut",
    data: { labels: ["Zuhause Netz", "Zuhause PV", "Extern"],
      datasets: [{ data: srcData, backgroundColor: ["#0d6efd","#198754","#0dcaf0"] }]},
    options: { plugins: { legend: { position: "bottom" } } }
  });
  // Monthly stacked
  const m = s.monthly;
  if (charts.monthly) charts.monthly.destroy();
  charts.monthly = new Chart(document.getElementById("chartMonthly"), {
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
  tb.innerHTML = rows.map(r => `<tr>
    <td>${r.created ? r.created.slice(0,10) : "–"}</td>
    <td>${r.loadpoint||""}</td><td>${r.vehicle||""}</td>
    <td>${fmtKwh(r.charged_kwh)}</td><td>${fmtPct(r.solar_percentage)}</td>
    <td>${fmtKwh(r.grid_kwh)}</td><td>${fmtKwh(r.pv_kwh)}</td>
    <td>${fmtEUR(r.grid_cost)}</td><td>${fmtEUR(r.pv_cost)}</td>
    <td>${fmtEUR(r.total_cost)}</td><td>${r.price_per_kwh||""}</td>
    <td>${r.odometer!=null?Number(r.odometer).toLocaleString("de-DE"):"–"}</td>
  </tr>`).join("");
}

function renderMerged(rows) {
  const tb = document.querySelector("#tblMerged tbody");
  tb.innerHTML = rows.map((r, i) => {
    const hasEv = r.evcc && r.evcc.length;
    const hasTm = r.tm && r.tm.length;
    // Aufklapp-Detail: EVCC einzeln, dann TM-Gruppen mit Fragmenten
    let detail = '<ul class="mb-0 ps-3">';
    if (hasEv) {
      detail += `<li><strong>EVCC (${r.evcc.length}x)</strong></li>`;
      for (const e of r.evcc) {
        detail += `<li style="margin-left:1rem">${e.created ? e.created.slice(11,16) : ""} ${fmtKwh(e.charged_kwh)} · ${fmtEUR(e.total_cost)}</li>`;
      }
    }
    if (hasTm) {
      detail += `<li><strong>TeslaMate (${r.tm.length}x Gruppe)</strong></li>`;
      for (const t of r.tm) {
        const frags = (t.frags || []);
        detail += `<li style="margin-left:1rem">${t.start ? t.start.slice(11,16) : ""}–${t.end ? t.end.slice(11,16) : ""} added ${fmtKwh(t.added)} · used ${fmtKwh(t.used)} · Verlust ${fmtKwh(t.used - t.added)} (${t.n_frags} Fragm.)</li>`;
      }
    }
    if (!hasEv && !hasTm) detail += "<li>keine Daten</li>";
    detail += "</ul>";
    return `<tr>
      <td>${r.day || "–"}</td>
      <td>${r.station || "–"}</td>
      <td>${fmtKwh(r.evcc_kwh)}</td>
      <td>${fmtEUR(r.evcc_cost)}</td>
      <td>${r.evcc_solar_pct != null ? fmtPct(r.evcc_solar_pct) : "–"}</td>
      <td>${fmtKwh(r.tm_added)}</td>
      <td>${fmtKwh(r.tm_used)}</td>
      <td>${fmtKwh(r.tm_loss)}</td>
      <td>${fmtEUR(r.tm_cost)}</td>
      <td><button class="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="collapse" data-bs-target="#m${i}">▾</button></td>
    </tr>
    <tr class="collapse-row"><td colspan="10" class="p-0">
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
    <td><button class="btn btn-sm btn-outline-primary editPrice">Preis</button></td>
  </tr>`).join("");
  tb.querySelectorAll(".editPrice").forEach(b => b.addEventListener("click", () => {
    const id = b.closest("tr").dataset.id;
    const cur = b.closest("tr").querySelector(".cost").textContent;
    const val = prompt("Belasteten Preis (€) eingeben:", cur.replace(/[^0-9.,]/g,"").replace(",","."));
    if (val == null) return;
    fetch(`/api/external/${id}`, {method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({cost_total: parseFloat(val.replace(",","."))})})
      .then(r=>r.json()).then(()=>loadAll());
  }));
}

async function renderExtra() {
  const rows = await (await fetch(`/api/extra-costs`)).json();
  const tb = document.querySelector("#tblExtra tbody");
  const labels = {purchase:"Anschaffung", service:"Service", accessory:"Zubehör", insurance:"Versicherung", tax:"Steuer", other:"Sonstiges"};
  tb.innerHTML = rows.map(r => `<tr>
    <td>${r.date||""}</td><td>${labels[r.category]||r.category}</td>
    <td>${r.description||""}</td><td>${fmtEUR(r.amount)}</td>
    <td>${r.odometer!=null?Number(r.odometer).toLocaleString("de-DE"):"–"}</td>
  </tr>`).join("");
}

document.querySelectorAll("[data-days]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("[data-days]").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  currentDays = parseInt(b.dataset.days);
  document.getElementById("rangeLabel").textContent =
    currentDays >= 9999 ? "Gesamter Zeitraum" : `Letzte ${currentDays} Tage`;
  loadAll();
}));

async function init() {
  const cfg = await (await fetch(`/api/config`)).json();
  if (cfg.app && cfg.app.mock_mode) {
    document.getElementById("mockBadge").style.display = "";
  }
  loadAll();
}
init();
