// statistik.js - Statistik Seite mit 4 Charts + Chart-Type Selector + Moving Average

let currentDays = 365;
let currentFrom = null;
let currentTo = null;
let currentChartType = 'line'; // line, bar, pie
const MOVING_AVG_WINDOW = 7;

function buildApiParams() {
  if (currentFrom && currentTo) {
    return `from=${currentFrom}&to=${currentTo}`;
  }
  return `days=${currentDays}`;
}

async function loadStats() {
  try {
    const params = buildApiParams();
    const [stats, charts] = await Promise.all([
      fetch(`/api/stats?${params}`, {credentials: "same-origin"}).then(r => r.json()),
      fetch(`/api/charts?${params}`, {credentials: "same-origin"}).then(r => r.json())
    ]);
    
    renderKPIs(stats);
    renderCharts(charts);
    updateRangeLabel();
  } catch (e) {
    console.error('loadStats failed', e);
  }
}

function renderKPIs(s) {
  const t = s.totals || {}, h = s.home || {}, e = s.external || {};
  const monthly = s.monthly || [];
  const curMonth = monthly.length ? monthly[monthly.length - 1] : null;
  const costThisMonth = curMonth ? (curMonth.home_cost + curMonth.ext_cost + curMonth.extra) : 0;
  const homeKwh = t.home_kwh || 0;
  const extKwh = t.ext_kwh || 0;
  const homeShare = (homeKwh + extKwh) > 0 ? Math.round(homeKwh / (homeKwh + extKwh) * 100) : 0;
  
  const cards = [
    {icon:'💶', t:'Kosten diesen Monat', v:fmtEUR(costThisMonth), s:curMonth ? curMonth.month : '–', c:'success'},
    {icon:'⚡', t:'Geladene Energie', v:fmtKwh(t.kwh), s:`Zuhause ${fmtKwh(homeKwh)} · Extern ${fmtKwh(extKwh)}`, c:'primary'},
    {icon:'🛣️', t:'Gefahrene km', v:(t.distance_km||0).toLocaleString('de-DE')+' km', s:'Tacho-Stand (max)', c:'secondary'},
    {icon:'💡', t:'Kosten / 100 km', v:fmtEUR(t.tco_per_100km)+' /100km', s:`TCO ${fmtEUR(t.tco)}`, c:'warning'},
    {icon:'🔋', t:'Verbrauch', v:fmtKwh(t.consumption_kwh_per_100km)+' /100km', s:`Akku ≈ ${fmtKwh(t.consumption_net_kwh_per_100km)} (geschätzt)`, c:'info'},
    {icon:'☀️', t:'PV-Anteil', v:fmtPct(h.pv_share_pct), s:`${fmtKwh(h.pv_kwh||0)} PV von ${fmtKwh(homeKwh)}`, c:'success'},
    {icon:'🏠', t:'Zuhause vs. Extern', v:`${homeShare} % Zuhause`, s:`${fmtKwh(homeKwh)} zu Hause · ${fmtKwh(extKwh)} extern`, c:'primary'},
    {icon:'🔌', t:'Ladeverluste', v:fmtKwh(t.home_loss_kwh), s:'Wallbox → Akku (Differenz)', c:'dark'},
  ];
  
  document.getElementById('statsKpis').innerHTML = cards.map(c => `
    <div class="col-6 col-md-4 col-lg-3">
      <div class="card kpi-card text-white bg-${c.c} h-100">
        <div class="card-body py-2">
          <div class="kpi-label opacity-75"><span class="kpi-icon">${c.icon}</span> ${c.t}</div>
          <div class="kpi-value">${c.v}</div>
          <div class="kpi-sub">${c.s}</div>
        </div>
      </div>
    </div>`).join('');
}

function renderCharts(charts) {
  const s = charts.series || [];
  const kpis = charts.kpis || {};
  
  // Prepare data arrays
  const labels = s.map(d => d.day);
  const consData = s.map(d => d.consumption);
  const priceData = s.map(d => d.price_per_kwh);
  const cost100Data = s.map(d => d.cost_per_100);
  const kmData = s.map(d => d.cum_km);
  
  // Calculate moving averages
  const consMA = movingAverage(consData, MOVING_AVG_WINDOW);
  const priceMA = movingAverage(priceData, MOVING_AVG_WINDOW);
  const cost100MA = movingAverage(cost100Data, MOVING_AVG_WINDOW);
  const kmMA = movingAverage(kmData, MOVING_AVG_WINDOW);
  
  renderChart('chartCons', 'Verbrauch (kWh/100 km)', labels, consData, consMA, kpis.avg_consumption || 0, 'kWh/100km', '#198754');
  renderChart('chartPrice', 'Energiepreis (€/kWh)', labels, priceData, priceMA, kpis.avg_price_kwh || 0, '€/kWh', '#0d6efd');
  renderChart('chartCost100', 'Kosten (€/100 km)', labels, cost100Data, cost100MA, kpis.avg_cost_100 || 0, '€/100km', '#ffc107');
  renderChart('chartKm', 'Gesamtkilometer (kumuliert)', labels, kmData, kmMA, kpis.total_km || 0, 'km', '#6f42c1');
  
  // Add chart type selector to each card
  ['chartCons', 'chartPrice', 'chartCost100', 'chartKm'].forEach(id => {
    addChartTypeSelector(id);
  });
}

