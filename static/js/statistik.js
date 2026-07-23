// statistik.js - Statistik Seite mit 4 Charts + Chart-Type Selector + Moving Average Toggle

let currentDays = 365;
let currentFrom = null;
let currentTo = null;
let currentChartType = 'line'; // line, bar, pie
let showMovingAverage = true; // Moving Average Toggle
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
    renderDataQualityWarnings(stats);
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
    {icon:'🛣️', t:'Gefahrene km', v:(t.total_km||0).toLocaleString('de-DE')+' km', s:'Summe Tagesdistanzen', c:'secondary'},
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
  
  // Store globally for pie chart access
  window.__chartsData = charts;
  
  // Prepare data arrays
  const labels = s.map(d => d.day);
  const consData = s.map(d => d.consumption);
  const priceData = s.map(d => d.price_per_kwh);
  const cost100Data = s.map(d => d.cost_per_100);
  // Don't use cumulative km for moving average - use daily km instead
  const dailyKmData = s.map(d => d.km);
  
  // Calculate moving averages
  const consMA = movingAverage(consData, MOVING_AVG_WINDOW);
  const priceMA = movingAverage(priceData, MOVING_AVG_WINDOW);
  const cost100MA = movingAverage(cost100Data, MOVING_AVG_WINDOW);
  // Daily km MA makes sense, cumulative doesn't
  const dailyKmMA = movingAverage(dailyKmData, MOVING_AVG_WINDOW);
  
  renderChart('chartCons', 'Verbrauch (kWh/100 km)', labels, consData, consMA, kpis.avg_consumption || 0, 'kWh/100km', '#198754');
  renderChart('chartPrice', 'Energiepreis (€/kWh)', labels, priceData, priceMA, kpis.avg_price_kwh || 0, '€/kWh', '#0d6efd');
  renderChart('chartCost100', 'Kosten (€/100 km)', labels, cost100Data, cost100MA, kpis.avg_cost_100 || 0, '€/100km', '#ffc107');
  // For km chart, show daily km with MA, but avg = total_km
  renderChart('chartKm', 'Tageskilometer', labels, dailyKmData, dailyKmMA, kpis.total_km || 0, 'km', '#6f42c1');
  
  // Add chart type selector and MA toggle to each card
  ['chartCons', 'chartPrice', 'chartCost100', 'chartKm'].forEach(id => {
    addChartTypeSelector(id);
    addMAToggle(id);
  });
  
  // Setup event listeners for MA toggle buttons
  setupMAToggleButtons();
  setupChartTypeButtons();
  
  // Render heatmaps
  renderHeatmaps(s, kpis);
}

