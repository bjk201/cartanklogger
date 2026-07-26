// statistik.js - Statistik Seite mit 4 Charts + Chart-Type Selector + Moving Average Toggle

// Per-chart state (not global) — each chart has independent type & MA toggle
const chartInstances = {};
const chartStates = {
  chartCons:    { type: 'line', showMA: true },
  chartPrice:   { type: 'line', showMA: true },
  chartCost100: { type: 'line', showMA: true },
  chartKm:      { type: 'line', showMA: true }
};

let currentDays = 365;
let currentFrom = null;
let currentTo = null;
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
    
    // Fetch all data with individual error handling so one failure doesn't break everything
    const [statsRes, chartsRes, batteryHealthRes, chargingCurveRes, vampireDrainRes, rangeProjectionRes, nerdKpisRes] = await Promise.all([
      fetch(`/api/stats?${params}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({totals: {}, home: {}, external: {}, monthly: []})),
      fetch(`/api/charts?${params}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({series: [], kpis: {}})),
      fetch(`/api/vehicle/battery-health?${params}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({available: false})),
      fetch(`/api/vehicle/charging-curve?limit=20`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({available: false})),
      fetch(`/api/vehicle/vampire-drain?days=30`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({available: false})),
      fetch(`/api/vehicle/range-projection?days=30`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({available: false})),
      fetch(`/api/nerd/kpis?${params}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({}))
    ]);
    
    renderKPIs(statsRes, nerdKpisRes);
    renderCharts(chartsRes);
    renderVehicleCharts(batteryHealthRes, chargingCurveRes, vampireDrainRes, rangeProjectionRes, nerdKpisRes);
    renderDataQualityWarnings(statsRes);
    updateRangeLabel();
  } catch (e) {
    console.error('loadStats failed', e);
  }
}

