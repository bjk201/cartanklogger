// overview.js - Übersichtsseite
let currentDays = 365;

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  if (currentDays >= 9999) el.textContent = "Alle Daten";
  else el.textContent = `Letzte ${currentDays} Tage`;
}

async function loadOverview() {
  try {
    const resp = await fetch(`/api/merged?days=${currentDays}`);
    const data = await resp.json();
    renderMergedTable(data);
  } catch (e) {
    console.error(e);
  }
}

function renderMergedTable(rows) {
  const tb = document.querySelector("#tblMerged tbody");
  if (!tb) return;
  
  if (!rows || rows.length === 0) {
    tb.innerHTML = '<tr><td colspan="11" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  // Nur erste 25 Einträge
  const displayRows = rows.slice(0, 25);
  
  tb.innerHTML = displayRows.map((r, i) => `
    <tr>
      <td>${r.day || "–"}</td>
      <td>${(r.stations || "–")}</td>
      <td>${formatKwh(r.home_kwh)}</td>
      <td>${formatEUR(r.home_cost)}</td>
      <td>${r.home_solar_pct ? formatPct(r.home_solar_pct) : "–"}</td>
      <td>${r.home_loss ? formatKwh(r.home_loss) : "–"}</td>
      <td>${r.ext_kwh ? formatKwh(r.ext_kwh) : "–"}</td>
      <td>${r.ext_cost ? formatEUR(r.ext_cost) : "–"}</td>
      <td><strong>${formatKwh(r.total_kwh)}</strong></td>
      <td><strong>${formatEUR(r.total_cost)}</strong></td>
      <td><button class="btn btn-sm btn-outline-secondary" data-bs-toggle="collapse" data-bs-target="#m${i}">▾</button></td>
    </tr>
    <tr class="collapse-row"><td colspan="11" class="p-0">
      <div class="collapse" id="m${i}"><div class="p-2 bg-light">${buildDetail(r)}</div></div>
    </td></tr>
  `).join("");
}

function buildDetail(r) {
  let html = '<div class="row"><div class="col-md-6"><strong>🏠 Zuhause</strong><ul class="mb-2 ps-3">';
  if (r.evcc && r.evcc.length) {
    r.evcc.forEach(e => html += `<li>EVCC ${e.created ? e.created.slice(11,16) : ""} · ${formatKwh(e.charged_kwh)} · ${formatEUR(e.total_cost)} · PV ${formatPct(e.solar_percentage)}</li>`);
  }
  if (r.tm_home && r.tm_home.length) {
    r.tm_home.forEach(t => html += `<li class="text-muted">TeslaMate ${t.label || t.address || ""}: added ${formatKwh(t.added)} / used ${formatKwh(t.used)} → Verlust ${formatKwh(t.used - t.added)} (${t.n_frags} Teil-Lad.)</li>`);
  }
  if (!(r.evcc && r.evcc.length) && !(r.tm_home && r.tm_home.length)) html += "<li>–</li>";
  html += '</ul></div><div class="col-md-6"><strong>🔌 Extern</strong><ul class="mb-0 ps-3">';
  if (r.tm_ext && r.tm_ext.length) {
    r.tm_ext.forEach(t => html += `<li>${t.label || t.address || "Extern"} ${t.start ? t.start.slice(11,16) : ""}–${t.end ? t.end.slice(11,16) : ""}: ${formatKwh(t.added)} · ${formatEUR(t.cost)} (${t.n_frags} Teil-Lad.)</li>`);
  } else {
    html += "<li>–</li>";
  }
  html += "</ul></div></div>";
  return html;
}

// Zeitpicker Buttons
document.addEventListener("DOMContentLoaded", function() {
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = parseInt(btn.getAttribute("data-days"), 10);
      updateRangeLabel();
      loadOverview();
    });
  });
  loadOverview();
});

// Helpers
const fmtEUR = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"});
const fmtKwh = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {minimumFractionDigits:1, maximumFractionDigits:1}) + " kWh";
const fmtPct = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {maximumFractionDigits:1}) + " %";

function formatEUR(v) { return fmtEUR(v); }
function formatKwh(v) { return fmtKwh(v); }
function formatPct(v) { return fmtPct(v); }