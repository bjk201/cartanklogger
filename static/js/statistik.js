// statistik.js - Statistik Seite mit vollständigen Chart-Implementierungen

let currentDays = 30;
let charts = {};

function getCurrentDays() {
    const activeBtn = document.querySelector('[data-days].active');
    return activeBtn ? parseInt(activeBtn.getAttribute('data-days'), 10) : 30;
}

async function loadStats() {
    console.log('Loading stats data...', { days: getCurrentDays() });
    const days = getCurrentDays();
    
    try {
        const statsResp = await fetch(`/api/stats?days=${days}`, {credentials: "same-origin"});
        const statsData = await statsResp.json();
        
        const chartsResp = await fetch(`/api/charts?days=${days}`, {credentials: "same-origin"});
        const chartsData = await chartsResp.json();
        
        console.log('Stats data:', statsData);
        console.log('Charts data:', chartsData?.series?.length, 'entries');
        
        renderKPIs(statsData.totals || {});
        renderCharts(chartsData, statsData);
        updateRangeLabel();
    } catch (e) {
        console.error('Stats load error:', e);
        const kpiEl = document.getElementById('statsKpis');
        if (kpiEl) {
            kpiEl.innerHTML = '<div class="col-12"><div class="card"><div class="card-body text-center py-4 text-muted">Fehler beim Laden der Daten</div></div></div>';
        }
    }
}

function updateRangeLabel() {
    const el = document.getElementById('globalRangeLabel');
    if (!el) return;
    el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
}

function renderKPIs(totals) {
    const kpiEl = document.getElementById('statsKpis');
    if (!kpiEl) return;
    
    const kpis = [
        { label: 'Gefahrene km', value: totals.total_km || 0, suffix: 'km' },
        { label: 'Geladene kWh', value: totals.kwh || totals.home_kwh || 0, suffix: 'kWh' },
        { label: 'Verbrauch', value: totals.consumption_kwh_per_100km || totals.consumption_net || 0, suffix: 'kWh/100km' },
        { label: 'Kosten', value: totals.tco || totals.total_cost || 0, suffix: '€' },
        { label: 'Ladeverluste', value: totals.home_loss_kwh || 0, suffix: 'kWh' }
    ];
    
    kpiEl.innerHTML = kpis.map(kpi => `
        <div class="col-12 col-sm-6 col-md-2">
            <div class="card kpi-card h-100">
                <div class="card-body">
                    <div class="kpi-value" style="color: #667eea; font-weight: 700;">
                        ${typeof kpi.value === 'number' ? kpi.value.toLocaleString('de-DE', {maximumFractionDigits: 1}) : kpi.value} ${kpi.suffix}
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

    const getColor = (light, dark) => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? dark : light;
    };
    
    // Destroy existing charts
    ['chartCons', 'chartPrice', 'chartCost100', 'chartKm'].forEach(id => {
        if (charts[id]) {
            charts[id].destroy();
            charts[id] = null;
        }
    });
    
    // Get chart types from dropdowns
    const typeCons = document.querySelector('.chart-type-select[data-chart="chartCons"]')?.value || 'line';
    const typePrice = document.querySelector('.chart-type-select[data-chart="chartPrice"]')?.value || 'line';
    const typeCost = document.querySelector('.chart-type-select[data-chart="chartCost100"]')?.value || 'line';
    const typeKm = document.querySelector('.chart-type-select[data-chart="chartKm"]')?.value || 'line';
    
    // Consumption Chart
    const canvasCons = document.getElementById('chartCons');
    if (canvasCons && days.length > 0) {
        charts.chartCons = new Chart(canvasCons, {
            type: typeCons,
            data: {
                labels: days,
                datasets: [{
                    label: 'Verbrauch',
                    data: consumptionData,
                    borderColor: getColor('#1976d2', '#90caf9'),
                    backgroundColor: getColor('#1976d2', '#90caf9'),
                    fill: typeCons === 'line',
                    tension: typeCons === 'line' ? 0.3 : 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
    }
    
    // Price Chart
    const canvasPrice = document.getElementById('chartPrice');
    if (canvasPrice && days.length > 0) {
        charts.chartPrice = new Chart(canvasPrice, {
            type: typePrice,
            data: {
                labels: days,
                datasets: [{
                    label: 'Preis (€/kWh)',
                    data: priceData,
                    borderColor: getColor('#388e3c', '#66bb6a'),
                    backgroundColor: getColor('#388e3c', '#66bb6a'),
                    fill: typePrice === 'line',
                    tension: typePrice === 'line' ? 0.3 : 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
    }
    
    // Cost per 100km Chart
    const canvasCost = document.getElementById('chartCost100');
    if (canvasCost && days.length > 0) {
        const costPer100 = series.map((s, i) => {
            const kwh = consumptionData[i] || 0;
            const cost = costData[i] || 0;
            return kwh > 0 ? cost / kwh * 100 : 0;
        });
        charts.chartCost100 = new Chart(canvasCost, {
            type: typeCost,
            data: {
                labels: days,
                datasets: [{
                    label: 'Kosten (€/100km)',
                    data: costPer100,
                    borderColor: getColor('#d32f2f', '#ef5350'),
                    backgroundColor: getColor('#d32f2f', '#ef5350'),
                    fill: typeCost === 'line',
                    tension: typeCost === 'line' ? 0.3 : 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
    }
    
    // KM Chart
    const canvasKm = document.getElementById('chartKm');
    if (canvasKm && days.length > 0) {
        charts.chartKm = new Chart(canvasKm, {
            type: typeKm,
            data: {
                labels: days,
                datasets: [{
                    label: 'Kilometer',
                    data: kmData,
                    borderColor: getColor('#388e3c', '#66bb6a'),
                    backgroundColor: getColor('#388e3c', '#66bb6a'),
                    fill: typeKm === 'line',
                    tension: typeKm === 'line' ? 0.3 : 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
    }
}

// Event listeners for day buttons
document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDays = parseInt(btn.getAttribute('data-days'), 10);
        loadStats();
    });
});

// Event listeners for chart type selectors
document.querySelectorAll('.chart-type-select').forEach(select => {
    select.addEventListener('change', () => {
        loadStats(); // Re-render with new type
    });
});

// Global range listener
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
    loadStats();
});

// Init
document.addEventListener('DOMContentLoaded', loadStats);