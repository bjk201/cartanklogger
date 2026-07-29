// importdaten.js - EVCC + TeslaMate Importdaten mit Edit/Löschen

let currentDays = 90;
let currentPageHome = 1;
let currentPageExt = 1;
const PER_PAGE = 10;

function getRangeParams() {
    if (typeof globalDateRange !== 'undefined') {
        if (globalDateRange.from && globalDateRange.to) {
            return `from=${encodeURIComponent(globalDateRange.from)}&to=${encodeURIComponent(globalDateRange.to)}`;
        }
        return `days=${globalDateRange.days}`;
    }
    return `days=${currentDays}`;
}

async function loadHome() {
    try {
        const params = `${getRangeParams()}&page=${currentPageHome}&per_page=${PER_PAGE}`;
        const resp = await fetch(`/api/sessions?${params}`, {credentials: "same-origin"});
        const data = await resp.json();
        renderHome(data.home || [], data.pagination?.home_total || 0);
    } catch (e) {
        console.error('loadHome failed', e);
        document.querySelector('#tblHome tbody').innerHTML = '<tr><td colspan="13" class="text-center py-4 text-muted">Fehler beim Laden</td></tr>';
    }
}

function renderHome(rows, total) {
    const tb = document.querySelector("#tblHome tbody");
    if (!tb) return;
    
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="13" class="text-center py-4 text-muted">Keine Daten</td></tr>';
        return;
    }
    
    tb.innerHTML = rows.map(r => {
        const solarPct = r.charged_kwh > 0 ? Math.round((r.pv_kwh / r.charged_kwh) * 100) : 0;
        return `
    <tr data-id="${r.id}">
      <td>${r.created ? r.created.slice(0,10) : '–'}</td>
      <td>${r.loadpoint || ''}</td>
      <td>${r.vehicle || ''}</td>
      <td>${r.charged_kwh ? r.charged_kwh.toLocaleString('de-DE', {maximumFractionDigits:1}) : '–'} kWh</td>
      <td>${solarPct}%</td>
      <td>${r.grid_kwh ? r.grid_kwh.toLocaleString('de-DE', {maximumFractionDigits:1}) : '–'} kWh</td>
      <td>${r.pv_kwh ? r.pv_kwh.toLocaleString('de-DE', {maximumFractionDigits:1}) : '–'} kWh</td>
      <td>${r.grid_cost ? r.grid_cost.toLocaleString('de-DE', {style:'currency', currency:'EUR'}) : '–'}</td>
      <td>${r.pv_cost ? r.pv_cost.toLocaleString('de-DE', {style:'currency', currency:'EUR'}) : '–'}</td>
      <td>${r.total_cost ? r.total_cost.toLocaleString('de-DE', {style:'currency', currency:'EUR'}) : '–'}</td>
      <td>${r.charged_kwh > 0 ? (r.total_cost / r.charged_kwh).toLocaleString('de-DE', {minimumFractionDigits:2, maximumFractionDigits:2}) : '–'}</td>
      <td>${r.odometer != null ? Number(r.odometer).toLocaleString('de-DE') : '–'}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="home" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="home" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>`;
    }).join("");
    
    attachHomeEventListeners(rows);
    renderPagination('Home', currentPageHome, Math.ceil(total / PER_PAGE));
}

async function loadExt() {
    try {
        const params = `${getRangeParams()}&page=${currentPageExt}&per_page=${PER_PAGE}`;
        const resp = await fetch(`/api/sessions?${params}`, {credentials: "same-origin"});
        const data = await resp.json();
        renderExt(data.external || [], data.pagination?.external_total || 0);
    } catch (e) {
        console.error('loadExt failed', e);
        document.querySelector('#tblExt tbody').innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Fehler beim Laden</td></tr>';
    }
}

function renderExt(rows, total) {
    const tb = document.querySelector("#tblExt tbody");
    if (!tb) return;
    
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Keine Daten</td></tr>';
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
      <td>${r.energy_kwh ? r.energy_kwh.toLocaleString('de-DE', {maximumFractionDigits:1}) : '–'} kWh</td>
      <td>${r.cost_total ? r.cost_total.toLocaleString('de-DE', {style:'currency', currency:'EUR'}) : '–'}</td>
      <td>${r.price_per_kwh || '–'}</td>
      <td>${r.odometer_start != null ? Number(r.odometer_start).toLocaleString('de-DE') : '–'}</td>
      <td>${badge}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-type="ext" data-id="${r.id}">✏️</button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-type="ext" data-id="${r.id}" title="Löschen">🗑️</button>
      </td>
    </tr>`;
    }).join("");
    
    attachExtEventListeners(rows);
    renderPagination('Ext', currentPageExt, Math.ceil(total / PER_PAGE));
}

function attachHomeEventListeners(rows) {
    document.querySelectorAll('#tblHome .edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            const data = rows.find(r => String(r.id) === String(id));
            if (data && window.SharedModal) {
                window.SharedModal.open('home', id, data);
            }
        });
    });
    
    document.querySelectorAll('#tblHome .delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Wirklich löschen?')) return;
            const id = btn.getAttribute('data-id');
            try {
                const resp = await csrfFetch(`/api/home-sessions/${id}`, {method: 'DELETE'});
                if (!resp.ok) throw new Error('Fehler beim Löschen');
                loadHome();
            } catch (e) {
                alert('Fehler: ' + e.message);
            }
        });
    });
}

function attachExtEventListeners(rows) {
    document.querySelectorAll('#tblExt .edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            const data = rows.find(r => String(r.id) === String(id));
            if (data && window.SharedModal) {
                window.SharedModal.open('external', id, data);
            }
        });
    });
    
    document.querySelectorAll('#tblExt .delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Wirklich löschen?')) return;
            const id = btn.getAttribute('data-id');
            try {
                const resp = await csrfFetch(`/api/external/${id}`, {method: 'DELETE'});
                if (!resp.ok) throw new Error('Fehler beim Löschen');
                loadExt();
            } catch (e) {
                alert('Fehler: ' + e.message);
            }
        });
    });
}

function renderPagination(source, page, totalPages) {
    const nav = document.getElementById(source === 'Home' ? 'paginationHome' : 'paginationExt');
    if (!nav || totalPages <= 1) {
        if (nav) nav.innerHTML = '';
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
                if (source === 'Home') { currentPageHome = p; loadHome(); }
                else { currentPageExt = p; loadExt(); }
            }
        });
    });
}

async function csrfFetch(url, opts = {}) {
    let csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    if (!csrf) {
        try {
            const resp = await fetch('/api/csrf', {credentials: "same-origin"});
            const data = await resp.json();
            csrf = data.csrf_token;
        } catch (e) {}
    }
    opts.headers = Object.assign({}, opts.headers, {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf
    });
    opts.credentials = 'same-origin';
    return fetch(url, opts);
}

// Init
window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-days]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDays = parseInt(btn.getAttribute('data-days'), 10);
            currentPageHome = 1;
            currentPageExt = 1;
            loadHome();
            loadExt();
        });
    });
    
    window.addEventListener('globalRangeChange', (e) => {
        const params = e.detail;
        const urlParams = new URLSearchParams(params);
        currentDays = parseInt(urlParams.get('days'), 10);
        document.querySelectorAll('[data-days]').forEach(b => {
            if (parseInt(b.getAttribute('data-days'), 10) === currentDays) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
        loadHome();
        loadExt();
    });
    
    loadHome();
    loadExt();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';