// overview.js - Dashboard mit korrekten Durchschnittswerten und Layout

let currentDays = 90;
let currentPageMerged = 1;
const PER_PAGE = 10;

// Chart instances
let charts = {
    consumption: null,
    cost: null,
    km: null,
    homeExtern: null
};

function safeGet(selector) {
    const el = document.querySelector(selector);
    if (!el) console.error(`Element not found: ${selector}`);
    return el;
}

function getGlobalDays() {
    if (typeof globalDateRange !== 'undefined' && globalDateRange.days) {
        return globalDateRange.days;
    }
    return currentDays;
}

async function loadOverview() {
    try {
        const days = getGlobalDays();
        
        const paramsStats = `days=${days}`;
        const paramsMerged = `days=${days}&page=${currentPageMerged}&per_page=${PER_PAGE}`;
        const paramsCharts = `days=${days}`;
        
        console.log('Loading overview data...', { days, paramsStats, paramsMerged, paramsCharts });
        
        const [merged, stats, chartsData] = await Promise.all([
            fetch(`/api/merged?${paramsMerged}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ rows: [], pagination: {} })),
            fetch(`/api/stats?${paramsStats}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ totals: {} })),
            fetch(`/api/charts?${paramsCharts}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ series: [] }))
        ]);

        console.log('API responses:', { 
            merged: merged?.rows?.length, 
            stats: stats?.totals ? 'present' : 'empty',
            charts: chartsData?.series?.length 
        });

        renderMergedTable(merged.rows || merged);
        renderPaginationMerged(merged.pagination?.total || 0);
        renderKPIs(stats.totals || {}, merged.rows || merged);
        renderCharts(chartsData, stats.totals || {});
        updateRangeLabel();
    } catch (e) {
        console.error('loadOverview failed', e);
    }
}

function renderMergedTable(rows) {
    const tb = safeGet('#tblMerged tbody');
    if (!tb) return;

    if (!rows || rows.length === 0) {
        tb.innerHTML = '<tr><td colspan="11" class="text-center py-4 text-muted">Keine Daten</td></tr>';
        return;
    }

    tb.innerHTML = rows.map((r, i) => `
        <tr>
            <td>${r.day || '–'}</td>
            <td>${r.stations || '–'}</td>
            <td>${fmtKwh(r.home_kwh)}</td>
            <td>${fmtEUR(r.home_cost)}</td>
            <td>${r.home_solar_pct != null ? fmtPct(r.home_solar_pct) : '–'}</td>
            <td>${r.home_loss != null ? fmtKwh(r.home_loss) : '–'}</td>
            <td>${r.ext_kwh != null ? fmtKwh(r.ext_kwh) : '–'}</td>
            <td>${r.ext_cost != null ? fmtEUR(r.ext_cost) : '–'}</td>
            <td><strong>${fmtKwh(r.total_kwh)}</strong></td>
            <td><strong>${fmtEUR(r.total_cost)}</strong></td>
            <td><button class="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="collapse" data-bs-target="#m${i}">▾</button></td>
        </tr>
        <tr class="collapse-row"><td colspan="11" class="p-0">
            <div class="collapse" id="m${i}"><div class="p-2 bg-light">${buildDetail(r)}</div></div>
        </td></tr>
    `).join('');
}

function buildDetail(r) {
    if (!r) return '';
    return `
        <div class="row mb-2">
            <div class="col-md-4"><strong>EVCC:</strong> ${fmtKwh(r.evcc_kwh)} kWh (${fmtEUR(r.evcc_cost)})</div>
            <div class="col-md-4"><strong>TeslaMate:</strong> ${fmtKwh(r.teslamate_kwh)} kWh (${fmtEUR(r.teslamate_cost)})</div>
            <div class="col-md-4"><strong>Plus:</strong> ${fmtKwh(r.extra_kwh)} (${fmtEUR(r.extra)})</div>
            <div class="col-md-4"><strong>PV-Anteil:</strong> ${r.home_solar_pct != null ? fmtPct(r.home_solar_pct) : '–'}</div>
            <div class="col-md-4"><strong>Range:</strong> ${r.range_km} km</div>
            <div class="col-md-4"><strong>EVCC-Radius:</strong> ${r.evcc_range} km</div>
        </div>
    `;
}

function renderKPIs(stats, rows) {
    const summaryEl = safeGet('#summaryCards');
    if (!summaryEl) return;

    const homeKwh = stats.home_kwh || stats.kwh || 0;
    const extKwh = stats.ext_kwh || 0;
    const totalCost = stats.tco || stats.total_cost || stats.cost_home_and_external || 0;
    const totalKm = stats.total_km || 0;
    const consumption = stats.consumption_net || stats.consumption_kwh_per_100km || 0;
    const homeLoss = stats.home_loss_kwh || 0;

    const kpiItems = [
        { id: 'kmDrive', label: 'Gefahrene km', value: totalKm, suffix: 'km' },
        { id: 'kwhCharged', label: 'Geladene kWh', value: homeKwh + extKwh, suffix: 'kWh' },
        { id: 'consumption', label: 'Verbrauch', value: consumption, suffix: 'kWh/100km' },
        { id: 'cost', label: 'Kosten', value: totalCost, suffix: '€' },
        { id: 'loss', label: 'Ladeverluste', value: homeLoss, suffix: 'kWh' }
    ];

    summaryEl.innerHTML = kpiItems.map(kpi => `
        <div class="col-12 col-sm-6 col-md-2">
            <div class="card kpi-card h-100">
                <div class="card-body">
                    <div class="kpi-value" style="color: #667eea; font-weight: 700;">
                        ${typeof kpi.value === 'number' ? kpi.value.toLocaleString('de-DE', {maximumFractionDigits: 2}) : kpi.value} ${kpi.suffix}
                    </div>
                    <div class="kpi-label" style="color: #6c757d;">${kpi.label}</div>
                </div>
            </div>
        </div>
    `).join('');
}

function renderCharts(chartsData, stats) {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js not loaded');
        return;
    }

    const series = chartsData?.series || [];
    if (!series || series.length === 0) {
        console.warn('No chart data');
        return;
    }

    const days = series.map(s => s.day || '').filter(d => d);
    
    // Verbrauch: verwende kwh falls consumption null/undefined ist
    const consumptionData = series.map(s => {
        const val = s.consumption ?? s.kwh;
        return val != null ? Number(val) : 0;
    });
    
    const costData = series.map(s => {
        const val = s.cost;
        return val != null ? Number(val) : 0;
    });
    
    // Kilometer: verwende cum_km (kumuliert) falls km 0 oder null ist
    const kmData = series.map(s => {
        if (s.km != null && Number(s.km) > 0) return Number(s.km);
        return s.cum_km != null ? Number(s.cum_km) : 0;
    });
    
    const priceData = series.map(s => {
        const val = s.price_per_kwh;
        return val != null ? Number(val) : 0;
    });
    
    // Stats values for Home/Extern
    const homeKwh = stats.home_kwh || stats.kwh || 0;
    const extKwh = stats.ext_kwh || 0;

    const getColor = (light, dark) => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? dark : light;
    };

    // Destroy existing
    Object.values(charts).forEach(c => c && c.destroy());

    // Consumption Chart
    const canvasConsumption = document.getElementById('chartConsumption');
    if (canvasConsumption && days.length > 0) {
        const avgConsumption = consumptionData.reduce((a, b) => a + b, 0) / consumptionData.length;
        charts.consumption = new Chart(canvasConsumption, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Verbrauch',
                    data: consumptionData,
                    borderColor: getColor('#1976d2', '#90caf9'),
                    backgroundColor: 'rgba(25, 118, 210, 0.1)',
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `Verbrauch: ${ctx.raw.toFixed(2)} kWh`
                        }
                    }
                },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
        const badge = document.getElementById('avgConsumptionBadge');
        if (badge) badge.textContent = `Ø ${avgConsumption.toFixed(2)} kWh`;
    }

    // Cost Chart
    const canvasCost = document.getElementById('chartCost');
    if (canvasCost && days.length > 0) {
        const avgCost = costData.reduce((a, b) => a + b, 0) / costData.length;
        charts.cost = new Chart(canvasCost, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Kosten',
                    data: costData,
                    borderColor: getColor('#d32f2f', '#ef5350'),
                    backgroundColor: 'rgba(211, 47, 47, 0.1)',
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
        const badge = document.getElementById('avgCostBadge');
        if (badge) badge.textContent = `Ø ${avgCost.toFixed(2)} €`;
    }

    // KM Chart
    const canvasKm = document.getElementById('chartKm');
    if (canvasKm && days.length > 0) {
        const totalKm = kmData.reduce((a, b) => a + b, 0);
        charts.km = new Chart(canvasKm, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: ' Kilometer',
                    data: kmData,
                    borderColor: getColor('#388e3c', '#66bb6a'),
                    backgroundColor: 'rgba(56, 142, 60, 0.1)',
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
        const badge = document.getElementById('totalKmBadge');
        if (badge) badge.textContent = `Σ ${totalKm.toLocaleString('de-DE')}`;
    }

    // Home/Extern Donut
    const canvasHome = document.getElementById('chartHomeExtern');
    if (canvasHome) {
        const total = homeKwh + extKwh;
        charts.homeExtern = new Chart(canvasHome, {
            type: 'doughnut',
            data: {
                labels: ['Zuhause', 'Extern'],
                datasets: [{
                    data: [homeKwh, extKwh],
                    backgroundColor: [getColor('#4CAF50', '#81c784'), getColor('#2196F3', '#64b5f6')],
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: { display: false }
                }
            }
        });
        document.getElementById('homeKwh').textContent = `${homeKwh.toFixed(1)} kWh`;
        document.getElementById('extKwh').textContent = `${extKwh.toFixed(1)} kWh`;
        document.getElementById('homePct').textContent = `${total > 0 ? (homeKwh/total*100).toFixed(1) : '0'}%`;
        document.getElementById('extPct').textContent = `${total > 0 ? (extKwh/total*100).toFixed(1) : '0'}%`;
        document.getElementById('homePrice').textContent = `Ø ${stats.avg_home_price?.toFixed(2) || '–'} €/kWh`;
        document.getElementById('extPrice').textContent = `Ø ${stats.avg_ext_price?.toFixed(2) || '–'} €/kWh`;
    }
}

function renderPaginationMerged(total) {
    const navEl = safeGet('#paginationMerged');
    if (!navEl) return;
    const totalPages = Math.ceil(total / PER_PAGE);
    if (totalPages <= 1) { navEl.innerHTML = ''; return; }
    let html = `<ul class="pagination pagination-sm justify-content-center mb-0">`;
    html += `<li class="page-item ${currentPageMerged === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPageMerged - 1}">«</a></li>`;
    for (let i = 1; i <= totalPages; i++) {
        html += `<li class="page-item ${currentPageMerged === i ? ' active' : ''}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
    }
    html += `<li class="page-item ${currentPageMerged === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPageMerged + 1}">»</a></li>`;
    html += '</ul>';
    navEl.innerHTML = html;
    document.querySelectorAll('#paginationMerged .page-link').forEach(link => {
        link.addEventListener('click', (e) => { e.preventDefault(); currentPageMerged = parseInt(link.getAttribute('data-page'), 10); loadOverview(); });
    });
}

function updateRangeLabel() {
    const labelEl = safeGet('.range-label');
    if (!labelEl) return;
    const days = getGlobalDays();
    if (days >= 9999) labelEl.textContent = 'Alle Daten';
    else labelEl.textContent = `Letzte ${days} Tage`;
}

function fmtKwh(v) { 
    if (v == null) return '–';
    if (typeof v === 'number') return v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' kWh';
    return v;
}

function fmtEUR(v) { 
    if (v == null) return '–';
    if (typeof v === 'number') return v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' €';
    return v;
}

function fmtPct(v) { 
    if (v == null) return '–';
    if (typeof v === 'number') return v.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + '%';
    return v;
}

window.loadOverview = loadOverview;

// Init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadOverview);
} else {
    loadOverview();
}