function renderKPIs(s, nerdKpis) {
  s = s || {};
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

  // Add Nerd Stats cards
  if (nerdKpis && typeof nerdKpis === 'object') {
    if (nerdKpis.battery_degradation) {
      const bd = nerdKpis.battery_degradation;
      cards.push({
        icon:'🧪', t:'Batterie-Degradation', 
        v:`${bd.degradation_pct != null ? bd.degradation_pct.toFixed(2) + ' %' : '–'}`, 
        s:`${bd.first_range_km||0} → ${bd.last_range_km||0} km (100%) | ${bd.data_points||0} Punkte`, 
        c:'danger'
      });
    }
    if (nerdKpis.charging_efficiency) {
      const ce = nerdKpis.charging_efficiency;
      cards.push({
        icon:'⚡', t:'Ladeeffizienz', 
        v:`AC ${ce.ac_avg_pct||0}% · DC ${ce.dc_avg_pct||0}%`, 
        s:`${ce.ac_sessions||0} AC · ${ce.dc_sessions||0} DC Sessions`, 
        c:'primary'
      });
    }
    if (nerdKpis.temperature_efficiency) {
      const te = nerdKpis.temperature_efficiency;
      cards.push({
        icon:'🌡️', t:'Temp.-Effizienz', 
        v:`${te.diff_pct != null ? (te.diff_pct > 0 ? '+' : '') + te.diff_pct.toFixed(1) : '–'} %`, 
        s:`Winter ${te.winter_wh_km||0} Wh/km · Sommer ${te.summer_wh_km||0} Wh/km`, 
        c:'info'
      });
    }
  }

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

// ── Render all 4 stat charts ──────────────────────────────────
function renderCharts(charts) {
  const s = charts.series || [];
  const kpis = charts.kpis || {};
  window.__chartsData = charts;

  const labels = s.map(d => d.day);
  const consData   = s.map(d => d.consumption);
  const priceData  = s.map(d => d.price_per_kwh);
  const cost100Data= s.map(d => d.cost_per_100);
  const dailyKmData= s.map(d => d.cum_km);

  // Period average over the selected date range (not fixed 7T MA)
  const rangeAvg = arr => {
    const valid = arr.filter(v => v != null);
    return valid.length ? valid.reduce((a,b) => a+b, 0) / valid.length : null;
  };
  const avgCons    = rangeAvg(consData);
  const avgPrice   = rangeAvg(priceData);
  const avgCost100 = rangeAvg(cost100Data);
  const avgKm      = rangeAvg(dailyKmData);

  renderChart('chartCons',    'Verbrauch (kWh/100 km)', labels, consData,   avgCons,   'kWh/100km', '#198754', 'consumption');
  renderChart('chartPrice',   'Energiepreis (€/kWh)',   labels, priceData,   avgPrice,  '€/kWh',     '#0d6efd', 'price');
  renderChart('chartCost100', 'Kosten (€/100 km)',      labels, cost100Data, avgCost100,'€/100km',   '#ffc107', 'cost');
  renderChart('chartKm',      'Kilometer (kumuliert)',    labels, dailyKmData, avgKm,     'km',        '#6f42c1', 'km');

  // Per-chart MA toggles only (no chart type selector)
  ['chartCons','chartPrice','chartCost100','chartKm'].forEach(id => {
    addMAToggle(id);
    updateChartTypeUI(id);
  });

  setupMATogglers();

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

// ── Core chart renderer (per-chart-type, safe destroy) ──────────
function renderChart(canvasId, title, labels, data, avgValue, unit, color, dataType) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;

  // Destroy only THIS canvas's previous chart instance
  if (chartInstances[canvasId]) {
    try { chartInstances[canvasId].destroy(); } catch(e) {}
    chartInstances[canvasId] = null;
  }

  const state = chartStates[canvasId] || { type: 'line', showMA: true };
  const chartType = state.type;

  // ── Build datasets ──
  const datasets = [
    {
      label: 'Tageswert',
      data: data,
      borderColor: color,
      backgroundColor: chartType === 'bar' ? color + '80' : 'transparent',
      fill: false,
      tension: 0.2,
      pointRadius: 3,
      pointHoverRadius: 5,
      yAxisID: 'y',
      order: 2
    }
  ];

  // Period average line
  if (state.showMA && avgValue != null) {
    datasets.push({
      label: 'Ø Zeitraum',
      data: data.map(v => v == null ? null : avgValue),
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

  // ── Pie / Doughnut ──
  if (chartType === 'pie') {
    let pieData, pieLabels;
    if (dataType === 'consumption') {
      const ser = window.__chartsData?.series || [];
      pieLabels = ['AC Laden', 'DC Laden'];
      pieData = [ser.reduce((a,d) => a+(d.ac_kwh||0), 0), ser.reduce((a,d) => a+(d.dc_kwh||0), 0)];
    } else if (dataType === 'price') {
      const ser = window.__chartsData?.series || [];
      pieLabels = ['Zuhause', 'Extern'];
      pieData = [ser.reduce((a,d) => a+(d.home_kwh||0), 0), ser.reduce((a,d) => a+(d.ext_kwh||0), 0)];
    } else if (dataType === 'cost') {
      const ser = window.__chartsData?.series || [];
      pieLabels = ['Zuhause', 'Extern'];
      pieData = [ser.reduce((a,d) => a+(d.home_cost||0), 0), ser.reduce((a,d) => a+(d.ext_cost||0), 0)];
    } else {
      doLineBar(ctx, canvasId, title, labels, datasets, avgValue, unit, color);
      return;
    }
    const valid = pieData.map((v,i) => ({v, l: pieLabels[i]})).filter(x => x.v > 0);
    if (valid.length === 0) { ctx.innerHTML = '<div class="text-muted small p-2">Keine Daten</div>'; return; }
    chartInstances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: valid.map(x=>x.l), datasets:[{ data: valid.map(x=>x.v), backgroundColor:[color,'#0dcaf0','#ffc107','#6f42c1','#fd7e14','#20c997'], borderWidth:0 }]},
      options: { responsive:true, maintainAspectRatio:true, plugins:{ legend:{position:'bottom'}, title:{display:true, text:`${title} (Summe: ${valid.reduce((a,x)=>a+x.v,0).toFixed(1)} ${unit})`} } }
    });
    return;
  }

  // ── Line / Bar ──
  doLineBar(ctx, canvasId, title, labels, datasets, avgValue, unit, color);
}

function doLineBar(ctx, canvasId, title, labels, datasets, avgValue, unit, color) {
  const state = chartStates[canvasId] || { type: 'line', showMA: true };
  chartInstances[canvasId] = new Chart(ctx, {
    type: state.type,
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: true,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { position:'top', labels:{font:{size:10}} },
        title: { display:true, text:`${title} (Ø ${avgValue!=null?Number(avgValue).toFixed(2):'–'} ${unit})`, font:{size:12} },
        tooltip: { callbacks:{ label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y!=null?Number(ctx.parsed.y).toFixed(2)+' '+unit:'–'}` } }
      },
      scales: {
        x: { ticks:{maxTicksLimit:10,font:{size:9}}, grid:{display:false} },
        y: { title:{display:true,text:unit,font:{size:10}}, ticks:{font:{size:9}}, beginAtZero:true }
      }
    }
  });
}

// ── Per-chart type selector dropdown ───────────────────────────────
function addChartTypeSelector(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const card = canvas.closest('.card');
  if (!card || card.querySelector('.chart-type-selector')) return;
  const header = card.querySelector('.card-header');
  if (!header) return;

  const state = chartStates[canvasId] || { type: 'line', showMA: true };
  const sel = document.createElement('select');
  sel.className = 'form-select form-select-sm d-inline-block';
  sel.style.width = 'auto';
  sel.dataset.chart = canvasId;
  sel.setAttribute('aria-label', 'Diagrammtyp');
  sel.innerHTML = `
    <option value="line" ${state.type==='line'?'selected':''}>📈 Linie</option>
    <option value="bar"  ${state.type==='bar'?'selected':''}>📊 Balken</option>
    <option value="pie"  ${state.type==='pie'?'selected':''}>🥧 Kreis</option>
  `;
  sel.addEventListener('change', (e) => {
    chartStates[canvasId].type = e.target.value;
    updateChartTypeUI(canvasId);
    loadStats();
  });

  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.appendChild(sel);
}

function updateChartTypeUI(canvasId) {
  const state = chartStates[canvasId];
  if (!state) return;
  document.querySelectorAll(`.chart-type-selector select[data-chart="${canvasId}"]`).forEach(sel => {
    sel.value = state.type;
  });
}

function setupChartTypeDropdowns() {
  document.querySelectorAll('.chart-type-selector select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const cid = e.target.dataset.chart;
      if (cid && chartStates[cid]) {
        chartStates[cid].type = e.target.value;
        updateChartTypeUI(cid);
        loadStats();
      }
    });
  });
}

// ── MA toggle per chart (independent) ─────────────────────────────
function addMAToggle(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const card = canvas.closest('.card');
  if (!card || card.querySelector('.ma-toggle')) return;
  const header = card.querySelector('.card-header');
  if (!header) return;

  const state = chartStates[canvasId] || { type: 'line', showMA: true };
  const btn = document.createElement('button');
  btn.className = 'btn btn-outline-secondary btn-sm ma-toggle';
  btn.style.minWidth = '32px';
  btn.dataset.chart = canvasId;
  btn.title = state.showMA ? 'Mittelwert aus' : 'Mittelwert ein';
  btn.textContent = state.showMA ? '📈' : '📉';
  btn.classList.toggle('active', state.showMA);
  header.appendChild(btn);
}

function setupMATogglers() {
  document.querySelectorAll('.ma-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cid = btn.dataset.chart;
      if (!cid || !chartStates[cid]) return;
      chartStates[cid].showMA = !chartStates[cid].showMA;
      btn.classList.toggle('active', chartStates[cid].showMA);
      btn.title = chartStates[cid].showMA ? 'Mittelwert aus' : 'Mittelwert ein';
      btn.textContent = chartStates[cid].showMA ? '📈' : '📉';
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
  
  // Initialize drive comparison if on statistik page
  if (document.getElementById('driveCompareSection')) {
    initDriveCompare();
  }
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';

/* ============================================================
   VEHICLE CHARTS (TeslaMate Quick Wins)
   ============================================================ */

/**
 * Battery Health Chart
 */
function renderBatteryHealthChart(data) {
  const canvas = document.getElementById('chartBatteryHealth');
  if (!canvas || !window.Chart) return;
  
  if (!data || !data.available || !data.series || data.series.length === 0) {
    canvas.innerHTML = '<div class="text-muted small p-2">Keine Battery Health Daten</div>';
    return;
  }
  
  const labels = data.series.map(d => d.day);
  const health = data.series.map(d => d.health_pct);
  const capacity = data.series.map(d => d.capacity_kwh);
  
  if (window.chartBatteryHealthChart) window.chartBatteryHealthChart.destroy();
  
  window.chartBatteryHealthChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Health (%)',
          data: health,
          borderColor: '#198754',
          backgroundColor: '#19875420',
          fill: true,
          tension: 0.2,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Capacity (kWh)',
          data: capacity,
          borderColor: '#6f42c1',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.2,
          pointRadius: 2,
          borderDash: [4, 4],
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { size: 10 } } },
        title: { display: true, text: `Battery Health (Current: ${data.current_health_pct || '–'}%, ${data.current_capacity_kwh || '–'} kWh)`, font: { size: 12 } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 9 } }, grid: { display: false } },
        y: { position: 'left', title: { display: true, text: 'Health (%)' }, ticks: { font: { size: 9 } }, suggestedMin: 90, suggestedMax: 100 },
        y1: { position: 'right', title: { display: true, text: 'Capacity (kWh)' }, ticks: { font: { size: 9 } }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

/**
 * Charging Curve Chart
 */
function renderChargingCurveChart(data) {
  const container = document.getElementById('chargingCurveContainer');
  if (!container) return;
  
  if (!data || !data.available || !data.curves || data.curves.length === 0) {
    container.innerHTML = '<div class="text-muted small p-2">Keine Ladekurven-Daten</div>';
    return;
  }
  
  // Render each curve as a small chart
  const curvesHtml = data.curves.map((curve, i) => `
    <div class="col-12 col-md-6 mb-2">
      <div class="card h-100">
        <div class="card-header py-1 small">
          ${curve.location} (${curve.is_dc ? 'DC' : 'AC'}) · ${curve.date}
          <span class="float-end">${curve.max_power_kw} kW max · ${curve.avg_power_kw} kW Ø</span>
        </div>
        <div class="card-body p-1">
          <canvas id="chargingCurve${i}" height="120"></canvas>
        </div>
      </div>
    </div>
  `).join('');
  
  container.innerHTML = `<div class="row g-2">${curvesHtml}</div>`;
  
  // Render each chart
  data.curves.forEach((curve, i) => {
    const canvas = document.getElementById(`chargingCurve${i}`);
    if (!canvas || !window.Chart) return;
    
    const points = curve.points || [];
    const labels = points.map(p => p.soc + '%');
    const powerData = points.map(p => p.power_kw);
    
    if (window[`chargingCurveChart${i}`]) window[`chargingCurveChart${i}`].destroy();
    
    window[`chargingCurveChart${i}`] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Power (kW)',
          data: powerData,
          borderColor: curve.is_dc ? '#dc3545' : '#0d6efd',
          backgroundColor: (curve.is_dc ? '#dc3545' : '#0d6efd') + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          title: { display: false }
        },
        scales: {
          x: { title: { display: true, text: 'SoC (%)' }, ticks: { maxTicksLimit: 10, font: { size: 9 } } },
          y: { title: { display: true, text: 'Power (kW)' }, ticks: { font: { size: 9 } }, beginAtZero: true }
        }
      }
    });
  });
}

/**
 * Vampire Drain Chart
 */
function renderVampireDrainChart(data) {
  const canvas = document.getElementById('chartVampireDrain');
  if (!canvas || !window.Chart) return;
  
  if (!data || !data.available || !data.data || data.data.length === 0) {
    canvas.innerHTML = '<div class="text-muted small p-2">Keine Vampire Drain Daten</div>';
    return;
  }
  
  const labels = data.data.map(d => d.day);
  const drainPct = data.data.map(d => d.drain_pct_per_day);
  const drainKm = data.data.map(d => d.drain_km);
  
  if (window.chartVampireDrainChart) window.chartVampireDrainChart.destroy();
  
  window.chartVampireDrainChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Drain (%/Tag)',
          data: drainPct,
          backgroundColor: '#dc354580',
          borderColor: '#dc3545',
          borderWidth: 1,
          yAxisID: 'y',
        },
        {
          label: 'Drain (km/Tag)',
          data: drainKm,
          backgroundColor: '#fd7e1480',
          borderColor: '#fd7e14',
          borderWidth: 1,
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: 'top', labels: { font: { size: 10 } } },
        title: { display: true, text: `Vampire Drain (Ø ${data.avg_drain_pct || 0}% / ${data.avg_drain_km || 0} km pro Tag)`, font: { size: 12 } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 9 } }, grid: { display: false } },
        y: { position: 'left', title: { display: true, text: '%/Tag' }, ticks: { font: { size: 9 } }, beginAtZero: true, max: 5 },
        y1: { position: 'right', title: { display: true, text: 'km/Tag' }, ticks: { font: { size: 9 } }, grid: { drawOnChartArea: false }, beginAtZero: true, max: 30 }
      }
    }
  });
}

/**
 * Range Projection Chart
 */
function renderRangeProjectionChart(data) {
  const canvas = document.getElementById('chartRangeProjection');
  if (!canvas || !window.Chart) return;
  
  if (!data || !data.available || !data.data || data.data.length === 0) {
    canvas.innerHTML = '<div class="text-muted small p-2">Keine Range Projection Daten</div>';
    return;
  }
  
  const labels = data.data.map(d => d.day);
  const ratedRange = data.data.map(d => d.rated_range_km);
  const projectedRange = data.data.map(d => d.projected_range_100pct_km);
  const temp = data.data.map(d => d.outside_temp_c);
  
  if (window.chartRangeProjectionChart) window.chartRangeProjectionChart.destroy();
  
  window.chartRangeProjectionChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Rated Range @100% (km)',
          data: ratedRange,
          borderColor: '#6f42c1',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.2,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Projizierte Range @100% (temp. korrigiert)',
          data: projectedRange,
          borderColor: '#198754',
          backgroundColor: '#19875420',
          fill: true,
          tension: 0.2,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Außen-Temp (°C)',
          data: temp,
          borderColor: '#ffc107',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.2,
          pointRadius: 1,
          borderDash: [4, 4],
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { font: { size: 10 } } },
        title: { display: true, text: `Range Projection @100% (Basis: ${data.base_rated_range_km || '–'} km)`, font: { size: 12 } }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 9 } }, grid: { display: false } },
        y: { position: 'left', title: { display: true, text: 'Range (km)' }, ticks: { font: { size: 9 } }, beginAtZero: false },
        y1: { position: 'right', title: { display: true, text: 'Temp (°C)' }, ticks: { font: { size: 9 } }, grid: { drawOnChartArea: false } }
      }
    }
  });
  
  // Show live value if available
  if (data.live && data.live.projected_range_100pct_km) {
    const liveDiv = document.getElementById('rangeLiveValue');
    if (liveDiv) {
      liveDiv.innerHTML = `<small class="text-success">Live: ${data.live.rated_range_km} km @ ${data.live.outside_temp_c}°C → <strong>${data.live.projected_range_100pct_km} km</strong> bei 100%</small>`;
    }
  }
}

/**
 * Render all vehicle charts container
 */
function renderVehicleCharts(batteryHealth, chargingCurve, vampireDrain, rangeProjection, nerdKpis) {
  const container = document.getElementById('vehicleChartsSection');
  if (!container) return;
  
  container.innerHTML = `
    <div class="row g-2 mt-3" id="vehicleChartsSectionContent">
      <div class="col-12">
        <h6 class="mb-2">🚗 Fahrzeug-Analysen (TeslaMate)</h6>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header py-2">🔋 Battery Health & Capacity</div>
          <div class="card-body p-2"><canvas id="chartBatteryHealth" height="180"></canvas></div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header py-2">⚡ Ladekurven (Power über SoC)</div>
          <div class="card-body p-2" id="chargingCurveContainer"></div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header py-2">🧛 Vampire Drain (Standby-Verlust)</div>
          <div class="card-body p-2"><canvas id="chartVampireDrain" height="180"></canvas></div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header py-2">📏 Range Projection @100% (Temperatur-korrigiert)
            <div id="rangeLiveValue" class="small"></div>
          </div>
          <div class="card-body p-2"><canvas id="chartRangeProjection" height="180"></canvas></div>
        </div>
      </div>
      <div class="col-lg-6">
        <div class="card h-100">
          <div class="card-header py-2">🧪 Batterie-Degradation (Odometer vs. Range@100%)</div>
          <div class="card-body p-2"><canvas id="chartDegradation" height="180"></canvas></div>
        </div>
      </div>
    </div>
  `;
  
  // Trigger chart rendering
  if (batteryHealth) renderBatteryHealthChart(batteryHealth);
  if (chargingCurve) renderChargingCurveChart(chargingCurve);
  if (vampireDrain) renderVampireDrainChart(vampireDrain);
  if (rangeProjection) renderRangeProjectionChart(rangeProjection);
  if (nerdKpis?.battery_degradation) renderDegradationChart(nerdKpis.battery_degradation);
}

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
      window._allDriveCompareData = driveCompareData;
      renderDriveTablePage(1);
      
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
    const filtered = driveCompareData.filter(d => 
      (d.route || '').toLowerCase().includes(q)
    );
    window._allDriveCompareData = filtered;
    renderDriveTablePage(1);
  });

  selectAll.addEventListener('change', () => {
    const allCheckboxes = tbody.querySelectorAll('input[type="checkbox"][data-drive-id]');
    allCheckboxes.forEach(cb => {
      cb.checked = selectAll.checked;
    });
    // Also update checkboxes on other pages by storing the selection state
    window._driveCompareSelectAll = selectAll.checked;
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
  
  // Store all drives for pagination
  window._allDriveCompareData = drives || [];
  renderDriveTablePage(1);
}

function renderDriveTablePage(page) {
  const drives = window._allDriveCompareData || [];
  const perPage = 10;
  const totalPages = Math.ceil(drives.length / perPage);
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const pageDrives = drives.slice(start, end);
  
  const tbody = document.querySelector('#tblDrives tbody');
  const selectAll = document.getElementById('driveSelectAll');
  if (!tbody) return;
  
  // Apply global select-all state if set
  const globalSelectAll = window._driveCompareSelectAll === true;
  selectAll.checked = globalSelectAll;
  
  if (!pageDrives.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4 text-muted">Keine Fahrten im Zeitraum</td></tr>';
  } else {
    tbody.innerHTML = pageDrives.map(d => `
      <tr>
        <td><input type="checkbox" data-drive-id="${d.id}" class="form-check-input" ${globalSelectAll ? 'checked' : ''}></td>
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
  
  // Render pagination
  renderDrivePagination(page, totalPages);
}

function renderDrivePagination(currentPage, totalPages) {
  const pagination = document.getElementById('driveComparePagination');
  if (!pagination) return;
  
  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }
  
  let html = '';
  
  // Previous button
  html += `<li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
    <a class="page-link" href="#" data-page="${currentPage - 1}" aria-label="Previous">
      <span aria-hidden="true">&laquo;</span>
    </a></li>`;
  
  // Page numbers
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) {
    startPage = Math.max(1, endPage - 4);
  }
  
  for (let i = startPage; i <= endPage; i++) {
    html += `<li class="page-item ${i === currentPage ? 'active' : ''}">
      <a class="page-link" href="#" data-page="${i}">${i}</a></li>`;
  }
  
  // Next button
  html += `<li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
    <a class="page-link" href="#" data-page="${currentPage + 1}" aria-label="Next">
      <span aria-hidden="true">&raquo;</span>
    </a></li>`;
  
  pagination.innerHTML = html;
  
  // Add click handlers
  pagination.querySelectorAll('.page-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = parseInt(link.dataset.page, 10);
      if (!isNaN(page) && page >= 1 && page <= totalPages && page !== currentPage) {
        renderDriveTablePage(page);
      }
    });
  });
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
      
      // Safely destroy previous instance
      if (window.driveConsChart) {
        try { if (window.driveConsChart instanceof Chart) window.driveConsChart.destroy(); } catch(e) {}
        window.driveConsChart = null;
      }
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

