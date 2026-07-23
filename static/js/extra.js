// extra.js - Extra-Kosten Tabelle
let currentDays = 365;

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
}

async function loadExtra() {
  try {
    const resp = await fetch('/api/extra-costs', {credentials: "same-origin"});
    const data = await resp.json();
    renderExtra(data || []);
    updateRangeLabel();
  } catch (e) {
    console.error('loadExtra failed', e);
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
  
  const labels = {purchase:'Anschaffung', service:'Service', accessory:'Zubehör', insurance:'Versicherung', tax:'Steuer', other:'Sonstiges'};
  
  tb.innerHTML = displayRows.map(r => `
    <tr data-id="${r.id}">
      <td>${r.date || ''}</td>
      <td>${labels[r.category] || r.category}</td>
      <td>${r.description || ''}</td>
      <td>${fmtEUR(r.amount)}</td>
      <td>${r.odometer != null ? Number(r.odometer).toLocaleString('de-DE') : '–'}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="extra" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="extra" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>
  `).join("");
  
  // Edit buttons
  tb.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      const data = displayRows.find(r => String(r.id) === String(id));
      if (data && window.SharedModal) {
        window.SharedModal.open('extra', id, data);
      }
    });
  });
  
  // Delete buttons
  tb.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      if (!confirm('Wirklich löschen?')) return;
      try {
        const resp = await csrfFetch(`/api/extra-costs/${id}`, {method: 'DELETE'});
        if (!resp.ok) throw new Error('Fehler beim Löschen');
        loadExtra();
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
      loadExtra();
    });
  });
  loadExtra();
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