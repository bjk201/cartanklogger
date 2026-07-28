// statistik.js - Statistics Page with Material Design 3 Dashboard

// Chart States for Statistics Page - each chart is independent
const chartStates = {
  chartCons:   { type: 'line', showMA: true },
  chartPrice:  { type: 'line', showMA: true },
  chartCost100:{ type: 'line', showMA: true },
  chartKm:     { type: 'line', showMA: true }
};

let currentChartDays = 365;
let currentChartFrom = null;
let currentChartTo = null;
const MOVING_AVG_WINDOW = 7;

function buildChartApiParams() {
  if (currentChartFrom && currentChartTo) {
    return `from=${currentChartFrom}&to=${currentChartTo}`;
  }
  return `days=${currentChartDays}`;
}

function loadStats() {
  const params = buildChartApiParams();

  // Load stats data for KPIs
  fetch(`/api/stats?${params}`)
    .then(r => r.json())
    .then(data => {
      renderStatsKPIs(data);
    })
    .catch(e => console.error('Load stats KPIs error:', e));

  // Load chart data via separate endpoint
  fetch(`/api/charts?${params}`)
    .then(r => r.json())
    .then(data => {
      renderStatsCharts(data);
    })
    .catch(e => console.error('Load stats charts error:', e));
}

function renderStatsKPIs(statsData) {
  // Render KPI cards for statistics page
  const container = document.getElementById('statsKpis');
  if (!container) return;

  const totals = statsData.totals || {};
  const home = statsData.home || {};
  const external = statsData.external || {};

  const kpis = [
    {
      icon: '💶',
      title: 'Kosten diesen Monat',
      value: formatCurrency(totals.cost_this_month || 0),
      subtitle: totals.month || '–',
      class: 'success'
    },
    {
      icon: '⚡',
      title: 'Geladene Energie',
      value: formatKWh(totals.total_kwh || 0),
      subtitle: `Zuhause ${formatKWh(home.home_kwh || 0)} · Extern ${formatKWh(external.ext_kwh || 0)}`,
      class: 'primary'
    },
    {
      icon: '🛣️',
      title: 'Gefahrene km',
      value: formatNumber(totals.total_km || 0) + ' km',
      subtitle: 'Summe Tagesdistanzen',
      class: 'secondary'
    },
    {
      icon: '💡',
      title: 'Kosten / 100 km',
      value: formatCurrency(totals.tco_per_100km) + ' /100km',
      subtitle: `TCO ${formatCurrency(totals.tco)}`,
      class: 'warning'
    },
    {
      icon: '🔋',
      title: 'Verbrauch',
      value: formatKWh(totals.consumption_kwh_per_100km) + ' /100km',
      subtitle: `Akku ≈ ${formatKWh(totals.consumption_net_kwh_per_100km)} (geschätzt)`,
      class: 'info'
    },
    {
      icon: '☀️',
      title: 'PV-Anteil',
      value: formatPercent(home.pv_share_pct),
      subtitle: `${formatKWh(home.pv_kwh || 0)} PV von ${formatKWh(home.home_kwh)}`,
      class: 'success'
    },
    {
      icon: '🏠',
      title: 'Zuhause vs. Extern',
      value: `${(totals.home_share_pct || 0).toFixed(1)}% Zuhause`,
      subtitle: `${formatKWh(home.home_kwh)} zu Hause · ${formatKWh(external.ext_kwh)} extern`,
      class: 'primary'
    },
    {
      icon: '🔌',
      title: 'Ladeverluste',
      value: formatKWh(totals.home_loss_kwh),
      subtitle: 'Wallbox → Akku (Differenz)',
      class: 'dark'
    }
  ];

  container.innerHTML = kpis.map(kpi => `
    <div class="col">
      <div class="card kpi-card">
        <div class="card-body">
          <div class="d-flex align-items-center">
            <div class="me-3 fs-3">
              ${kpi.icon}
            </div>
            <div class="flex-grow-1">
              <div class="small text-muted mb-1">
                ${kpi.title}
              </div>
              <div class="h5 mb-0">
                ${kpi.value}
              </div>
              <div class="small text-muted">
                ${kpi.subtitle}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `).join('');
}

function renderStatsCharts(chartsData) {
  // Render the 4 main charts with Material Design 3 styling
  const series = chartsData.series || [];

  // Group series by type
  const consumptionData = series.filter(item => item.type === 'consumption');
  const priceData = series.filter(item => item.type === 'price');
  const costData = series.filter(item => item.type === 'cost100');
  const kmData = series.filter(item => item.type === 'km');

  // Render each chart
  renderLineChart('chartCons', consumptionData);
  renderLineChart('chartPrice', priceData);
  renderLineChart('chartCost100', costData);
  renderLineChart('chartKm', kmData);
}

