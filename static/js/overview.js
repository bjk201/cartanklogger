// overview.js - Übersichtsseite (Dashboard mit 5 KPIs, 3 Charts links, Donut + 2 Heatmaps rechts)
// Refactored from version 9857467, the last working version before MD3 changes
let currentDays = 90;
let currentFrom = null;
let currentTo = null;
let currentPageMerged = 1;
const PER_PAGE = 20;

// Chart instances for cleanup
let charts = {
    consumption: null,
    cost: null,
    km: null,
    homeExtern: null,
    heatmapTemp: null,
    heatmapWeekday: null
};

function buildApiParams(page) {
    if (typeof getGlobalRangeParams === 'function') {
        return getGlobalRangeParams() + `&page=${page}&per_page=${PER_PAGE}`;
    }
    if (currentFrom && currentTo) {
        return `from=${currentFrom}&to=${currentTo}&page=${page}&per_page=${PER_PAGE}`;
    }
    return `days=${currentDays}&page=${page}&per_page=${PER_PAGE}`;
}

// Defensive DOM helpers - ensure all getElementById calls are safe
function safeGet(selector) {
    const el = document.querySelector(selector);
    if (!el) console.error(`Element not found: ${selector}`);
    return el;
}

async function loadOverview() {
    try {
        // Use global date range from base.html if available
        const days = typeof globalDateRange !== 'undefined' ? globalDateRange.days : 90;
        const from = typeof globalDateRange !== 'undefined' ? globalDateRange.from : null;
        const to = typeof globalDateRange !== 'undefined' ? globalDateRange.to : null;
        
        const paramsStats = from && to ? `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : `days=${days}`;
        const paramsCharts = paramsStats;
        
        const [merged, stats, chartsData] = await Promise.all([
            fetch(`/api/merged?days=${days}${from ? '&from=' + from + '&to=' + to : ''}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ rows: [], pagination: {} })),
            fetch(`/api/stats?${paramsStats}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ totals: {}, home: {}, external: {}, monthly: [] })),
            fetch(`/api/charts?${paramsCharts}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ series: [], kpis: {} }))
        ]);

        renderMergedTable(merged.rows || merged);
        renderPaginationMerged(merged.pagination?.total || merged.pagination?.merged_total || 0);
        renderKPIs(stats, merged.rows || merged);
        renderCharts(chartsData, stats);
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
            <td>${r.home_solar_pct ? fmtPct(r.home_solar_pct) : '–'}</td>
            <td>${r.home_loss ? fmtKwh(r.home_loss) : '–'}</td>
            <td>${r.ext_kwh ? fmtKwh(r.ext_kwh) : '–'}</td>
            <td>${r.ext_cost ? fmtEUR(r.ext_cost) : '–'}</td>
            <td><strong>${fmtKwh(r.total_kwh)}</strong></td>
            <td><strong>${fmtEUR(r.total_cost)}</strong></td>
            <td><button class="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="collapse" data-bs-target="#m${i}">▾</button></td>
        </tr>
        <tr class="collapse-row"><td colspan="11" class="p-0">
            <div class="collapse" id="m${i}"><div class="p-2 bg-light">${buildDetail(r)}</div></div>
        </td></tr>
    `).join('');
}

function renderPaginationMerged(totalRows) {
    const totalPages = Math.ceil(totalRows / PER_PAGE);
    const nav = safeGet('#paginationMerged');
    if (!nav) return;

    if (totalPages <= 1) {
        nav.innerHTML = '';
        return;
    }

    let html = '<ul class="pagination pagination-sm justify-content-center mb-0">';
    html += `<li class="page-item ${currentPageMerged === 1 ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPageMerged - 1}">‹</a></li>`;

    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPageMerged - 1 && i <= currentPageMerged + 1)) {
            html += `<li class="page-item ${i === currentPageMerged ? 'active' : ''}"><a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
        } else if (i === currentPageMerged - 2 || i === currentPageMerged + 2) {
            html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
        }
    }

    html += `<li class="page-item ${currentPageMerged === totalPages ? 'disabled' : ''}"><a class="page-link" href="#" data-page="${currentPageMerged + 1}">›</a></li>`;
    html += '</ul>';

    nav.innerHTML = html;
}

