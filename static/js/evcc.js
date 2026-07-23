// evcc.js - EVCC Zuhause Tabelle
let currentDays = 365;
let currentFrom = null;
let currentTo = null;
let currentPage = 1;
const PAGE_SIZE = 25;

function buildApiParams() {
  // Use global date range if available
  if (typeof getGlobalRangeParams === 'function') {
    return getGlobalRangeParams();
  }
  if (currentFrom && currentTo) {
    return `from=${currentFrom}&to=${currentTo}&page=${currentPage}&per_page=${PAGE_SIZE}`;
  }
  return `days=${currentDays}&page=${currentPage}&per_page=${PAGE_SIZE}`;
}

async function loadEVCC() {
  try {
    const params = buildApiParams();
    const resp = await fetch(`/api/sessions?${params}`, {credentials: "same-origin"});
    const data = await resp.json();
    renderEVCC(data.home || []);
    renderPagination(data.pagination?.home_total || 0);
    updateRangeLabel();
  } catch (e) {
    console.error('loadEVCC failed', e);
  }
}

function renderEVCC(rows) {
  const tb = document.querySelector("#tblHome tbody");
  if (!tb) return;
  
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  tb.innerHTML = rows.map(r => `
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
      const id = btn.getAttribute('data-id');
      const data = rows.find(r => String(r.id) === String(id));
      if (data && window.SharedModal) {
        window.SharedModal.open('home', id, data);
      }
    });
  });
  
  tb.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Wirklich löschen?')) return;
      try {
        const id = btn.getAttribute('data-id');
        const resp = await csrfFetch(`/api/home-sessions/${id}`, {method: 'DELETE'});
        if (!resp.ok) throw new Error('Fehler beim Löschen');
        loadEVCC();
      } catch (e) {
        alert('Fehler: ' + e.message);
      }
    });
  });
}

function renderPagination(totalRows) {
  const totalPages = Math.ceil(totalRows / PAGE_SIZE);
  if (totalPages <= 1) {
    document.getElementById('pagination').innerHTML = '';
    return;
  }
  
  let html = '<nav aria-label="Pagination"><ul class="pagination pagination-sm justify-content-center mb-0">';
  html += `<li class="page-item ${currentPage === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPage - 1}">‹</a></li>`;
  
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
      html += `<li class="page-item ${i === currentPage ? 'active' : ''}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
    } else if (i === currentPage - 2 || i === currentPage + 2) {
      html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    }
  }
  
  html += `<li class="page-item ${currentPage === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPage + 1}">›</a></li>`;
  html += '</ul></nav>';
  
  document.getElementById('pagination').innerHTML = html;
  
  document.querySelectorAll('#pagination .page-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = parseInt(e.target.getAttribute('data-page'));
      if (!isNaN(page) && page >= 1 && page <= totalPages && page !== currentPage) {
        currentPage = page;
        loadEVCC();
      }
    });
  });
}

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  
  // Try to get global range state
  if (typeof globalDateRange !== 'undefined') {
    if (globalDateRange.from && globalDateRange.to) {
      el.textContent = `${globalDateRange.from} bis ${globalDateRange.to}`;
    } else if (globalDateRange.days >= 9999) {
      el.textContent = 'Alle Daten';
    } else {
      el.textContent = `Letzte ${globalDateRange.days} Tage`;
    }
  } else {
    el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDays = parseInt(btn.getAttribute('data-days'), 10);
      currentFrom = null;
      currentTo = null;
      currentPage = 1;
      document.getElementById('rangeFrom').value = '';
      document.getElementById('rangeTo').value = '';
      loadEVCC();
    });
  });
  
  // Date range picker
  const btnRange = document.getElementById('btnRange');
  if (btnRange) {
    btnRange.addEventListener('click', () => {
      const from = document.getElementById('rangeFrom').value;
      const to = document.getElementById('rangeTo').value;
      if (from && to) {
        currentFrom = from;
        currentTo = to;
        currentPage = 1;
        document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
        loadEVCC();
      }
    });
  }
  
  // Listen for global range changes
  window.addEventListener('globalRangeChange', () => {
    loadEVCC();
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