function renderLineChart(chartId, data) {
  const canvas = document.getElementById(chartId);
  if (!canvas) return;

  // Sort chronologically (oldest → newest)
  const chronologicalData = data.slice().sort((a, b) => {
    const dateA = new Date(a.day || a.date);
    const dateB = new Date(b.day || b.date);
    return dateA - dateB;
  });

  const labels = chronologicalData.map(d => d.day || d.date);
  const values = chronologicalData.map(d => d.value || 0);

  // Calculate average if needed
  const averageValue = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  // Create chart
  const chartConfig = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: chartId,
        data: values,
        borderColor: '#1677ff',
        backgroundColor: 'rgba(22, 119, 255, 0.05)',
        borderWidth: 2,
        tension: 0.28,
        spanGaps: true,
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { font: { size: 10 } },
          grid: { display: false }
        },
        y: {
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(0, 0, 0, 0.05)' }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false }
      }
    }
  };

  // Add moving average line if requested
  if (chartStates[chartId] && chartStates[chartId].showMA && values.length >= MOVING_AVG_WINDOW) {
    const movingAverage = calculateMovingAverage(values, MOVING_AVG_WINDOW);
    chartConfig.data.datasets.push({
      label: 'Gleitender Ø',
      data: movingAverage,
      type: 'line',
      borderColor: '#df3046',
      backgroundColor: 'rgba(223, 48, 70, 0.1)',
      borderWidth: 2,
      tension: 0.28,
      spanGaps: true,
      pointRadius: 0,
      borderDash: [5, 5]
    });
  }

  // Add average line if requested
  if (chartStates[chartId] && chartStates[chartId].showMA) {
    chartConfig.data.datasets.push({
      label: 'Durchschnitt',
      type: 'line',
      data: Array(values.length).fill(averageValue),
      borderColor: '#999',
      backgroundColor: 'rgba(153, 153, 153, 0.1)',
      borderWidth: 1,
      tension: 0.28,
      spanGaps: true,
      pointRadius: 0,
      borderDash: [3, 3]
    });
  }

  // Destroy existing chart
  if (Chart.getChart(canvas)) {
    Chart.getChart(canvas).destroy();
  }

  // Create new chart
  new Chart(canvas, chartConfig);
}

function calculateMovingAverage(data, windowSize) {
  const averages = [];
  for (let i = 0; i <= data.length - windowSize; i++) {
    const window = data.slice(i, i + windowSize);
    const sum = window.reduce((a, b) => a + b, 0);
    averages.push(sum / windowSize);
  }

  // Pad with null values for the beginning
  return new Array(data.length).fill(null).map((_, index) => {
    if (index < windowSize - 1) return null;
    return averages[index - windowSize + 1];
  });
}

// Chart control functions
function initChartControls() {
  document.querySelectorAll('.chart-type-select').forEach(select => {
    select.addEventListener('change', function() {
      const chartId = this.dataset.chart;
      chartStates[chartId].type = this.value;
      renderChart(chartId);
    });
  });

  document.querySelectorAll('.average-mode-select').forEach(select => {
    select.addEventListener('change', function() {
      const chartId = this.dataset.chart;
      chartStates[chartId].showMA = this.value !== 'off';
      renderChart(chartId);
    });
  });
}

function renderChart(chartId) {
  // Re-render chart based on current state
  const canvas = document.getElementById(chartId);
  if (!canvas) return;

  const data = getChartData(chartId);

  // Destroy and re-create chart
  if (Chart.getChart(canvas)) {
    Chart.getChart(canvas).destroy();
  }

  renderLineChart(chartId, data);
}

function getChartData(chartId) {
  // Get data from API based on chart ID
  // This would normally fetch from your backend
  const mockData = {
    chartCons: [ { day: '2024-01-01', value: 12 }, { day: '2024-01-02', value: 15 }, { day: '2024-01-03', value: 11 } ],
    chartPrice: [ { day: '2024-01-01', value: 0.45 }, { day: '2024-01-02', value: 0.47 }, { day: '2024-01-03', value: 0.44 } ],
    chartCost100: [ { day: '2024-01-01', value: 45 }, { day: '2024-01-02', value: 52 }, { day: '2024-01-03', value: 48 } ],
    chartKm: [ { day: '2024-01-01', value: 125 }, { day: '2024-01-02', value: 142 }, { day: '2024-01-03', value: 138 } ]
  };

  return mockData[chartId] || [];
}

// Helper formatting functions
function formatKWh(value) {
  return value.toLocaleString('de-DE') + ' kWh';
}

function formatCurrency(value) {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatNumber(value) {
  return value.toLocaleString('de-DE');
}

function formatPercent(value) {
  return value.toFixed(1) + '%';
}

// Initialize page
function initStatsPage() {
  // Initialize chart controls
  initChartControls();

  // Load initial data
  loadStats();

  // Update chart when date range changes
  window.addEventListener('globalRangeChange', function() {
    loadStats();
  });
}

// Expose functions for main JS
window.loadStats = loadStats;
window.initStatsPage = initStatsPage;