function buildDetail(r) {
    if (!r) return '';
    return `
        <div class="row mb-2">
            <div class="col-md-4"><strong>EVCC:</strong> ${fmtKwh(r.evcc_kwh)} kWh (${fmtEUR(r.evcc_cost)})</div>
            <div class="col-md-4"><strong>TeslaMate:</strong> ${fmtKwh(r.teslamate_kwh)} kWh (${fmtEUR(r.teslamate_cost)})</div>
            <div class="col-md-4"><strong>Plus:</strong> ${fmtKwh(r.extra_kwh)} (${fmtEUR(r.extra)})</div>
            <div class="col-md-4"><strong>PV-Anteil:</strong> ${r.home_solar_pct ? fmtPct(r.home_solar_pct) : '–'}</div>
            <div class="col-md-4"><strong>Range:</strong> ${r.range_km} km</div>
            <div class="col-md-4"><strong>EVCC-Radius:</strong> ${r.evcc_range} km</div>
            <div class="col-md-4"><strong>TM-Radius:</strong> ${r.teslamate_range} km</div>
        </div>
    `;
}

function renderKPIs(stats, rows) {
    const summaryEl = safeGet('#summaryCards');
    if (!summaryEl) return;

    // Extract key values from stats API
    const statsKPIs = {
        home_kwh: stats?.totals?.kwh || stats?.totals?.home_kwh || 0,
        ext_kwh: stats?.totals?.ext_kwh || 0,
        total_cost: stats?.totals?.cost_home_and_external || stats?.totals?.tco || 0,
        total_km: stats?.totals?.total_km || 0,
        home_loss_kwh: stats?.totals?.home_loss_kwh || 0,
        consumption_net: stats?.totals?.consumption_net_kwh_per_100km || stats?.totals?.consumption_kwh_per_100km || 0,
    };

    const mergedRows = rows?.rows || rows;
    const todayMerged = mergedRows && mergedRows.length ? mergedRows[0] : null;

    // KPI definitions with labels and values
    const kpiItems = [
        {
            id: 'kmDrive',
            label: 'Gefahrene km',
            value: statsKPIs.total_km,
            suffix: 'km',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L9 9h6l3-7zm0 0l3 7h-6L9 2zm0 0v13m0 0l-4-4m8 0l-4 4"/></svg>',
            color: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            today: todayMerged?.range_km || 0,
            todayLabel: 'Heute'
        },
        {
            id: 'kwhCharged',
            label: 'Geladene kWh',
            value: statsKPIs.home_kwh + statsKPIs.ext_kwh,
            suffix: 'kWh',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1-3 12.79A9 9 0 1 1 21 12.79z"/></svg>',
            color: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
            today: todayMerged?.total_kwh || 0,
            todayLabel: 'Heute'
        },
        {
            id: 'consumption',
            label: 'Verbrauch',
            value: statsKPIs.consumption_net,
            suffix: 'kWh/100km',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10M12 4V12l8-6M12 4L4 10M20 12H4"/></svg>',
            color: 'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
            today: todayMerged?.['consumption_kwh_per_100km'] || 0,
            todayLabel: 'Heute'
        },
        {
            id: 'cost',
            label: 'Kosten',
            value: statsKPIs.total_cost,
            suffix: '€',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C8 6 5 9.5 5 14c0 4.5 4 7.5 4 7.5s4-3 4-7.5c0-4.5-3-8-7-12z"/><path d="M12 22V12M9 12h6"/></svg>',
            color: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
            today: todayMerged?.total_cost || 0,
            todayLabel: 'Heute'
        },
        {
            id: 'loss',
            label: 'Ladeverluste',
            value: statsKPIs.home_loss_kwh,
            suffix: 'kWh',
            icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8l-6-6zM13 3l4 4M8 10h4M8 14h4M8 18h4"/></svg>',
            color: 'linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%)',
            today: null,
            todayLabel: ''
        }
    ];

    // Render KPI cards
    summaryEl.innerHTML = kpiItems.map(kpi => `
        <div class="col-md-4 col-lg-2-5 col-sm-6">
            <div class="card kpi-card h-100">
                <div class="card-body" style="border-left: 4px solid ${kpi.color}">
                    <div class="d-flex align-items-center justify-content-between mb-2">
                        <div class="kpi-value" style="color: ${kpi.color}; font-weight: 700;">${typeof kpi.value === 'number' ? kpi.value.toLocaleString('de-DE', {maximumFractionDigits: 2}) : kpi.value}${kpi.suffix}</div>
                        <div style="color: ${kpi.color};">${kpi.icon}</div>
                    </div>
                    <div class="kpi-label" style="color: #6c757d;">${kpi.label}</div>
                    ${kpi.today ? `
                        <div style="font-size: 0.85rem; color: #6c757d; margin-top: 0.5rem;">
                            ${kpi.todayLabel}: <strong>${typeof kpi.today === 'number' ? kpi.today.toLocaleString('de-DE', {maximumFractionDigits: 1}) : kpi.today}${kpi.suffix}</strong>
                        </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

function renderCharts(chartsData, stats) {
    const chartContainer = safeGet('#chartContainer');
    if (!chartContainer) return;

    // Clear existing charts
    chartContainer.innerHTML = '';

    // Use the charts data from the API
    const series = chartsData?.series || chartsData?.data?.series || [];

    if (!series || series.length === 0) {
        chartContainer.innerHTML = '<div class="text-center text-muted py-4">Keine Chart-Daten verfügbar</div>';
        return;
    }

    // Render chart based on data structure
    renderOverviewCharts(series, stats);
}

function renderOverviewCharts(series, stats) {
    // Check if Chart.js is available
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js not loaded');
        chartContainer.innerHTML = '<div class="text-center text-muted py-4">Chart.js nicht geladen</div>';
        return;
    }

    // Extract daily data from series
    const days = series.map(s => s.day).filter(d => d);
    const consumptionData = series.map(s => s.consumption || s.kwh || 0);
    const costData = series.map(s => s.cost || 0);
    const kmData = series.map(s => s.km || 0);

    // Helper to get color from CSS variable (dark mode aware)
    const getColor = (light, dark) => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? dark : light;
    };

    // Create HTML structure with canvas elements
    const chartHtml = `
        <div class="row g-3">
            <div class="col-lg-4">
                <div class="card chart-card h-100">
                    <div class="card-header py-2">
                        <h6 class mb-0">⚡ Verbrauch (kWh/100km)</h6>
                    </div>
                    <div class="card-body py-2">
                        <canvas id="chartConsumption" height="180"></canvas>
                    </div>
                </div>
            </div>
            <div class="col-lg-4">
                <div class="card chart-card h-100">
                    <div class="card-header py-2">
                        <h6 class mb-0">💶 Kosten (€)</h6>
                    </div>
                    <div class="card-body py-2">
                        <canvas id="chartCost" height="180"></canvas>
                    </div>
                </div>
            </div>
            <div class="col-lg-4">
                <div class="card chart-card h-100">
                    <div class="card-header py-2">
                        <h6 class mb-0">🛣️ Kilometer (km)</h6>
                    </div>
                    <div class="card-body py-2">
                        <canvas id="chartKm" height="180"></canvas>
                    </div>
                </div>
            </div>
        </div>
        <div class="row g-3 mt-2">
            <div class="col-12 col-lg-6">
                <div class="card chart-card h-100">
                    <div class="card-header py-2">
                        <h6 class mb-0">🏠🔌 Home vs. Extern (kWh)</h6>
                    </div>
                    <div class="card-body py-2">
                        <canvas id="chartHomeExtern" height="180"></canvas>
                    </div>
                </div>
            </div>
        </div>
    `;

    chartContainer.innerHTML = chartHtml;

    // Get canvas elements
    const canvasConsumption = document.getElementById('chartConsumption');
    const canvasCost = document.getElementById('chartCost');
    const canvasKm = document.getElementById('chartKm');
    const canvasHomeExtern = document.getElementById('chartHomeExtern');

    // Destroy existing charts to prevent memory leaks
    if (charts.consumption) charts.consumption.destroy();
    if (charts.cost) charts.cost.destroy();
    if (charts.km) charts.km.destroy();
    if (charts.homeExtern) charts.homeExtern.destroy();

    // Create line chart for consumption
    if (canvasConsumption) {
        charts.consumption = new Chart(canvasConsumption, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Verbrauch (kWh)',
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
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { maxTicksLimit: 7 } },
                    y: { beginAtZero: true }
                }
            }
        });
    }

    // Create line chart for cost
    if (canvasCost) {
        charts.cost = new Chart(canvasCost, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Kosten (€)',
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
                scales: {
                    x: { ticks: { maxTicksLimit: 7 } },
                    y: { beginAtZero: true }
                }
            }
        });
    }

    // Create line chart for km
    if (canvasKm) {
        charts.km = new Chart(canvasKm, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Kilometer',
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
                scales: {
                    x: { ticks: { maxTicksLimit: 7 } },
                    y: { beginAtZero: true }
                }
            }
        });
    }

    // Create pie/donut chart for Home vs Extern
    if (canvasHomeExtern) {
        const homeKwh = stats?.totals?.home_kwh || 0;
        const extKwh = stats?.totals?.ext_kwh || 0;
        const totalKwh = homeKwh + extKwh;
        const homePct = totalKwh > 0 ? (homeKwh / totalKwh * 100) : 0;
        const extPct = totalKwh > 0 ? (extKwh / totalKwh * 100) : 0;

        charts.homeExtern = new Chart(canvasHomeExtern, {
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
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed;
                                return `${label}: ${value.toFixed(1)} kWh (${(value/totalKwh*100).toFixed(1)}%)`;
                            }
                        }
                    }
                }
            }
        });
    }
}

