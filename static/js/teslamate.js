// teslamate.js - Extern (TeslaMate) Tabelle
let currentDays = 365;

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
}

async function loadTM() {
  try {
    const resp = await fetch(`/api/sessions?days=${currentDays}`);
    const data = await resp.json();
    renderTM(data.external || []);
    updateRangeLabel();
  } catch (e) {
    console.error('loadTM failed', e);
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
      <td>${r.started_at ? r.started_at.slice(0,10) : '–'}</td>
      <td>${r.location_name || r.address || ''}</td>
      <td>${r.provider || ''}</td>
      <td>${fmtKwh(r.energy_kwh)}</td>
      <td class="cost">${fmtEUR(r.cost_total)}</td>
      <td>${r.price_per_kwh || ''}</td>
      <td>${r.odometer_start != null ? Number(r.odometer_start).toLocaleString('de-DE') : '–'}</td>
      <td>${badge}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="external" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="external" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>
  `;
  }).join("");
  
  // Attach event listeners
  tb.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      const data = displayRows.find(r => String(r.id) === String(id));
      if (data && window.SharedModal) {
        window.SharedModal.open('external', id, data);
      }
    });
  });
  
  tb.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      if (!confirm('Wirklich löschen?')) return;
      try {
        const resp = await csrfFetch(`/api/external/${id}`, {method: 'DELETE'});
        if (!resp.ok) throw new Error('Fehler beim Löschen');
        loadTM();
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
      loadTM();
    });
  });
  loadTM();
});

// CSRF fetch helper
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