// ── Degradation Scatter Chart (from Nerd Stats) ──────────────────
function renderDegradationChart(bd) {
  const ctx = document.getElementById('chartDegradation');
  if (!ctx || !window.Chart) return;
  if (chartInstances.chartDegradation) { try { chartInstances.chartDegradation.destroy(); } catch(e) {} }
  
  // Get degradation data points from the API
  fetch(`/api/nerd/charts?days=${currentDays}`)
    .then(r => r.json())
    .then(data => {
      const degData = data.degradation || [];
      if (!degData.length) {
        ctx.innerHTML = '<div class="text-muted small p-2">Keine Degradationsdaten</div>';
        return;
      }
      chartInstances.chartDegradation = new Chart(ctx, {
        type: 'scatter',
        data: {
          datasets: [{
            label: 'Projizierte 100% Reichweite (km)',
            data: degData.map(d => ({x: d.odo, y: d.range_100})),
            backgroundColor: 'rgba(14, 165, 233, 0.6)',
            borderColor: 'rgba(14, 165, 233, 1)',
            pointRadius: 4,
            pointHoverRadius: 6,
            showLine: false
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: {
            legend: { display: false },
            title: { display: true, text: `Batterie-Degradation: Odometer vs. projizierte 100% Reichweite (${bd.degradation_pct?.toFixed(2) || '?'}%)`, font: { size: 12 } },
            tooltip: { callbacks: { label: ctx => `Odo: ${Math.round(ctx.parsed.x).toLocaleString('de-DE')} km | Range@100%: ${ctx.parsed.y.toFixed(1)} km` } }
          },
          scales: {
            x: { ticks: { font: { size: 9 } }, title: { display: true, text: 'Kilometerstand (km)' } },
            y: { ticks: { font: { size: 9 } }, title: { display: true, text: 'Range @100% (km)' }, beginAtZero: false }
          }
        }
      });
    })
    .catch(e => console.error('Degradation chart failed', e));
}

/* ============================================================
   HEATMAPS for Statistik
   ============================================================ */

function renderHeatmaps(series, kpis) {
  const container = document.getElementById('statsSecondary');
  if (!container) return;
  
  if (!series || series.length === 0) {
    container.innerHTML = '';
    const heatmapsSection = document.getElementById('heatmapsSection');
    if (heatmapsSection) heatmapsSection.style.display = 'none';
    return;
  }
  
  const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const daysOfWeek = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  
  // Data matrices: day-of-week x month
  const consumptionMatrix = Array(7).fill().map(() => Array(12).fill(null));
  const costMatrix = Array(7).fill().map(() => Array(12).fill(null));
  const kmMatrix = Array(7).fill().map(() => Array(12).fill(null));
  const countMatrix = Array(7).fill().map(() => Array(12).fill(0));
  
  series.forEach(d => {
    const date = new Date(d.day + 'T00:00:00');
    const month = date.getMonth();
    const dow = (date.getDay() + 6) % 7; // 0=Mon
    
    if (d.consumption != null) {
      consumptionMatrix[dow][month] = (consumptionMatrix[dow][month] || 0) + d.consumption;
      countMatrix[dow][month]++;
    }
    if (d.cost != null) costMatrix[dow][month] = (costMatrix[dow][month] || 0) + d.cost;
    if (d.km != null) kmMatrix[dow][month] = (kmMatrix[dow][month] || 0) + d.km;
  });
  
  // Average consumption
  for (let dow = 0; dow < 7; dow++) {
    for (let m = 0; m < 12; m++) {
      if (countMatrix[dow][m] > 0) consumptionMatrix[dow][m] /= countMatrix[dow][m];
      else consumptionMatrix[dow][m] = null;
    }
  }
  
  // Helper: normalize value to 0-1 for color
  const getNorm = (matrix) => {
    const vals = matrix.flat().filter(v => v != null);
    if (!vals.length) return {min: 0, max: 1};
    return {min: Math.min(...vals), max: Math.max(...vals)};
  };
  
  // Build a single heatmap card
  function buildHeatmapCard(matrix, title, unit, colorScheme) {
    const {min, max} = getNorm(matrix);
    const range = max - min || 1;
    
    const colorMap = {
      green: (n) => `rgb(${Math.round(255*(1-n))}, ${Math.round(200+55*n)}, 100)`,
      blue: (n) => `rgb(${Math.round(100*(1-n))}, ${Math.round(150+105*n)}, 255)`,
      purple: (n) => `rgb(${Math.round(150+105*n)}, ${Math.round(100*(1-n))}, 255)`,
    };
    const getColor = colorMap[colorScheme] || colorMap.green;
    
    let cells = '';
    for (let dow = 0; dow < 7; dow++) {
      for (let m = 0; m < 12; m++) {
        const val = matrix[dow][m];
        let style = 'background:#e9ecef;color:#6c757d;';
        let text = '\u2013';
        if (val != null) {
          const n = (val - min) / range;
          style = `background:${getColor(n)};color:#fff;`;
          text = val.toFixed(1) + ' ' + unit;
        }
        cells += `<div class="heatmap-cell" style="${style}font-size:0.7rem;padding:3px 2px;text-align:center;min-height:22px;display:flex;align-items:center;justify-content:center;" title="${daysOfWeek[dow]} ${months[m]}: ${text}">${text}</div>`;
      }
    }
    
    const header = months.map(m => `<div style="font-weight:600;font-size:0.65rem;padding:2px;text-align:center;">${m}</div>`).join('');
    const rows = daysOfWeek.map((d, i) => 
      `<div style="display:grid;grid-template-columns:28px repeat(12,1fr);gap:1px;align-items:center;">
        <div style="font-weight:600;font-size:0.65rem;padding:2px;text-align:right;">${d}</div>
        ${cells.slice(i*12, (i+1)*12).join('')}
       </div>`
    ).join('');
    
    return `
      <div class="col-12 col-lg-6 col-xl-4 mb-3">
        <div class="card h-100">
          <div class="card-header py-2"><small>${title}</small></div>
          <div class="card-body p-2">
            <div class="heatmap-grid" style="display:grid;grid-template-columns:28px repeat(12,1fr);gap:1px;font-size:0.7rem;">
              <div style="grid-column:1;"></div>${header}
              ${rows}
            </div>
          </div>
        </div>
      </div>`;
  }
  
  container.innerHTML = `
    <div class="row g-2">
      ${buildHeatmapCard(consumptionMatrix, '\u26a1 Verbrauch (kWh/100km) - Wochentag x Monat', 'kWh/100km', 'green')}
      ${buildHeatmapCard(costMatrix, '\ud83d\udcb0 Kosten (\u20ac) - Wochentag x Monat', '\u20ac', 'blue')}
      ${buildHeatmapCard(kmMatrix, '\ud83d\udde3 Kilometer - Wochentag x Monat', 'km', 'purple')}
    </div>`;
  
  const heatmapsSection = document.getElementById('heatmapsSection');
  if (heatmapsSection) heatmapsSection.style.display = 'block';
}

