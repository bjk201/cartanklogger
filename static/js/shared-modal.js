// shared-modal.js - Wiederverwendbares Edit-Modal für alle Seiten
(function() {
  'use strict';
  
  let currentModal = null;
  let currentSaveCallback = null;
  
  function createModal() {
    const modalHtml = `
      <div class="modal fade" id="sharedEditModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h6 class="modal-title" id="sharedModalTitle">Bearbeiten</h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <div id="sharedModalError" class="alert alert-danger d-none small"></div>
              <form id="sharedEditForm">
                <input type="hidden" id="sharedEditType">
                <input type="hidden" id="sharedEditId">
                <div id="sharedEditFields"></div>
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">Abbrechen</button>
              <button type="button" class="btn btn-primary btn-sm" id="sharedSaveBtn">Speichern</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    currentModal = new bootstrap.Modal(document.getElementById('sharedEditModal'));
    
    document.getElementById('sharedSaveBtn').addEventListener('click', handleSave);
  }
  
  const fieldConfigs = {
    home: {
      title: 'EVCC Ladevorgang bearbeiten',
      fields: [
        {id: 'created', label: 'Datum', type: 'date'},
        {id: 'loadpoint', label: 'Ladepunkt', type: 'text'},
        {id: 'vehicle', label: 'Fahrzeug', type: 'text'},
        {id: 'charged_kwh', label: 'kWh', type: 'number', step: '0.1'},
        {id: 'solar_percentage', label: 'PV %', type: 'number', step: '0.1', min: '0', max: '100'},
        {id: 'grid_kwh', label: 'Netz kWh', type: 'number', step: '0.1'},
        {id: 'pv_kwh', label: 'PV kWh', type: 'number', step: '0.1'},
        {id: 'grid_cost', label: 'Netz €', type: 'number', step: '0.01'},
        {id: 'pv_cost', label: 'PV €', type: 'number', step: '0.01'},
        {id: 'total_cost', label: 'Gesamt €', type: 'number', step: '0.01'},
        {id: 'price_per_kwh', label: '€/kWh', type: 'number', step: '0.001'},
        {id: 'odometer', label: 'KM-Stand', type: 'number', step: '1'},
        {id: 'note', label: 'Notiz', type: 'text'},
      ],
      apiPrefix: '/api/home-sessions'
    },
    external: {
      title: 'Externer Ladevorgang bearbeiten',
      fields: [
        {id: 'started_at', label: 'Datum', type: 'date'},
        {id: 'location_name', label: 'Ort/Name', type: 'text'},
        {id: 'provider', label: 'Anbieter', type: 'text'},
        {id: 'energy_kwh', label: 'kWh', type: 'number', step: '0.1'},
        {id: 'cost_total', label: 'Kosten €', type: 'number', step: '0.01'},
        {id: 'price_per_kwh', label: '€/kWh', type: 'number', step: '0.001'},
        {id: 'odometer_start', label: 'KM-Stand', type: 'number', step: '1'},
        {id: 'note', label: 'Notiz', type: 'text'},
      ],
      apiPrefix: '/api/external'
    },
    extra: {
      title: 'Extra-Kosten bearbeiten',
      fields: [
        {id: 'date', label: 'Datum', type: 'date'},
        {id: 'category', label: 'Kategorie', type: 'select', options: [
          {value: 'purchase', label: 'Anschaffung'},
          {value: 'service', label: 'Service'},
          {value: 'accessory', label: 'Zubehör'},
          {value: 'insurance', label: 'Versicherung'},
          {value: 'tax', label: 'Steuer'},
          {value: 'other', label: 'Sonstiges'},
        ]},
        {id: 'description', label: 'Beschreibung', type: 'text'},
        {id: 'amount', label: 'Betrag €', type: 'number', step: '0.01'},
        {id: 'odometer', label: 'KM-Stand', type: 'number', step: '1'},
        {id: 'note', label: 'Notiz', type: 'text'},
      ],
      apiPrefix: '/api/extra-costs'
    }
  };
  
  function buildFields(type, data) {
    const config = fieldConfigs[type];
    if (!config) return '';
    
    return config.fields.map(f => {
      let inputHtml = '';
      const value = data[f.id] ?? '';
      
      if (f.type === 'select') {
        inputHtml = `<select class="form-control form-control-sm" id="edit_${f.id}" name="${f.id}">` +
          f.options.map(opt => `<option value="${opt.value}" ${value == opt.value ? 'selected' : ''}>${opt.label}</option>`).join('') +
        '</select>';
      } else if (f.type === 'date') {
        // Format date for input[type=date]
        let dateVal = '';
        if (value) {
          const d = new Date(value);
          if (!isNaN(d.getTime())) {
            dateVal = d.toISOString().split('T')[0];
          }
        }
        inputHtml = `<input class="form-control form-control-sm" type="date" id="edit_${f.id}" name="${f.id}" value="${dateVal}">`;
      } else {
        inputHtml = `<input class="form-control form-control-sm" type="${f.type}" id="edit_${f.id}" name="${f.id}" value="${value}" ${f.step ? `step="${f.step}"` : ''} ${f.min ? `min="${f.min}"` : ''} ${f.max ? `max="${f.max}"` : ''}>`;
      }
      
      return `
        <div class="mb-2">
          <label class="form-label small" for="edit_${f.id}">${f.label}</label>
          ${inputHtml}
        </div>
      `;
    }).join('');
  }
  
  window.SharedModal = {
    open(type, id, data) {
      if (!currentModal) createModal();
      
      const config = fieldConfigs[type];
      if (!config) return;
      
      document.getElementById('sharedModalTitle').textContent = config.title;
      document.getElementById('sharedEditType').value = type;
      document.getElementById('sharedEditId').value = id;
      document.getElementById('sharedEditFields').innerHTML = buildFields(type, data);
      document.getElementById('sharedModalError').classList.add('d-none');
      document.getElementById('sharedModalError').textContent = '';
      
      currentSaveCallback = async () => {
        const form = document.getElementById('sharedEditForm');
        const formData = new FormData(form);
        const body = {};
        formData.forEach((v, k) => { 
          if (k !== 'sharedEditType' && k !== 'sharedEditId') body[k] = v; 
        });
        
        const resp = await csrfFetch(`${config.apiPrefix}/${id}`, {
          method: 'PUT',
          body: JSON.stringify(body)
        });
        
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({error: 'Fehler beim Speichern'}));
          throw new Error(err.error || 'Speichern fehlgeschlagen');
        }
        return true;
      };
      
      currentModal.show();
    }
  };
  
  async function handleSave() {
    if (!currentSaveCallback) return;
    
    const btn = document.getElementById('sharedSaveBtn');
    const errorEl = document.getElementById('sharedModalError');
    btn.disabled = true;
    btn.textContent = '...';
    errorEl.classList.add('d-none');
    
    try {
      await currentSaveCallback();
      currentModal.hide();
      // Trigger reload on current page
      if (window.reloadPage) window.reloadPage();
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.classList.remove('d-none');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Speichern';
    }
  }
  
  // CSRF helper
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
  
  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createModal);
  } else {
    createModal();
  }
})();