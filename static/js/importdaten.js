// importdaten.js - Kombinierte EVCC + TeslaMate Importdaten Seite
let currentDays = 90;
let currentFrom = null;
let currentTo = null;
let currentPageHome = 1;
let currentPageExt = 1;
const PER_PAGE = 25;

function buildApiParams(page, source) {
  if (typeof getGlobalRangeParams === 'function') {
    return getGlobalRangeParams() + `&page=${page}&per_page=${PER_PAGE}`;
  }
  if (currentFrom && currentTo) {
    return `from=${currentFrom}&to=${currentTo}&page=${page}&per_page=${PER_PAGE}`;
  }
  return `days=${currentDays}&page=${page}&per_page=${PER_PAGE}`;
}

function updateRangeLabel() {
  const el = document.getElementById('rangeLabel');
  if (!el) return;
  
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

// ========== EVCC HOME ==========
async function loadHome() {
  try {
    const params = buildApiParams(currentPageHome, 'home');
    const resp = await fetch(`/api/sessions?${params}`, {credentials: "same-origin"});
    const data = await resp.json();
    renderHome(data.home || [], data.pagination?.home_total || 0);
    updateRangeLabel();
  } catch (e) {
    console.error('loadHome failed', e);
  }
}

function renderHome(rows, total) {
  const tb = document.querySelector("#tblHome tbody");
  if (!tb) return;
  
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    renderPagination('Home', 1, 1);
    return;
  }
  
  tb.innerHTML = rows.map(r => {
    const solarPct = r.charged_kwh > 0 ? Math.round((r.pv_kwh / r.charged_kwh) * 100) : 0;
    return `
    <tr data-id="${r.id}">
      <td>${r.created ? r.created.slice(0,10) : '–'}</td>
      <td>${r.loadpoint || ''}</td>
      <td>${r.vehicle || ''}</td>
      <td>${fmtKwh(r.charged_kwh)}</td>
      <td>${solarPct}%</td>
      <td>${fmtKwh(r.grid_kwh)}</td>
      <td>${fmtKwh(r.pv_kwh)}</td>
      <td>${fmtEUR(r.grid_cost)}</td>
      <td>${fmtEUR(r.pv_cost)}</td>
      <td>${fmtEUR(r.total_cost)}</td>
      <td>${r.charged_kwh > 0 ? (r.total_cost / r.charged_kwh).toLocaleString('de-DE', {minimumFractionDigits:2, maximumFractionDigits:2}) : ''}</td>
      <td>${r.odometer != null ? Number(r.odometer).toLocaleString('de-DE') : '–'}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="home" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="home" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>`;
  }).join("");
  
  attachEventListeners('home', rows);
  
  const totalPages = Math.ceil(total / PER_PAGE);
  renderPagination('Home', currentPageHome, totalPages);
}

// ========== TESLAMATE EXTERN ==========
async function loadExt() {
  try {
    const params = buildApiParams(currentPageExt, 'ext');
    const resp = await fetch(`/api/sessions?${params}`, {credentials: "same-origin"});
    const data = await resp.json();
    renderExt(data.external || [], data.pagination?.external_total || 0);
    updateRangeLabel();
  } catch (e) {
    console.error('loadExt failed', e);
  }
}

function renderExt(rows, total) {
  const tb = document.querySelector("#tblExt tbody");
  if (!tb) return;
  
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    renderPagination('Ext', 1, 1);
    return;
  }
  
  tb.innerHTML = rows.map(r => {
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
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="ext" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="ext" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>`;
  }).join("");
  
  attachEventListeners('ext', rows);
  
  const totalPages = Math.ceil(total / PER_PAGE);
  renderPagination('Ext', currentPageExt, totalPages);
}

function attachEventListeners(source, rows) {
  const prefix = source === 'home' ? '#tblHome' : '#tblExt';
  
  document.querySelectorAll(`${prefix} .edit-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      const data = rows.find(r => String(r.id) === String(id));
      if (data && window.SharedModal) {
        window.SharedModal.open(source, id, data);
      }
    });
  });
  
  document.querySelectorAll(`${prefix} .delete-btn`).forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = row.dataset.id;
      if (!confirm('Wirklich löschen?')) return;
      try {
        const endpoint = source === 'home' ? `/api/home/${id}` : `/api/external/${id}`;
        const resp = await csrfFetch(endpoint, {method: 'DELETE'});
        if (!resp.ok) throw new Error('Fehler beim Löschen');
        if (source === 'home') loadHome();
        else loadExt();
      } catch (e) {
        alert('Fehler: ' + e.message);
      }
    });
  });
}

function renderPagination(source, page, totalPages) {
  const id = source === 'Home' ? 'paginationHome' : 'paginationExt';
  const nav = document.getElementById(id);
  if (!nav) return;
  
  if (totalPages <= 1) {
    nav.innerHTML = '';
    return;
  }
  
  let html = '<ul class="pagination pagination-sm justify-content-center mb-0">';
  html += `<li class="page-item ${page === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${page - 1}" data-src="${source}">«</a></li>`;
  
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      html += `<li class="page-item ${i === page ? 'active' : ''}"><a class="page-link" href="#" data-page="${i}" data-src="${source}">${i}</a></li>`;
    } else if (i === page - 2 || i === page + 2) {
      html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    }
  }
  
  html += `<li class="page-item ${page === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${page + 1}" data-src="${source}">»</a></li>`;
  html += '</ul>';
  
  nav.innerHTML = html;
  
  nav.querySelectorAll('.page-link[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const p = parseInt(link.getAttribute('data-page'), 10);
      const src = link.getAttribute('data-src');
      if (!isNaN(p) && p >= 1 && p <= totalPages && p !== page) {
        if (src === 'Home') { currentPageHome = p; loadHome(); }
        else { currentPageExt = p; loadExt(); }
      }
    });
  });
}

// ========== SHARED CSRF ==========
async function csrfFetch(url, opts = {}) {
  let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  if (!csrf) {
    try {
      const resp = await fetch('/api/csrf', {credentials: "same-origin"});
      const data = await resp.json();
      csrf = data.csrf_token;
      document.querySelector('meta[name="csrf-token"]').content = csrf;
    } catch (e) {}
  }
  opts.headers = Object.assign({}, opts.headers, {
    'Content-Type': 'application/json',
    'X-CSRFToken': csrf
  });
  opts.credentials = 'same-origin';
  return fetch(url, opts);
}

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  // Listen for global date range changes
  window.addEventListener('globalRangeChange', (e) => {
    const params = e.detail;
    if (params.startsWith('from=')) {
      const urlParams = new URLSearchParams(params);
      currentFrom = urlParams.get('from');
      currentTo = urlParams.get('to');
      currentDays = 365;
      currentPageHome = 1;
      currentPageExt = 1;
      if (document.getElementById('rangeFrom')) document.getElementById('rangeFrom').value = currentFrom;
      if (document.getElementById('rangeTo')) document.getElementById('rangeTo').value = currentTo;
    } else {
      const urlParams = new URLSearchParams(params);
      currentDays = parseInt(urlParams.get('days'), 10);
      currentFrom = null;
      currentTo = null;
      currentPageHome = 1;
      currentPageExt = 1;
      if (document.getElementById('rangeFrom')) document.getElementById('rangeFrom').value = '';
      if (document.getElementById('rangeTo')) document.getElementById('rangeTo').value = '';
      document.querySelectorAll('[data-days]').forEach(b => {
        if (parseInt(b.getAttribute('data-days'), 10) === currentDays) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });
    }
    loadHome();
    loadExt();
  });
  
  loadHome();
  loadExt();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';