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
        const params = buildApiParams(currentPageMerged);
        const [merged, stats, chartsData] = await Promise.all([
            fetch(`/api/merged?${params}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ rows: [], pagination: {} })),
            fetch(`/api/stats?days=${currentDays}${currentFrom ? '&from=' + currentFrom + '&to=' + currentTo : ''}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ totals: {}, home: {}, external: {}, monthly: [] })),
            fetch(`/api/charts?days=${currentDays}${currentFrom ? '&from=' + currentFrom + '&to=' + currentTo : ''}`, { credentials: "same-origin" }).then(r => r.json()).catch(() => ({ series: [], kpis: {} }))
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
    // Extract data from series for the three main charts
    // This is based on the API response structure from the working version
    const consumptionSeries = series.find(s => s.name === 'Verbrauch') || { data: [] };
    const costSeries = series.find(s => s.name === 'Kosten') || { data: [] };
    const kmSeries = series.find(s => s.name === 'km') || { data: [] };

    // Simplified chart rendering - in a real implementation, you'd use Chart.js
    const chartHtml = `
        <div class="row">
            <div class="col-lg-4">
                <div class="card chart-card">
                    <div class="card-header">
                        <h5>Verbrauch (kWh/100km)</h5>
                    </div>
                    <div class="card-body">
                        <div style="height: 250px; display: flex; align-items: center; justify-content: center;">
                            <div style="text-align: center;">
                                <div style="font-size: 2rem; font-weight: bold; color: #1976d2;">${stats?.totals?.consumption_kwh_per_100km?.toFixed(2) || '0.00'}</div>
                                <div style="font-size: 0.9rem; color: #6c757d;">Durchschnitt</div>
                                <div style="margin-top: 1rem; font-size: 0.85rem;">
                                    <div>Min: ${Math.min(...(consumptionSeries.data || [])).toFixed(2)} kWh</div>
                                    <div>Max: ${Math.max(...(consumptionSeries.data || [])).toFixed(2)} kWh</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="col-lg-4">
                <div class="card chart-card">
                    <div class="card-header">
                        <h5>Kosten (€)</h5>
                    </div>
                    <div class="card-body">
                        <div style="height: 250px; display: flex; align-items: center; justify-content: center;">
                            <div style="text-align: center;">
                                <div style="font-size: 2rem; font-weight: bold; color: #d32f2f;">${stats?.totals?.tco?.toFixed(2) || '0.00'}</div>
                                <div style="font-size: 0.9rem; color: #6c757d;">Gesamt</div>
                                <div style="margin-top: 1rem; font-size: 0.85rem;">
                                    <div>Heute: ${stats?.totals?.today_cost?.toFixed(2) || '0.00'} €</div>
                                    <div>PV-Anteil: ${stats?.totals?.pv_share_pct?.toFixed(1) || '0.0'}%</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="col-lg-4">
                <div class="card chart-card">
                    <div class="card-header">
                        <h5>km (Tag)</h5>
                    </div>
                    <div class="card-body">
                        <div style="height: 250px; display: flex; align-items: center; justify-content: center;">
                            <div style="text-align: center;">
                                <div style="font-size: 2rem; font-weight: bold; color: #388e3c;">${stats?.totals?.daily_km?.toFixed(0) || '0'}</div>
                                <div style="font-size: 0.9rem; color: #6c757d;">Durchschnitt</div>
                                <div style="margin-top: 1rem; font-size: 0.85rem;">
                                    <div>Min: ${Math.min(...(kmSeries.data || [])).toFixed(0)} km</div>
                                    <div>Max: ${Math.max(...(kmSeries.data || [])).toFixed(0)} km</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    chartContainer.innerHTML = chartHtml;
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