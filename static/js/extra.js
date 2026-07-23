// extra.js - Extra-Kosten Tabelle
let currentDays = 365;
let currentFrom = null;
let currentTo = null;
let currentPage = 1;
const PER_PAGE = 25;

function buildApiParams() {
  if (currentFrom && currentTo) {
    return `from=${currentFrom}&to=${currentTo}&page=${currentPage}&per_page=${PER_PAGE}`;
  }
  return `days=${currentDays}&page=${currentPage}&per_page=${PER_PAGE}`;
}

function updateRangeLabel() {
  const el = document.getElementById("rangeLabel");
  if (!el) return;
  el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
}

async function loadExtra() {
  try {
    const params = buildApiParams();
    const resp = await fetch(`/api/extra-costs?${params}`, {credentials: "same-origin"});
    const data = await resp.json();
    renderExtra(data.rows || [], data.pagination?.total || 0);
    updateRangeLabel();
  } catch (e) {
    console.error('loadExtra failed', e);
  }
}

function renderExtra(rows, total) {
  const tb = document.querySelector("#tblExtra tbody");
  if (!tb) return;
  
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    renderPagination(1, 1);
    return;
  }
  
  const labels = {purchase:'Anschaffung', service:'Service', accessory:'Zubehör', insurance:'Versicherung', tax:'Steuer', other:'Sonstiges'};
  
  tb.innerHTML = rows.map(r => `
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
      const data = rows.find(r => String(r.id) === String(id));
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
  
  const totalPages = Math.ceil(total / PER_PAGE);
  renderPagination(currentPage, totalPages);
}

function renderPagination(page, totalPages) {
  const nav = document.getElementById('pagination');
  if (!nav) return;
  
  if (totalPages <= 1) {
    nav.innerHTML = '';
    return;
  }
  
  let html = '<ul class="pagination pagination-sm justify-content-center mb-0">';
  html += `<li class="page-item ${page === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${page - 1}">«</a></li>`;
  
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      html += `<li class="page-item ${i === page ? 'active' : ''}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
    } else if (i === page - 2 || i === page + 2) {
      html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
    }
  }
  
  html += `<li class="page-item ${page === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${page + 1}">»</a></li>`;
  html += '</ul>';
  
  nav.innerHTML = html;
  
  nav.querySelectorAll('.page-link[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const p = parseInt(link.getAttribute('data-page'), 10);
      if (!isNaN(p) && p >= 1 && p <= totalPages && p !== page) {
        currentPage = p;
        loadExtra();
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
      currentFrom = null;
      currentTo = null;
      currentPage = 1;
      document.getElementById('rangeFrom').value = '';
      document.getElementById('rangeTo').value = '';
      loadExtra();
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
        loadExtra();
      }
    });
  }
  
  loadExtra();
});

// CSRF fetch helper
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

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});