function updateRangeLabel() {
    const labelEl = safeGet('.range-label');
    if (!labelEl) return;

    let labelText = 'Letzte 90 Tage';
    if (currentFrom && currentTo) {
        labelText = `${currentFrom} bis ${currentTo}`;
    }

    labelEl.textContent = labelText;
}

// Global Range Handler - this should be loaded from the main JS
function getGlobalRangeParams() {
    const from = safeGet('#rangeFrom');
    const to = safeGet('#rangeTo');
    if (from && from.value && to && to.value) {
        return `from=${from.value}&to=${to.value}`;
    }
    return `days=90`;
}

// Event Listeners
function attachEventListeners() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-page]');
        if (el) {
            e.preventDefault();
            currentPageMerged = parseInt(el.dataset.page);
            loadOverview();
        }
    });

    // Global Range Selector - attach to date picker if present
    const rangeInputs = document.querySelectorAll('#rangeFrom, #rangeTo');
    if (rangeInputs.length > 0) {
        rangeInputs.forEach(input => {
            input.addEventListener('change', () => {
                currentFrom = document.getElementById('rangeFrom')?.value || null;
                currentTo = document.getElementById('rangeTo')?.value || null;
                currentPageMerged = 1;
                loadOverview();
            });
        });
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverview);
} else {
    initOverview();
}

function initOverview() {
    attachEventListeners();

    // Check if we have a global range selector
    if (typeof getGlobalRangeParams === 'function') {
        const params = getGlobalRangeParams();
        currentDays = params.includes('days=') ? parseInt(params.split('days=')[1].split('&')[0]) : 90;
        const fromMatch = params.match(/from=([^&]+)/);
        currentFrom = fromMatch ? fromMatch[1] : null;
        const toMatch = params.match(/to=([^&]+)/);
        currentTo = toMatch ? toMatch[1] : null;
    }

    loadOverview();
    
    // Update range label if it exists
    updateRangeLabel();
}

// Utility functions
function fmtKwh(v) { return typeof v === 'number' ? v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' kWh' : v || '–'; }
function fmtEUR(v) { return typeof v === 'number' ? v.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' €' : v || '–'; }
function fmtPct(v) { return typeof v === 'number' ? v.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + '%' : v || '–'; }

// Global convenience functions for backward compatibility
window.loadOverview = loadOverview;