function movingAverage(data, window) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] == null) {
      result.push(null);
      continue;
    }
    // 0 is a valid value, only null/undefined means "no data"
    if (i < window - 1) {
      result.push(null); // Not enough data for full window
    } else {
      const slice = data.slice(i - window + 1, i + 1).filter(v => v != null);
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
    // For pie: show meaningful distribution based on chart type
    let pieData, pieLabels;
    
    if (canvasId === 'chartCons') {
      // Consumption: AC vs DC split (from ac_kwh, dc_kwh in series)
      const s = window.__chartsData?.series || [];
      const acSum = s.reduce((a, d) => a + (d.ac_kwh || 0), 0);
      const dcSum = s.reduce((a, d) => a + (d.dc_kwh || 0), 0);
      pieLabels = ['AC Laden', 'DC Laden'];
      pieData = [acSum, dcSum];
    } else if (canvasId === 'chartPrice') {
      // Price: Home vs External weighted
      const s = window.__chartsData?.series || [];
      const homeSum = s.reduce((a, d) => a + (d.home_kwh || 0), 0);
      const extSum = s.reduce((a, d) => a + (d.ext_kwh || 0), 0);
      pieLabels = ['Zuhause', 'Extern'];
      pieData = [homeSum, extSum];
    } else if (canvasId === 'chartCost100') {
      // Cost: Home vs External
      const s = window.__chartsData?.series || [];
      const homeCost = s.reduce((a, d) => a + (d.home_cost || 0), 0);
      const extCost = s.reduce((a, d) => a + (d.ext_cost || 0), 0);
      pieLabels = ['Zuhause', 'Extern'];
      pieData = [homeCost, extCost];
    } else if (canvasId === 'chartKm') {
      // KM: don't show pie for cumulative, show line instead
      return renderChart(canvasId, title, labels, data, maData, avgValue, unit, color);
    }
    
    // Filter out zero/empty
    const valid = pieData.map((v, i) => ({v, l: pieLabels[i]})).filter(x => x.v > 0);
    if (valid.length === 0) {
      // No data, show empty state
      ctx.innerHTML = '<div class="text-muted small p-2">Keine Daten für Kreisdiagramm</div>';
      return;
    }
    
    window[canvasId + 'Chart'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: valid.map(x => x.l),
        datasets: [{
          data: valid.map(x => x.v),
          backgroundColor: [color, '#0dcaf0', '#ffc107', '#6f42c1', '#fd7e14', '#20c997'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { position: 'bottom' },
          title: { display: true, text: `${title} (Summe: ${valid.reduce((a,x)=>a+x.v,0).toFixed(1)} ${unit})` }
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
  
  // Add moving average line (only for line charts, and only if enabled)
  if (!isBar && showMovingAverage && maData.some(v => v != null)) {
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
  
  // Add overall average line (horizontal) for both line and bar charts
  if (avgValue != null && avgValue !== 0) {
    const avgLinePlugin = {
      id: 'avgLine',
      beforeDraw: (chart) => {
        const ctx = chart.ctx;
        const yScale = chart.scales.y;
        const y = yScale.getPixelForValue(avgValue);
        
        ctx.save();
        ctx.strokeStyle = '#6c757d';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(chart.chartArea.left, y);
        ctx.lineTo(chart.chartArea.right, y);
        ctx.stroke();
        
        // Label
        ctx.fillStyle = '#6c757d';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Ø ${Number(avgValue).toFixed(2)} ${unit}`, chart.chartArea.left + 5, y - 3);
        ctx.restore();
      }
    };
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
      },
      plugins: avgValue != null && avgValue !== 0 ? [avgLinePlugin] : []
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
}

function addMAToggle(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  
  const card = canvas.closest('.card');
  if (!card || card.querySelector('.ma-toggle')) return;
  
  const header = card.querySelector('.card-header');
  if (!header) return;
  
  // Check if MA toggle button already exists (added in template)
  const existingBtn = header.querySelector('[id^="ma"]');
  if (existingBtn) {
    existingBtn.classList.add('ma-toggle');
    existingBtn.classList.toggle('active', showMovingAverage);
    existingBtn.title = showMovingAverage ? 'Moving Average (7T) aus' : 'Moving Average (7T) ein';
    existingBtn.textContent = showMovingAverage ? '📈' : '📉';
    return;
  }
  
  const toggle = document.createElement('button');
  toggle.className = 'btn btn-outline-secondary btn-sm ma-toggle';
  toggle.style.minWidth = '32px';
  toggle.dataset.chart = canvasId;
  toggle.title = showMovingAverage ? 'Moving Average (7T) aus' : 'Moving Average (7T) ein';
  toggle.textContent = showMovingAverage ? '📈' : '📉';
  toggle.classList.toggle('active', showMovingAverage);
  
  header.appendChild(toggle);
}

function setupMAToggleButtons() {
  document.querySelectorAll('.ma-toggle, [id^="ma"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showMovingAverage = !showMovingAverage;
      
      // Update all MA toggle buttons
      document.querySelectorAll('.ma-toggle, [id^="ma"]').forEach(b => {
        b.classList.toggle('active', showMovingAverage);
        b.title = showMovingAverage ? 'Moving Average (7T) aus' : 'Moving Average (7T) ein';
        b.textContent = showMovingAverage ? '📈' : '📉';
      });
      
      loadStats(); // Re-render all charts
    });
  });
}

function setupChartTypeButtons() {
  document.querySelectorAll('[id^="ct"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const types = ['line', 'bar', 'pie'];
      const currentIndex = types.indexOf(currentChartType);
      const nextIndex = (currentIndex + 1) % types.length;
      currentChartType = types[nextIndex];
      
      // Update all chart type buttons
      document.querySelectorAll('[id^="ct"]').forEach(b => {
        const icons = { line: '📈', bar: '📊', pie: '🥧' };
        b.textContent = icons[currentChartType];
        b.title = `Diagrammtyp: ${currentChartType}`;
      });
      
      // Also update any dropdown selectors
      document.querySelectorAll('.chart-type-selector select').forEach(sel => {
        sel.value = currentChartType;
      });
      
      loadStats(); // Re-render all charts
    });
  });
  
  // Also handle dropdown selectors
  document.querySelectorAll('.chart-type-selector select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      currentChartType = e.target.value;
      // Update all dropdowns
      document.querySelectorAll('.chart-type-selector select').forEach(s => s.value = currentChartType);
      // Update icon buttons
      const icons = { line: '📈', bar: '📊', pie: '🥧' };
      document.querySelectorAll('[id^="ct"]').forEach(b => {
        b.textContent = icons[currentChartType];
        b.title = `Diagrammtyp: ${currentChartType}`;
      });
      loadStats();
    });
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
  
  // Listen to global date range changes
  window.addEventListener('globalRangeChange', (e) => {
    const params = e.detail;
    if (params.startsWith('from=')) {
      const urlParams = new URLSearchParams(params);
      currentFrom = urlParams.get('from');
      currentTo = urlParams.get('to');
      currentDays = 365; // fallback
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
      if (document.getElementById('rangeFrom')) document.getElementById('rangeFrom').value = currentFrom;
      if (document.getElementById('rangeTo')) document.getElementById('rangeTo').value = currentTo;
    } else {
      const urlParams = new URLSearchParams(params);
      currentDays = parseInt(urlParams.get('days'), 10);
      currentFrom = null;
      currentTo = null;
      document.getElementById('rangeFrom').value = '';
      document.getElementById('rangeTo').value = '';
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
  
  loadStats();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';

/* ============================================================
   FAHRTENVERGLEICH (Drive Comparison)
   ============================================================ */

let driveCompareData = [];

async function initDriveCompare() {
  const loadBtn = document.getElementById('driveCompareLoad');
  const runBtn = document.getElementById('driveCompareRun');
  const selectAll = document.getElementById('driveSelectAll');
  const tbody = document.querySelector('#tblDrives tbody');
  const resultDiv = document.getElementById('driveCompareResult');
  const fromEl = document.getElementById('driveCompareFrom');
  const toEl = document.getElementById('driveCompareTo');
  const searchEl = document.getElementById('driveCompareSearch');
  
  if (!loadBtn || !tbody) return; // Not on statistik page

  // Set default date range (last 90 days)
  const today = new Date();
  const ago90 = new Date(today.getTime() - 90 * 86400000);
  fromEl.value = ago90.toISOString().slice(0, 10);
  toEl.value = today.toISOString().slice(0, 10);

  loadBtn.addEventListener('click', async () => {
    const from = fromEl.value || null;
    const to = toEl.value || null;
    const days = from && to ? null : 90;
    
    try {
      const params = new URLSearchParams();
      if (days) params.set('days', days);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      
      loadBtn.disabled = true;
      loadBtn.textContent = 'Lädt...';
      tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4 text-muted">Lädt Fahrten...</td></tr>';
      
      const resp = await fetch(`/api/drives?${params.toString()}`, {credentials: 'same-origin'});
      const data = await resp.json();
      
      driveCompareData = data.drives || [];
      renderDriveTable(driveCompareData);
      
      loadBtn.disabled = false;
      loadBtn.textContent = 'Laden';
    } catch (e) {
      console.error('Drive compare load failed', e);
      tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4 text-danger">Fehler beim Laden</td></tr>';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Laden';
    }
  });

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase();
    renderDriveTable(driveCompareData.filter(d => 
      (d.route || '').toLowerCase().includes(q)
    ));
  });

  selectAll.addEventListener('change', () => {
    tbody.querySelectorAll('input[type="checkbox"][data-drive-id]').forEach(cb => {
      cb.checked = selectAll.checked;
    });
    updateCompareButton();
  });

  tbody.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"][data-drive-id]')) {
      updateCompareButton();
    }
  });

  runBtn.addEventListener('click', async () => {
    const selected = Array.from(tbody.querySelectorAll('input[type="checkbox"][data-drive-id]:checked'))
      .map(cb => parseInt(cb.dataset.driveId, 10));
    
    if (selected.length < 2) {
      alert('Bitte mindestens 2 Fahrten auswählen');
      return;
    }

    runBtn.disabled = true;
    runBtn.textContent = 'Vergleicht...';
    resultDiv.style.display = 'none';
    resultDiv.innerHTML = '';

    try {
      const resp = await fetch(`/api/drives/compare?ids=${selected.join(',')}`, {credentials: 'same-origin'});
      const data = await resp.json();
      renderDriveCompareResult(data);
      resultDiv.style.display = 'block';
    } catch (e) {
      console.error('Compare failed', e);
      resultDiv.innerHTML = '<div class="alert alert-danger">Vergleich fehlgeschlagen</div>';
      resultDiv.style.display = 'block';
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Vergleichen';
    }
  });
}

function renderDriveTable(drives) {
  const tbody = document.querySelector('#tblDrives tbody');
  const selectAll = document.getElementById('driveSelectAll');
  if (!tbody) return;
  
  selectAll.checked = false;
  
  if (!drives.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4 text-muted">Keine Fahrten im Zeitraum</td></tr>';
    return;
  }

  tbody.innerHTML = drives.map(d => `
    <tr>
      <td><input type="checkbox" data-drive-id="${d.id}" class="form-check-input"></td>
      <td>${d.start_date ? d.start_date.slice(0,10) : '–'}</td>
      <td>${d.route || '–'}</td>
      <td class="text-end">${d.km != null ? d.km.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>
      <td class="text-end">${d.duration_min != null ? Math.round(d.duration_min) + ' min' : '–'}</td>
      <td class="text-end">${d.speed_avg != null ? d.speed_avg.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>
      <td class="text-end">${d.energy_kwh != null ? d.energy_kwh.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>
      <td class="text-end">${d.cons_per_100 != null ? d.cons_per_100.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>
      <td class="text-end">${d.soc_used != null ? d.soc_used + ' %' : '–'}</td>
      <td class="text-end">${d.outside_temp_avg != null ? Math.round(d.outside_temp_avg) : '–'}</td>
    </tr>
  `).join('');
}

function updateCompareButton() {
  const runBtn = document.getElementById('driveCompareRun');
  const tbody = document.querySelector('#tblDrives tbody');
  const selected = tbody.querySelectorAll('input[type="checkbox"][data-drive-id]:checked').length;
  runBtn.disabled = selected < 2;
  runBtn.textContent = `Vergleichen (${selected})`;
}

function renderDriveCompareResult(data) {
  const resultDiv = document.getElementById('driveCompareResult');
  if (!resultDiv) return;
  
  const drives = data.drives || [];
  const averages = data.averages || {};
  const best = data.best_consumption_id;
  const worst = data.worst_consumption_id;

  let html = `
    <h6>Vergleichsergebnis</h6>
    <div class="table-responsive">
      <table class="table table-sm table-bordered align-middle mb-3">
        <thead class="table-light">
          <tr>
            <th>Kennzahl</th>
            <th>Ø</th>
            ${drives.map(d => `
              <th class="${d.is_best ? 'bg-success-subtle' : ''} ${d.is_worst ? 'bg-danger-subtle' : ''}">
                ${d.start_date ? d.start_date.slice(0,10) : ''}
                ${d.is_best ? ' 🏆' : ''}
                ${d.is_worst ? ' ⚠️' : ''}
              </th>
            `).join('')}
          </tr>
        </thead>
        <tbody>
          <tr><td>Datum</td><td>–</td>${drives.map(d => `<td>${d.start_date ? d.start_date.slice(0,10) : ''}</td>`).join('')}</tr>
          <tr><td>Route</td><td>–</td>${drives.map(d => `<td>${d.route || '–'}</td>`).join('')}</tr>
          <tr><td>km</td><td>${averages.km != null ? averages.km.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>${drives.map(d => `<td class="${d.id === best ? 'bg-success-subtle' : ''} ${d.id === worst ? 'bg-danger-subtle' : ''}">${d.km != null ? d.km.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>`).join('')}</tr>
          <tr><td>Dauer (min)</td><td>${averages.duration_min != null ? Math.round(averages.duration_min) : '–'}</td>${drives.map(d => `<td>${d.duration_min != null ? Math.round(d.duration_min) : '–'}</td>`).join('')}</tr>
          <tr><td>Ø km/h</td><td>${averages.speed_avg != null ? averages.speed_avg.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>${drives.map(d => `<td>${d.speed_avg != null ? d.speed_avg.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>`).join('')}</tr>
          <tr><td>kWh</td><td>${averages.energy_kwh != null ? averages.energy_kwh.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>${drives.map(d => `<td>${d.energy_kwh != null ? d.energy_kwh.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>`).join('')}</tr>
          <tr><td><strong>kWh/100km</strong></td><td><strong>${averages.cons_per_100 != null ? averages.cons_per_100.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</strong></td>${drives.map(d => `<td class="${d.id === best ? 'bg-success-subtle fw-bold' : ''} ${d.id === worst ? 'bg-danger-subtle fw-bold' : ''}">${d.cons_per_100 != null ? d.cons_per_100.toLocaleString('de-DE', {minimumFractionDigits:1}) : '–'}</td>`).join('')}</tr>
          <tr><td>SoC Δ</td><td>${averages.soc_used != null ? averages.soc_used + ' %' : '–'}</td>${drives.map(d => `<td>${d.soc_used != null ? d.soc_used + ' %' : '–'}</td>`).join('')}</tr>
          <tr><td>Temp °C</td><td>${averages.outside_temp_avg != null ? Math.round(averages.outside_temp_avg) : '–'}</td>${drives.map(d => `<td>${d.outside_temp_avg != null ? Math.round(d.outside_temp_avg) : '–'}</td>`).join('')}</tr>
        </tbody>
      </table>
    `;

  // Add bar chart for consumption comparison
  if (drives.length > 0) {
    html += `
      <div class="card mb-3">
        <div class="card-header py-2">Verbrauch pro Fahrt (kWh/100km)</div>
        <div class="card-body">
          <canvas id="driveConsChart" height="120"></canvas>
        </div>
      </div>
    `;

    resultDiv.innerHTML = html;

    // Render bar chart
    const ctx = document.getElementById('driveConsChart');
    if (ctx && window.Chart) {
      const labels = drives.map(d => d.start_date ? d.start_date.slice(5,10) : '');
      const consData = drives.map(d => d.cons_per_100);
      const colors = drives.map(d => d.is_best ? '#198754' : (d.is_worst ? '#dc3545' : '#0d6efd'));
      
      if (window.driveConsChart) window.driveConsChart.destroy();
      window.driveConsChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'kWh/100km', data: consData, backgroundColor: colors }] },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'kWh/100km' } } }
        }
      });
    }
  } else {
    resultDiv.innerHTML = '<div class="alert alert-warning">Keine Vergleichsdaten</div>';
  }
}

// Initialize drive compare when on statistik page
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('driveCompareSection')) {
    initDriveCompare();
  }
});

/* ============================================================
   DATA QUALITY & EXPORT FEATURES
   ============================================================ */

// Show data quality warnings
function renderDataQualityWarnings(stats) {
  const warnings = [];
  const t = stats.totals || {};
  const h = stats.home || {};
  const e = stats.external || {};
  
  // Sessions without price
  const homeNoPrice = (h.count || 0) > 0 && (h.grid_cost || 0) === 0 && (h.pv_cost || 0) === 0;
  const extNoPrice = (e.count || 0) > 0 && (e.cost || 0) === 0;
  if (homeNoPrice || extNoPrice) {
    warnings.push({type: 'warning', text: 'Einige Ladevorgänge haben keine Preisdaten – Kosten werden geschätzt.'});
  }
  
  // Unmatched home charges
  if (h.count && t.ext_kwh > 0 && t.home_kwh === 0) {
    warnings.push({type: 'info', text: 'Keine Home-Ladungen (EVCC) im Zeitraum – Extern-Daten evtl. unvollständig.'});
  }
  
  // Missing km data
  if (t.distance_km === 0 && (t.kwh || 0) > 0) {
    warnings.push({type: 'warning', text: 'Keine Kilometerdaten – Verbrauch/Kosten pro 100km können nicht berechnet werden.'});
  }
  
  // Implausible consumption
  if (t.consumption_kwh_per_100km && (t.consumption_kwh_per_100km > 50 || t.consumption_kwh_per_100km < 5)) {
    warnings.push({type: 'warning', text: `Verbrauch ${t.consumption_kwh_per_100km.toFixed(1)} kWh/100km wirkt unplausibel – Odometer-Daten prüfen.`});
  }
  
  if (!warnings.length) return;
  
  const container = document.getElementById('dataQualityWarnings') || createWarningsContainer();
  container.innerHTML = warnings.map(w => `
    <div class="alert alert-${w.type === 'error' ? 'danger' : w.type} alert-dismissible fade show py-2 mb-2" role="alert">
      ${w.text}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    </div>
  `).join('');
  container.style.display = 'block';
}

function createWarningsContainer() {
  const container = document.createElement('div');
  container.id = 'dataQualityWarnings';
  container.style.display = 'none';
  // Insert after statsKpis
  const statsKpis = document.getElementById('statsKpis');
  if (statsKpis && statsKpis.parentNode) {
    statsKpis.parentNode.insertBefore(container, statsKpis.nextSibling);
  }
  return container;
}

// CSV Export
function exportSessionsCSV(type) {
  // type: 'home', 'external', 'all', 'drives'
  let url = `/api/export/csv?type=${type}`;
  if (currentFrom && currentTo) {
    url += `&from=${encodeURIComponent(currentFrom)}&to=${encodeURIComponent(currentTo)}`;
  } else {
    url += `&days=${currentDays}`;
  }
  window.location.href = url;
}

function addExportButtons() {
  const header = document.querySelector('.page-header, .card-header:has(#rangeLabel)');
  if (!header || document.getElementById('exportBtnGroup')) return;
  
  const btnGroup = document.createElement('div');
  btnGroup.id = 'exportBtnGroup';
  btnGroup.className = 'btn-group btn-group-sm ms-2';
  btnGroup.innerHTML = `
    <button class="btn btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
      Export CSV
    </button>
    <ul class="dropdown-menu dropdown-menu-end">
      <li><a class="dropdown-item" href="#" data-export="home">Zuhause (EVCC)</a></li>
      <li><a class="dropdown-item" href="#" data-export="external">Extern (TeslaMate)</a></li>
      <li><a class="dropdown-item" href="#" data-export="all">Alle Ladevorgänge</a></li>
      <li><hr class="dropdown-divider"></li>
      <li><a class="dropdown-item" href="#" data-export="drives">Fahrten</a></li>
    </ul>
  `;
  header.appendChild(btnGroup);
  
  btnGroup.querySelectorAll('[data-export]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      exportSessionsCSV(e.target.dataset.export);
    });
  });
}

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  // Add export buttons to pages that have stats
  if (document.getElementById('statsKpis') || document.getElementById('summaryCards')) {
    addExportButtons();
  }
});

// Update renderKPIs to also show data quality warnings
const originalRenderKPIs = renderKPIs;
renderKPIs = function(stats) {
  originalRenderKPIs(stats);
  renderDataQualityWarnings(stats);
}();

/* ============================================================
   HEATMAPS for Statistik
   ============================================================ */

function renderHeatmaps(series, kpis) {
  const container = document.getElementById('statsSecondary');
  if (!container) return;
  
  if (!series || series.length === 0) {
    container.innerHTML = '';
    return;
  }
  
  // 1. Charging Heatmap: Day of week vs Hour (from home_sessions if available)
  // 2. Consumption Heatmap: Day of week vs Month
  // 3. Cost Heatmap: Day of week vs Month
  
  // We'll create a simplified heatmap using the series data (daily data)
  // Group by month and day of week
  
  const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const daysOfWeek = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  
  // Prepare data matrices
  const consumptionMatrix = Array(7).fill().map(() => Array(12).fill(null));
  const costMatrix = Array(7).fill().map(() => Array(12).fill(null));
  const kmMatrix = Array(7).fill().map(() => Array(12).fill(null));
  const countMatrix = Array(7).fill().map(() => Array(12).fill(0));
  
  series.forEach(d => {
    const date = new Date(d.day + 'T00:00:00');
    const month = date.getMonth(); // 0-11
    const dayOfWeek = (date.getDay() + 6) % 7; // 0=Mo, 6=So
    
    if (d.consumption != null) {
      consumptionMatrix[dayOfWeek][month] = (consumptionMatrix[dayOfWeek][month] || 0) + d.consumption;
      countMatrix[dayOfWeek][month]++;
    }
    if (d.cost != null) {
      costMatrix[dayOfWeek][month] = (costMatrix[dayOfWeek][month] || 0) + d.cost;
    }
    if (d.km != null) {
      kmMatrix[dayOfWeek][month] = (kmMatrix[dayOfWeek][month] || 0) + d.km;
    }
  });
  
  // Average consumption matrix
  for (let dow = 0; dow < 7; dow++) {
    for (let m = 0; m < 12; m++) {
      if (countMatrix[dow][m] > 0) {
        consumptionMatrix[dow][m] = consumptionMatrix[dow][m] / countMatrix[dow][m];
      } else {
        consumptionMatrix[dow][m] = null;
      }
    }
  }
  
  // Build heatmap HTML
  function buildHeatmap(matrix, title, unit, colorScale) {
    const cells = [];
    for (let dow = 0; dow < 7; dow++) {
      for (let m = 0; m < 12; m++) {
        const val = matrix[dow][m];
        let style = 'background: #e9ecef;';
        let text = '–';
        
        if (val != null) {
          // Normalize to 0-1 for color
          const allVals = matrix.flat().filter(v => v != null);
          if (allVals.length > 0) {
            const min = Math.min(...allVals);
            const max = Math.max(...allVals);
            const norm = max > min ? (val - min) / (max - min) : 0.5;
            const r = Math.round(255 * (1 - norm));
            const g = Math.round(255 * norm);
            style = `background: rgb(${r}, ${g}, 100);`;
          }
          text = val.toFixed(1) + ' ' + unit;
        }
        
        cells.push(`<div class="heatmap-cell" style="${style}" title="${daysOfWeek[dow]} ${months[m]}: ${text}">${text}</div>`);
      }
    }
    
    return `
      <div class="col-12 col-lg-6 col-xl-4 mb-3">
        <div class="card h-100">
          <div class="card-header py-2">${title}</div>
          <div class="card-body p-2">
            <div class="heatmap-grid" style="display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; font-size: 0.65rem;">
              <div class="heatmap-header" style="grid-column: span 12; display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; margin-bottom: 2px; font-weight: 600; font-size: 0.6rem; text-align: center;">
                ${months.map(m => `<div>${m}</div>`).join('')}
              </div>
              ${daysOfWeek.map((dow, i) => `
                <div class="heatmap-row-label" style="grid-column: 1; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 0.6rem; padding-right: 4px;">${dow}</div>
                ${cells.slice(i * 12, (i + 1) * 12).join('')}
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }
  
  container.innerHTML = `
    <div class="row g-2">
      ${buildHeatmap(consumptionMatrix, '⚡ Verbrauch (kWh/100km) nach Wochentag & Monat', 'kWh', ['#28a745', '#ffc107', '#dc3545'])}
      ${buildHeatmap(costMatrix, '💶 Kosten (€) nach Wochentag & Monat', '€', ['#28a745', '#ffc107', '#dc3545'])}
      ${buildHeatmap(kmMatrix, '🛣️ Kilometer nach Wochentag & Monat', 'km', ['#6f42c1', '#0dcaf0', '#fd7e14'])}
    </div>
  `;
}