// statistik.js - Statistik Seite mit vollständigen Chart-Implementierungen

let currentDays = 30;
let currentFrom = null;
let currentTo = null;

// Chart instances
let charts = {
    chartCons: null,
    chartPrice: null,
    chartCost100: null,
    chartKm: null,
    heatmapTemp: null,
    heatmapWeekday: null
};

function getCurrentDays() {
    const activeBtn = document.querySelector('[data-days].active');
    return activeBtn ? parseInt(activeBtn.getAttribute('data-days'), 10) : 30;
}

async function loadStats() {
    console.log('Loading stats data...');
    
    const days = getCurrentDays();
    
    try {
        // Load stats data
        const statsResp = await fetch(`/api/stats?days=${days}`, {credentials: "same-origin"});
        const statsData = await statsResp.json();
        
        // Load charts data
        const chartsResp = await fetch(`/api/charts?days=${days}`, {credentials: "same-origin"});
        const chartsData = await chartsResp.json();
        
        // Load price data
        const pricesResp = await fetch(`/api/price-periods`, {credentials: "same-origin"});
        const pricesData = await pricesResp.json();
        
        renderKPIs(statsData.totals || {});
        renderCharts(chartsData, statsData);
        renderHeatmaps(chartsData);
        updateRangeLabel();
        
    } catch (e) {
        console.error('Stats load error:', e);
        document.getElementById('statsKpis').innerHTML = '<div class="col-12"><div class="card"><div class="card-body text-center py-4 text-muted">Fehler beim Laden der Daten</div></div></div>';
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
        <div class="col-md-4 col-lg-2">
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
        console.warn('No chart data available');
        return;
    }
    
    const days = series.map(s => s.day).filter(d => d);
    const consumptionData = series.map(s => s.consumption || s.kwh || 0);
    const costData = series.map(s => s.cost || 0);
    const kmData = series.map(s => s.km || 0);
    const priceData = series.map(s => s.price_per_kwh || 0);
    
    const getColor = (light, dark) => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? dark : light;
    };
    
    // Destroy existing charts
    Object.values(charts).forEach(c => c && c.destroy());
    
    // Consumption Chart
    const canvasCons = document.getElementById('chartCons');
    if (canvasCons) {
        charts.chartCons = new Chart(canvasCons, {
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
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
    }
    
    // Price Chart
    const canvasPrice = document.getElementById('chartPrice');
    if (canvasPrice) {
        charts.chartPrice = new Chart(canvasPrice, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Preis (€/kWh)',
                    data: priceData,
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
    }
    
    // Cost per 100km Chart
    const canvasCost = document.getElementById('chartCost100');
    if (canvasCost) {
        const costPer100 = series.map(s => s.kwh > 0 ? (s.cost || 0) / s.kwh * 100 : 0);
        charts.chartCost100 = new Chart(canvasCost, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'Kosten (€/100km)',
                    data: costPer100,
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
    }
    
    // Kilometer Chart
    const canvasKm = document.getElementById('chartKm');
    if (canvasKm) {
        charts.chartKm = new Chart(canvasKm, {
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
                scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true } }
            }
        });
    }
}

function renderHeatmaps(data) {
    const series = data?.series || [];
    if (!series || series.length === 0) return;
    
    renderTempHeatmap(series);
    renderWeekdayHeatmap(series);
}

function renderTempHeatmap(series) {
    const canvas = document.getElementById('heatmapTempConsumption');
    if (!canvas) return;
    
    if (charts.heatmapTemp) charts.heatmapTemp.destroy();
    
    const data = series.slice(-14).reverse();
    const labels = data.map(s => s.day || '');
    const kwhValues = data.map(s => s.kwh || 0);
    
    charts.heatmapTemp = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'kWh',
                data: kwhValues,
                backgroundColor: kwhValues.map(v => v > 50 ? '#1677ff' : v > 20 ? '#52c41a' : v > 10 ? '#faad14' : '#ffccc7'),
                borderColor: '#fff',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { title: { text: 'Datum' }, ticks: { maxRotation: 45, minRotation: 45 } }, y: { title: { text: 'kWh' }, beginAtZero: true } }
        }
    });
    
    const legendEl = document.getElementById('legendTempConsumption');
    if (legendEl) {
        const avgKwh = kwhValues.reduce((a, b) => a + b, 0) / kwhValues.length;
        legendEl.textContent = `Ø: ${avgKwh.toFixed(1)} kWh`;
    }
}

function renderWeekdayHeatmap(series) {
    const canvas = document.getElementById('heatmapWeekdayConsumption');
    if (!canvas) return;
    
    if (charts.heatmapWeekday) charts.heatmapWeekday.destroy();
    
    const weekdayData = Array(7).fill(0);
    const dayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    
    series.forEach(s => {
        const date = new Date(s.day);
        if (!isNaN(date.getTime())) {
            weekdayData[date.getDay()] += s.kwh || 0;
        }
    });
    
    charts.heatmapWeekday = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: dayNames,
            datasets: [{
                label: 'kWh',
                data: weekdayData,
                backgroundColor: weekdayData.map(v => v > 50 ? '#1677ff' : v > 20 ? '#52c41a' : v > 10 ? '#faad14' : '#ffccc7'),
                borderColor: '#fff',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { title: { text: 'Wochentag' } }, y: { title: { text: 'kWh' }, beginAtZero: true } }
        }
    });
}

// Event listeners for day buttons
document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDays = parseInt(btn.getAttribute('data-days'), 10);
        currentFrom = null;
        currentTo = null;
        loadStats();
    });
});

// Global range listener
window.addEventListener('globalRangeChange', (e) => {
    const params = e.detail;
    if (params.startsWith('from=')) {
        const urlParams = new URLSearchParams(params);
        currentFrom = urlParams.get('from');
        currentTo = urlParams.get('to');
        currentDays = 365;
    } else {
        const urlParams = new URLSearchParams(params);
        currentDays = parseInt(urlParams.get('days'), 10);
        currentFrom = null;
        currentTo = null;
        document.querySelectorAll('[data-days]').forEach(b => {
            if (parseInt(b.getAttribute('data-days'), 10) === currentDays) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
    }
    loadStats();
});

// Initialize
document.addEventListener('DOMContentLoaded', loadStats);