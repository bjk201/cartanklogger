// monatsvergleich.js – Monatsvergleich Seite mit Balkendiagrammen

let currentDays = 365;
let currentFrom = null;
let currentTo = null;

let charts = {
    barChart: null
};

function buildApiParams() {
    if (typeof globalDateRange !== 'undefined') {
        if (globalDateRange.from && globalDateRange.to) {
            return `from=${encodeURIComponent(globalDateRange.from)}&to=${encodeURIComponent(globalDateRange.to)}`;
        }
        return `days=${globalDateRange.days}`;
    }
    if (currentFrom && currentTo) {
        return `from=${encodeURIComponent(currentFrom)}&to=${encodeURIComponent(currentTo)}`;
    }
    return `days=${currentDays}`;
}

async function loadMonatsvergleich() {
    try {
        const params = buildApiParams();
        const resp = await fetch(`/api/monatsvergleich?${params}`, {credentials: "same-origin"});
        const data = await resp.json();
        renderTable(data);
        renderBarChart(data);
        updateRangeLabel();
    } catch (e) {
        console.error('loadMonatsvergleich failed', e);
        document.getElementById('mvEmpty').style.display = 'block';
        document.getElementById('tblMonatsvergleich').style.display = 'none';
    }
}

function renderTable(data) {
    const tbody = document.querySelector('#tblMonatsvergleich tbody');
    const emptyEl = document.getElementById('mvEmpty');
    const tableEl = document.getElementById('tblMonatsvergleich');
    
    if (!tbody) return;
    
    const months = data?.months || [];
    
    if (!months.length) {
        tbody.innerHTML = '';
        emptyEl.style.display = 'block';
        tableEl.style.display = 'none';
        return;
    }
    
    emptyEl.style.display = 'none';
    tableEl.style.display = 'table';
    
    tbody.innerHTML = months.map(m => {
        const km = m.km || 0;
        const homeKwh = m.home_kwh || 0;
        const extKwh = m.ext_kwh || 0;
        const homeCost = m.home_cost || 0;
        const extCost = m.ext_cost || 0;
        const totalCost = m.total_cost || (homeCost + extCost);
        const consumption = m.consumption_kwh_per_100km;
        const costPer100 = m.cost_per_100km;
        
        return `
      <tr>
        <td><strong>${formatMonth(m.month)}</strong></td>
        <td class="text-end">${km > 0 ? Number(km).toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>
        <td class="text-end">${Number(homeKwh).toLocaleString('de-DE', {minimumFractionDigits:1})}</td>
        <td class="text-end">${Number(extKwh).toLocaleString('de-DE', {minimumFractionDigits:1})}</td>
        <td class="text-end">${Number(homeCost).toLocaleString('de-DE', {style:'currency', currency:'EUR'})}</td>
        <td class="text-end">${Number(extCost).toLocaleString('de-DE', {style:'currency', currency:'EUR'})}</td>
        <td class="text-end">${consumption != null ? Number(consumption).toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>
        <td class="text-end">${costPer100 != null ? Number(costPer100).toLocaleString('de-DE', {minimumFractionDigits:2}) : '–'}</td>
      </tr>
    `;
    }).join('');
}

function renderBarChart(data) {
    const canvas = document.getElementById('barChart');
    if (!canvas) return;
    
    const months = data?.months || [];
    if (!months.length) return;
    
    // Destroy existing chart
    if (charts.barChart) charts.barChart.destroy();
    
    const labels = months.map(m => formatMonth(m.month));
    
    charts.barChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'kWh',
                    data: months.map(m => (m.home_kwh || 0) + (m.ext_kwh || 0)),
                    backgroundColor: '#1677ff',
                    yAxisID: 'y-kwh'
                },
                {
                    label: '€',
                    data: months.map(m => m.total_cost || 0),
                    backgroundColor: '#d32f2f',
                    yAxisID: 'y-cost'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                'y-kwh': {
                    type: 'linear',
                    position: 'left',
                    title: { text: 'kWh', display: true },
                    beginAtZero: true
                },
                'y-cost': {
                    type: 'linear',
                    position: 'right',
                    title: { text: '€', display: true },
                    beginAtZero: true,
                    grid: { drawOnChartArea: false }
                }
            }
        }
    });
}

function formatMonth(monthStr) {
    if (!monthStr) return '–';
    const [y, m] = monthStr.split('-');
    const months = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
    return `${months[parseInt(m,10)-1]} ${y}`;
}

function updateRangeLabel() {
    const el = document.getElementById('rangeLabel');
    if (!el) return;
    el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-days]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDays = parseInt(btn.getAttribute('data-days'), 10);
            currentFrom = null;
            currentTo = null;
            if (document.getElementById('rangeFrom')) document.getElementById('rangeFrom').value = '';
            if (document.getElementById('rangeTo')) document.getElementById('rangeTo').value = '';
            loadMonatsvergleich();
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
                document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
                loadMonatsvergleich();
            }
        });
    }
    
    // Listen to global date range changes
    window.addEventListener('globalRangeChange', (e) => {
        const params = e.detail;
        if (params.startsWith('from=')) {
            const urlParams = new URLSearchParams(params);
            currentFrom = urlParams.get('from');
            currentTo = urlParams.get('to');
            currentDays = 365;
            document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
            if (document.getElementById('rangeFrom')) document.getElementById('rangeFrom').value = currentFrom;
            if (document.getElementById('rangeTo')) document.getElementById('rangeTo').value = currentTo;
        } else {
            const urlParams = new URLSearchParams(params);
            currentDays = parseInt(urlParams.get('days'), 10);
            currentFrom = null;
            currentTo = null;
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
        loadMonatsvergleich();
    });
    
    loadMonatsvergleich();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';