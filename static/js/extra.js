// extra.js - Extra-Kosten Tabelle mit Hinzufügen-Formular

let currentExtraPage = 1;
const PER_PAGE = 10;

function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
}

async function csrfFetch(url, opts = {}) {
    const csrf = getCsrfToken();
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['X-CSRFToken'] = csrf;
    opts.credentials = 'same-origin';
    return fetch(url, opts);
}

async function loadExtra() {
    try {
        const resp = await fetch('/api/extra-costs', {credentials: "same-origin"});
        const data = await resp.json();
        renderExtraTable(data);
    } catch (e) {
        console.error('loadExtra failed', e);
        const tb = document.querySelector('#tblExtra tbody');
        if (tb) tb.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Fehler beim Laden</td></tr>';
    }
}

function renderExtraTable(rows) {
    const tb = document.querySelector('#tblExtra tbody');
    if (!tb) return;
    
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">Keine Extra-Kosten</td></tr>';
        return;
    }
    
    const labels = {
        purchase: 'Anschaffung',
        service: 'Service',
        accessory: 'Zubehör',
        insurance: 'Versicherung',
        tax: 'Steuer',
        other: 'Sonstiges'
    };
    
    tb.innerHTML = rows.map(r => `
        <tr data-id="${r.id}">
            <td>${r.date || ''}</td>
            <td>${labels[r.category] || r.category}</td>
            <td>${r.description || ''}</td>
            <td>${fmtEUR(r.amount)}</td>
            <td>${r.odometer != null ? Number(r.odometer).toLocaleString('de-DE') : '–'}</td>
            <td>
                <button class="btn btn-sm btn-outline-secondary edit-extra-btn" data-id="${r.id}">✏️</button>
                <button class="btn btn-sm btn-outline-danger delete-extra-btn" data-id="${r.id}" title="Löschen">🗑️</button>
            </td>
        </tr>
    `).join('');
    
    // Attach event listeners
    document.querySelectorAll('.edit-extra-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            const row = document.querySelector(`tr[data-id="${id}"]`);
            const data = {
                id: id,
                date: row.cells[0].textContent,
                category: row.cells[1].textContent,
                description: row.cells[2].textContent,
                amount: row.cells[3].textContent.replace(' €', ''),
                odometer: row.cells[4].textContent
            };
            openEditModal('extra', id, data);
        });
    });
    
    document.querySelectorAll('.delete-extra-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
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

// Modal functions
function openEditModal(type, id, data) {
    const modal = document.getElementById('addExtraModal');
    if (!modal) return;
    
    // Reset form
    document.getElementById('date').value = data.date || '';
    document.getElementById('category').value = data.category || 'purchase';
    document.getElementById('description').value = data.description || '';
    document.getElementById('amount').value = data.amount || '';
    document.getElementById('odometer').value = data.odometer || '';
    document.getElementById('note').value = data.note || '';
    
    // Show modal
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
}

document.getElementById('saveExtraBtn')?.addEventListener('click', async () => {
    const form = document.getElementById('extraForm');
    const formData = new FormData(form);
    const data = {
        category: formData.get('category'),
        date: formData.get('date'),
        description: formData.get('description'),
        amount: parseFloat(formData.get('amount')),
        odometer: formData.get('odometer') ? parseFloat(formData.get('odometer')) : null,
        note: formData.get('note')
    };
    
    try {
        const resp = await csrfFetch('/api/extra-costs', {
            method: 'POST',
            body: JSON.stringify(data)
        });
        const result = await resp.json();
        if (result.ok) {
            const bsModal = bootstrap.Modal.getInstance(document.getElementById('addExtraModal'));
            bsModal.hide();
            loadExtra();
        } else {
            alert('Fehler: ' + (result.error || 'unbekannt'));
        }
    } catch (e) {
        alert('Fehler: ' + e.message);
    }
});

function fmtEUR(v) {
    if (v == null) return '–';
    if (typeof v === 'number') return v.toLocaleString('de-DE', {style:'currency', currency:'EUR'});
    return v;
}

// Init
document.addEventListener('DOMContentLoaded', loadExtra);