function movingAverage(data, window) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] == null || data[i] === 0) {
      result.push(null);
      continue;
    }
    if (i < window - 1) {
      result.push(null); // Not enough data for full window
    } else {
      const slice = data.slice(i - window + 1, i + 1).filter(v => v != null && v !== 0);
      result.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null);
    }
  }
  return result;
}

function renderChart(canvasId, title, labels, data, maData, avgValue, unit, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  
  if (window[canvasId + 'Chart']) {
    window[canvasId + 'Chart'].destroy();
  }
  
  const isPie = currentChartType === 'pie';
  const isBar = currentChartType === 'bar';
  const chartType = isPie ? 'doughnut' : (isBar ? 'bar' : 'line');
  
  if (isPie) {
    // For pie: show distribution of last 30 days
    const recentData = data.slice(-30).filter(v => v != null && v > 0);
    const sum = recentData.reduce((a, b) => a + b, 0);
    const avg = sum / recentData.length || 0;
    window[canvasId + 'Chart'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Durchschnitt', 'Rest'],
        datasets: [{
          data: [avg, sum - avg],
          backgroundColor: [color, '#e9ecef'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { position: 'bottom' },
          title: { display: true, text: `${title} (Ø ${avg.toFixed(2)} ${unit})` }
        }
      }
    });
    return;
  }
  
  // Line or Bar chart
  const datasets = [
    {
      label: 'Tageswert',
      data: data,
      borderColor: color,
      backgroundColor: isBar ? color + '80' : 'transparent',
      fill: false,
      tension: 0.2,
      pointRadius: 3,
      pointHoverRadius: 5,
      yAxisID: 'y',
      order: 2
    }
  ];
  
  // Add moving average line (only for line charts)
  if (!isBar && maData.some(v => v != null)) {
    datasets.push({
      label: `Ø ${MOVING_AVG_WINDOW}T`,
      data: maData,
      borderColor: '#dc3545',
      borderDash: [5, 5],
      borderWidth: 2,
      fill: false,
      pointRadius: 0,
      pointHoverRadius: 4,
      yAxisID: 'y',
      order: 1
    });
  }
  
  window[canvasId + 'Chart'] = new Chart(ctx, {
    type: chartType,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { size: 10 } } },
        title: { display: true, text: `${title} (Ø ${avgValue ? Number(avgValue).toFixed(2) : '–'} ${unit})`, font: { size: 12 } },
        tooltip: { 
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? Number(ctx.parsed.y).toFixed(2) + ' ' + unit : '–'}`
          }
        }
      },
      scales: {
        x: { 
          ticks: { maxTicksLimit: 10, font: { size: 9 } },
          grid: { display: false }
        },
        y: { 
          title: { display: true, text: unit, font: { size: 10 } },
          ticks: { font: { size: 9 } },
          beginAtZero: true
        }
      }
    }
  });
}

function addChartTypeSelector(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const card = canvas.closest('.card');
  if (!card || card.querySelector('.chart-type-selector')) return;
  
  const header = card.querySelector('.card-header');
  if (!header) return;
  
  const selector = document.createElement('div');
  selector.className = 'chart-type-selector ms-2';
  selector.innerHTML = `
    <select class="form-select form-select-sm d-inline-block" style="width:auto" data-chart="${canvasId}" aria-label="Diagrammtyp">
      <option value="line" ${currentChartType === 'line' ? 'selected' : ''}>📈 Linie</option>
      <option value="bar" ${currentChartType === 'bar' ? 'selected' : ''}>📊 Balken</option>
      <option value="pie" ${currentChartType === 'pie' ? 'selected' : ''}>🥧 Kreis</option>
    </select>
  `;
  
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.appendChild(selector);
  
  selector.querySelector('select').addEventListener('change', (e) => {
    currentChartType = e.target.value;
    loadStats(); // Re-render all charts
  });
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
      document.getElementById('rangeFrom').value = '';
      document.getElementById('rangeTo').value = '';
      loadStats();
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
        loadStats();
      }
    });
  }
  
  loadStats();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';