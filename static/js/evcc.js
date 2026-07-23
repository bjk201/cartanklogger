// evcc.js - EVCC Zuhause Tabelle
let currentDays = 365;
let displayRows = [];

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
}

async function loadEVCC() {
  try {
    const resp = await fetch(`/api/sessions?days=${currentDays}`, {credentials: "same-origin"});
    const data = await resp.json();
    renderEVCC(data.home || []);
    updateRangeLabel();
  } catch (e) {
    console.error('loadEVCC failed', e);
  }
}

function renderEVCC(rows) {
  displayRows = rows;
  const tb = document.querySelector("#tblHome tbody");
  if (!tb) return;
  
  const displayRows = rows.slice(0, 25);
  
  if (!displayRows.length) {
    tb.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  tb.innerHTML = displayRows.map(r => `
    <tr data-id="${r.id}">
      <td>${r.created ? r.created.slice(0,10) : '–'}</td>
      <td>${r.loadpoint || ''}</td>
      <td>${r.vehicle || ''}</td>
      <td>${fmtKwh(r.charged_kwh)}</td>
      <td>${fmtPct(r.solar_percentage)}</td>
      <td>${fmtKwh(r.grid_kwh)}</td>
      <td>${fmtKwh(r.pv_kwh)}</td>
      <td>${fmtEUR(r.grid_cost)}</td>
      <td>${fmtEUR(r.pv_cost)}</td>
      <td>${fmtEUR(r.total_cost)}</td>
      <td>${r.price_per_kwh || ''}</td>
      <td>${r.odometer != null ? Number(r.odometer).toLocaleString('de-DE') : '–'}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="home" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="home" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>
  `).join("");
  
  tb.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      const data = displayRows.find(r => String(r.id) === String(id));
      if (data && window.SharedModal) {
        window.SharedModal.open('home', id, data);
      }
    });
  });
  
  tb.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      if (!confirm('Wirklich löschen?')) return;
      try {
        const resp = await csrfFetch(`/api/home-sessions/${id}`, {method: 'DELETE'});
        if (!resp.ok) throw new Error('Fehler beim Löschen');
        loadEVCC();
      } catch (e) {
        alert('Fehler: ' + e.message);
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDays = parseInt(btn.getAttribute('data-days'), 10);
      loadEVCC();
    });
  });
  loadEVCC();
});

async function csrfFetch(url, opts = {}) {
  let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  if (!csrf) {
    try {
      const resp = await fetch('/api/csrf');
      const data = await resp.json();
      csrf = data.csrf_token;
      document.querySelector('meta[name="csrf-token"]').content = csrf;
    } catch (e) {}
  }
  opts.headers = Object.assign({}, opts.headers, {
    'Content-Type': 'application/json',
    'X-CSRFToken': csrf
  });
  return fetch(url, opts);
}

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';