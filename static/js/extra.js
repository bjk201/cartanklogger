// extra.js - Extra-Kosten
let currentDays = 365;

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  if (currentDays >= 9999) el.textContent = "Alle Daten";
  else el.textContent = `Letzte ${currentDays} Tage`;
}

async function loadExtra() {
  try {
    const resp = await fetch(`/api/extra-costs`);
    const data = await resp.json();
    renderExtra(data || []);
  } catch (e) {
    console.error(e);
  }
}

function renderExtra(rows) {
  const tb = document.querySelector("#tblExtra tbody");
  if (!tb) return;
  
  const displayRows = rows.slice(0, 25);
  
  if (!displayRows.length) {
    tb.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  const labels = {purchase:"Anschaffung", service:"Service", accessory:"Zubehör", insurance:"Versicherung", tax:"Steuer", other:"Sonstiges"};
  
  tb.innerHTML = displayRows.map(r => `
    <tr data-id="${r.id}">
      <td>${r.date || ""}</td>
      <td>${labels[r.category] || r.category}</td>
      <td>${r.description || ""}</td>
      <td>${formatEUR(r.amount)}</td>
      <td>${r.odometer != null ? Number(r.odometer).toLocaleString("de-DE") : "–"}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" data-type="extra" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger" data-type="extra" data-id="${r.id}">🗑️</button>
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
      loadExtra();
    });
  });
  loadExtra();
});

const fmtEUR = v => v == null ? "–" : Number(v).toLocaleString("de-DE", {style:"currency", currency:"EUR"});
function formatEUR(v) { return fmtEUR(v); }