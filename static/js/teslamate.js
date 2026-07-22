// teslamate.js - Externe Ladungen
let currentDays = 365;

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  if (currentDays >= 9999) el.textContent = "Alle Daten";
  else el.textContent = `Letzte ${currentDays} Tage`;
}

async function loadTeslamate() {
  try {
    const resp = await fetch(`/api/sessions?days=${currentDays}`);
    const data = await resp.json();
    renderTM(data.external || []);
  } catch (e) {
    console.error(e);
  }
}

function renderTM(rows) {
  const tb = document.querySelector("#tblExt tbody");
  if (!tb) return;
  
  const displayRows = rows.slice(0, 25);
  
  if (!displayRows.length) {
    tb.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  tb.innerHTML = displayRows.map(r => {
    const badge = r.cost_total > 0 && r.manual_price == 1 ? '<span class="badge bg-success">manuell</span>'
                 : r.cost_total > 0 ? '<span class="badge bg-secondary">TeslaMate</span>'
                 : '<span class="badge bg-warning text-dark">fehlt</span>';
    return `
    <tr data-id="${r.id}">
      <td>${r.started_at ? r.started_at.slice(0,10) : "–"}</td>
      <td>${r.location_name || r.address || ""}</td>
      <td>${r.provider || ""}</td>
      <td>${formatKwh(r.energy_kwh)}</td>
      <td class="cost">${formatEUR(r.cost_total)}</td>
      <td>${r.price_per_kwh || ""}</td>
      <td>${r.odometer_start != null ? Number(r.odometer_start).toLocaleString("de-DE") : "–"}</td>
      <td>${badge}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" data-type="external" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger" data-type="external" data-id="${r.id}">🗑️</button>
      </td>
    </tr>
  `;
  }).join("");
}

document.addEventListener("DOMContentLoaded", function() {
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentDays = parseInt(btn.getAttribute("data-days"), 10);
      updateRangeLabel();
      loadTeslamate();
    });
  });
  loadTeslamate();
});

const fmtEUR = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"});
const fmtKwh = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {minimumFractionDigits:1, maximumFractionDigits:1}) + " kWh";
function formatEUR(v) { return fmtEUR(v); }
function formatKwh(v) { return fmtKwh(v); }