// evcc.js - EVCC Zuhause Tabelle
let currentDays = 365;

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  if (currentDays >= 9999) el.textContent = "Alle Daten";
  else el.textContent = `Letzte ${currentDays} Tage`;
}

async function loadEVCC() {
  try {
    const resp = await fetch(`/api/sessions?days=${currentDays}`);
    const data = await resp.json();
    renderEVCC(data.home || []);
  } catch (e) {
    console.error(e);
  }
}

function renderEVCC(rows) {
  const tb = document.querySelector("#tblHome tbody");
  if (!tb) return;
  
  // Nur erste 25
  const displayRows = rows.slice(0, 25);
  
  if (!displayRows.length) {
    tb.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  tb.innerHTML = displayRows.map(r => `
    <tr data-id="${r.id}">
      <td>${r.created ? r.created.slice(0,10) : "–"}</td>
      <td>${r.loadpoint || ""}</td>
      <td>${r.vehicle || ""}</td>
      <td>${formatKwh(r.charged_kwh)}</td>
      <td>${formatPct(r.solar_percentage)}</td>
      <td>${formatKwh(r.grid_kwh)}</td>
      <td>${formatKwh(r.pv_kwh)}</td>
      <td>${formatEUR(r.grid_cost)}</td>
      <td>${formatEUR(r.pv_cost)}</td>
      <td>${formatEUR(r.total_cost)}</td>
      <td>${r.price_per_kwh || ""}</td>
      <td>${r.odometer != null ? Number(r.odometer).toLocaleString("de-DE") : "–"}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" data-type="home" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger" data-type="home" data-id="${r.id}">🗑️</button>
      </td>
    </tr>
  `).join("");
}

document.addEventListener("DOMContentLoaded", function() {
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = parseInt(btn.getAttribute("data-days"), 10);
      updateRangeLabel();
      loadEVCC();
    });
  });
  loadEVCC();
});

const fmtEUR = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"});
const fmtKwh = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {minimumFractionDigits:1, maximumFractionDigits:1}) + " kWh";
const fmtPct = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {maximumFractionDigits:1}) + " %";

function formatEUR(v) { return fmtEUR(v); }
function formatKwh(v) { return fmtKwh(v); }
function formatPct(v) { return fmtPct(v); }