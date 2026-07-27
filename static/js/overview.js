// overview.js - Übersichtsseite (Dashboard mit 5 KPIs, 3 Charts links, Donut + 2 Heatmaps rechts)
let currentDays = 90;
let currentFrom = null;
let currentTo = null;
let currentPageMerged = 1;
const PER_PAGE = 20;

// Chart instances für Cleanup
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

async function loadOverview() {
  try {
    const params = buildApiParams(currentPageMerged);
    const [merged, stats, chartsData] = await Promise.all([
      fetch(`/api/merged?${params}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({rows: [], pagination: {}})),
      fetch(`/api/stats?days=${currentDays}${currentFrom ? '&from='+currentFrom+'&to='+currentTo : ''}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({totals: {}, home: {}, external: {}, monthly: []})),
      fetch(`/api/charts?days=${currentDays}${currentFrom ? '&from='+currentFrom+'&to='+currentTo : ''}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({series: [], kpis: {}}))
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
  const tb = document.querySelector('#tblMerged tbody');
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
  const nav = document.getElementById('paginationMerged');
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
  
  nav.querySelectorAll('.page-link[data-page]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = parseInt(link.getAttribute('data-page'));
      if (!isNaN(page) && page >= 1 && page <= totalPages && page !== currentPageMerged) {
        currentPageMerged = page;
        loadOverview();
      }
    });
  });
}

function buildDetail(r) {
  let html = '<div class="row"><div class="col-md-6"><strong>🏠 Zuhause</strong><ul class="mb-2 ps-3">';
  if (r.evcc && r.evcc.length) {
    r.evcc.forEach(e => html += `<li>EVCC ${e.created ? e.created.slice(11,16) : ''} · ${fmtKwh(e.charged_kwh)} · ${fmtEUR(e.total_cost)} · PV ${fmtPct(e.solar_percentage)}</li>`);
  }
  if (r.tm_home && r.tm_home.length) {
    r.tm_home.forEach(t => html += `<li class="text-muted">TeslaMate ${t.label || t.address || ''}: added ${fmtKwh(t.added)} / used ${fmtKwh(t.used)} → Verlust ${fmtKwh(t.used - t.added)} (${t.n_frags} Teil-Lad.)</li>`);
  }
  if (!(r.evcc && r.evcc.length) && !(r.tm_home && r.tm_home.length)) html += '<li>–</li>';
  html += '</ul></div><div class="col-md-6"><strong>🔌 Extern</strong><ul class="mb-0 ps-3">';
  if (r.tm_ext && r.tm_ext.length) {
    r.tm_ext.forEach(t => html += `<li>${t.label || t.address || 'Extern'} ${t.start ? t.start.slice(11,16) : ''}–${t.end ? t.end.slice(11,16) : ''}: ${fmtKwh(t.added)} · ${fmtEUR(t.cost)} (${t.n_frags} Teil-Lad.)</li>`);
  } else {
    html += '<li>–</li>';
  }
  html += '</ul></div></div>';
  return html;
}

function renderKPIs(s, mergedRows = []) {
  s = s || {};
  const t = s.totals || {};
  const h = s.home || {};
  const e = s.external || {};
  const monthly = s.monthly || [];
  
  // Current period values
  const distanceKm = t.total_km || t.distance_km || 0;
  const totalKwh = t.kwh || (t.home_kwh || 0) + (t.ext_kwh || 0);
  const consumption = t.consumption_kwh_per_100km || (distanceKm > 0 ? totalKwh / (distanceKm / 100) : 0);
  const costPerKm = t.cost_per_km || (t.cost_home_and_external || 0) / (distanceKm || 1);
  const costPer100km = costPerKm * 100;
  const totalCost = t.cost_home_and_external || 0;
  const homeLossKwh = t.home_loss_kwh || 0;
  const lossPct = totalKwh > 0 ? (homeLossKwh / totalKwh * 100) : 0;
  
  // Days in period for daily average
  const daysInPeriod = currentFrom && currentTo 
    ? Math.ceil((new Date(currentTo) - new Date(currentFrom)) / (1000*60*60*24)) + 1
    : (currentDays || 90);
  const kmPerDay = daysInPeriod > 0 ? distanceKm / daysInPeriod : 0;
  const kwhPer100km = distanceKm > 0 ? totalKwh / (distanceKm / 100) : 0;
  
  // Previous period comparison (use monthly data if available with distance_km)
  let consumptionChangePct = 0;
  let costChangePct = 0;
  if (monthly.length >= 2) {
    const last = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    if (last.distance_km && prev.distance_km && last.distance_km > 0 && prev.distance_km > 0) {
      const lastCons = last.total_kwh > 0 ? last.total_kwh / (last.distance_km / 100) : 0;
      const prevCons = prev.total_kwh > 0 ? prev.total_kwh / (prev.distance_km / 100) : 0;
      if (prevCons > 0) consumptionChangePct = ((lastCons - prevCons) / prevCons) * 100;
      const lastCost = last.total_cost / last.distance_km * 100;
      const prevCost = prev.total_cost / prev.distance_km * 100;
      if (prevCost > 0) costChangePct = ((lastCost - prevCost) / prevCost) * 100;
    }
  }
  
  // 5 KPIs for first row (col-lg-2 = 5 per row on large screens)
  const cards = [
    {
      icon: '🛣️',
      title: 'Gefahrene km',
      value: distanceKm.toLocaleString('de-DE', {minimumFractionDigits: 0}) + ' km',
      sub: `Ø ${kmPerDay.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1})} km/Tag`,
      color: 'primary'
    },
    {
      icon: '⚡',
      title: 'Geladene kWh',
      value: totalKwh.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1}) + ' kWh',
      sub: `Ø ${kwhPer100km.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1})} kWh/100km`,
      color: 'success'
    },
    {
      icon: '🔋',
      title: 'Durchschn. Verbrauch',
      value: consumption.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1}) + ' kWh/100km',
      sub: `${consumptionChangePct >= 0 ? '+' : ''}${consumptionChangePct.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1})}% ggü. Vorperiode`,
      color: 'info'
    },
    {
      icon: '💶',
      title: 'Durchschn. Kosten',
      value: fmtEUR(costPer100km) + ' / 100 km',
      sub: `Gesamt ${fmtEUR(totalCost)} ${costChangePct !== 0 ? `(${costChangePct >= 0 ? '+' : ''}${costChangePct.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1})}%)` : ''}`,
      color: 'warning'
    },
    {
      icon: '🔌',
      title: 'Ladeverluste',
      value: homeLossKwh.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1}) + ' kWh',
      sub: `${lossPct.toLocaleString('de-DE', {minimumFractionDigits: 1, maximumFractionDigits: 1})}% der geladenen Energie`,
      color: 'danger'
    }
  ];
  
  document.getElementById('summaryCards').innerHTML = cards.map(c => `
      <div class="col-6 col-md-4 col-lg-2">
        <div class="card kpi-card text-white bg-${c.color} h-100">
          <div class="card-body py-3">
            <div class="kpi-label opacity-75 small"><span class="kpi-icon me-1">${c.icon}</span> ${c.title}</div>
            <div class="kpi-value fw-bold fs-5">${c.value}</div>
            <div class="kpi-sub small">${c.sub}</div>
          </div>
        </div>
      </div>`).join('');
  }

  // --- Defensive DOM helpers ---
  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function getEl(id) {
    return document.getElementById(id);
  }

function renderCharts(chartsData, stats) {
  const s = chartsData.series || [];
  const kpis = chartsData.kpis || {};
  
  // Destroy existing charts
  Object.keys(charts).forEach(key => {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  });
  
  if (!window.Chart) return;
  
  const labels = s.map(d => d.day).slice().reverse();

    // ---------- 1. VERBRAUCH CHART (Line mit Area) ----------
    const consumptionData = s.map(d => d.consumption).slice().reverse();
    const avgConsumption = kpis.avg_consumption || 0;

    const chartConsumptionEl = getEl('chartConsumption');
    if (chartConsumptionEl) {
      charts.consumption = new Chart(chartConsumptionEl, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Verbrauch (kWh/100km)',
            data: consumptionData,
            borderColor: '#0dcaf0',
            backgroundColor: 'rgba(13, 202, 240, 0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5,
            spanGaps: true
          }, {
            label: 'Ø ' + avgConsumption.toFixed(1),
            data: new Array(labels.length).fill(avgConsumption),
            borderColor: '#0dcaf0',
            borderDash: [5, 5],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false
          }]
        },
        options: getLineChartOptions('kWh/100km', avgConsumption)
      });
    }

    setText('avgConsumptionBadge', 'Ø ' + avgConsumption.toFixed(1));

    // ---------- 2. KOSTEN CHART (Line mit Area) ----------
    const costData = s.map(d => d.cost_per_100).slice().reverse();
    const avgCost = kpis.avg_cost_100 || 0;

    const chartCostEl = getEl('chartCost');
    if (chartCostEl) {
      charts.cost = new Chart(chartCostEl, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Kosten (EUR/100km)',
            data: costData,
            borderColor: '#ffc107',
            backgroundColor: 'rgba(255, 193, 7, 0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5,
            spanGaps: true
          }, {
            label: 'Ø ' + avgCost.toFixed(2),
            data: new Array(labels.length).fill(avgCost),
            borderColor: '#ffc107',
            borderDash: [5, 5],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false
          }]
        },
        options: getLineChartOptions('EUR/100km', avgCost)
      });
    }

    setText('avgCostBadge', 'Ø ' + avgCost.toFixed(2));

    // ---------- 3. KILOMETER CHART (Bar) ----------
    const kmData = s.map(d => d.km).slice().reverse();
    const totalKm = kpis.total_km || 0;

    const chartKmEl = getEl('chartKm');
    if (chartKmEl) {
      charts.km = new Chart(chartKmEl, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'km',
            data: kmData,
            backgroundColor: '#0d6efd',
            borderRadius: 4,
            barThickness: 'flex',
            maxBarThickness: 40
          }]
        },
        options: {
          ...getBaseChartOptions(),
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ctx.parsed.y + ' km' } }
          },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, title: { display: true, text: 'km' } }
          }
        }
      });
    }

    setText('totalKmBadge', 'Σ ' + totalKm.toLocaleString('de-DE', {minimumFractionDigits: 1}) + ' km');

    // ---------- 4. HOME vs EXTERN DONUT ----------
    renderHomeExternDonut(stats);

    // ---------- 5. HEATMAP: VERBRAUCH / TEMPERATUR ----------
    renderHeatmapTempConsumption(s);

    // ---------- 6. HEATMAP: VERBRAUCH / WOCHENTAG ----------
    renderHeatmapWeekdayConsumption(s);
  }

function getLineChartOptions(yTitle, avgValue) {
  return {
    ...getBaseChartOptions(),
    plugins: {
      legend: { display: false },
      tooltip: { 
        callbacks: { 
          label: ctx => ctx.datasetIndex === 0 ? ctx.parsed.y + ' ' + yTitle : 'Durchschnitt: ' + avgValue.toFixed(1) + ' ' + yTitle 
        }
      }
    },
    scales: {
      x: { grid: { display: false } },
      y: { 
        beginAtZero: true, 
        title: { display: true, text: yTitle },
        suggestedMax: avgValue * 2.5
      }
    },
    interaction: { intersect: false, mode: 'index' }
  };
}

function getBaseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    layout: { padding: { top: 5, right: 10, bottom: 5, left: 5 } }
  };
}

function renderHomeExternDonut(stats) {
  const h = stats.home || {};
  const e = stats.external || {};
  
  const homeKwh = h.kwh || 0;
  const extKwh = e.kwh || 0;
  const totalKwh = homeKwh + extKwh;
  const homePct = totalKwh > 0 ? (homeKwh / totalKwh * 100).toFixed(1) : '0.0';
  const extPct = totalKwh > 0 ? (extKwh / totalKwh * 100).toFixed(1) : '0.0';
  
  // Avg price per kWh
  const homeGridCost = h.grid_cost || 0;
  const homeGridKwh = h.grid_kwh || 0;
  const homePvCost = h.pv_cost || 0;
  const homePvKwh = h.pv_kwh || 0;
  const homePrice = (homeKwh > 0) ? ((homeGridCost + homePvCost) / homeKwh).toFixed(2) : '0.00';
  
  const extCost = e.cost || 0;
  const extPrice = (extKwh > 0) ? (extCost / extKwh).toFixed(2) : '0.00';
  
  // Update side labels
  setText('homeKwh', homeKwh.toLocaleString('de-DE', {minimumFractionDigits: 1}) + ' kWh');
  setText('homePct', homePct + '%');
  setText('homePrice', 'Ø ' + homePrice + ' €/kWh');
  
  setText('extKwh', extKwh.toLocaleString('de-DE', {minimumFractionDigits: 1}) + ' kWh');
  setText('extPct', extPct + '%');
  setText('extPrice', 'Ø ' + extPrice + ' €/kWh');
  
  // Donut chart
  const ctx = getEl('chartHomeExtern');
  if (!ctx || !window.Chart) return;
  
  if (charts.homeExtern) charts.homeExtern.destroy();
  
  charts.homeExtern = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Zuhause', 'Extern'],
      datasets: [{
        data: [homeKwh, extKwh],
        backgroundColor: ['#198754', '#0dcaf0'],
        borderWidth: 0,
        cutout: '70%'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ctx.label + ': ' + ctx.parsed.toLocaleString('de-DE', {minimumFractionDigits: 1}) + ' kWh (' + (ctx.parsed / totalKwh * 100).toFixed(1) + '%)'
          }
        }
      },
      layout: { padding: 0 }
    }
  });
}

function renderHeatmapTempConsumption(series) {
  const tempBins = ['<0°C', '0-10°C', '11-20°C', '21-30°C', '>30°C'];
  const consBins = ['<14', '14-16', '16-18', '18-20', '>20'];
  
  // Heatmap data matrix [tempBin][consBin] = count
  const matrix = Array(5).fill().map(() => Array(5).fill(0));
  
  series.forEach(d => {
    if (d.consumption !== null && d.consumption !== undefined) {
      let consIdx = 0;
      if (d.consumption >= 20) consIdx = 4;
      else if (d.consumption >= 18) consIdx = 3;
      else if (d.consumption >= 16) consIdx = 2;
      else if (d.consumption >= 14) consIdx = 1;
      else consIdx = 0;
      
      // Mock temperature distribution for demo
      // In real implementation, use actual temperature data
      const tempIdx = Math.floor(Math.random() * 5);
      matrix[tempIdx][consIdx]++;
    }
  });
  
  // Convert to Chart.js heatmap format (using point style)
  const datasets = [];
  const colors = [
    'rgba(64, 224, 208, 0.3)',   // Türkis
    'rgba(64, 224, 208, 0.6)',
    'rgba(46, 204, 113, 0.6)',   // Grün
    'rgba(241, 196, 15, 0.6)',   // Gelb
    'rgba(230, 126, 34, 0.6)',   // Orange
    'rgba(231, 76, 60, 0.8)'     // Rot
  ];
  
  // For Chart.js, we'll use a scatter-like approach with pointStyle rect
  const points = [];
  matrix.forEach((row, tIdx) => {
    row.forEach((val, cIdx) => {
      if (val > 0) {
        // Size and color based on value
        const maxVal = Math.max(...matrix.flat());
        const size = Math.max(8, (val / maxVal) * 30);
        const colorIdx = Math.min(5, Math.floor((val / maxVal) * 5));
        points.push({
          x: cIdx,
          y: tIdx,
          r: size,
          value: val
        });
      }
    });
  });
  
  const ctx = getEl('heatmapTempConsumption');
  if (!ctx || !window.Chart) return;
  
  if (charts.heatmapTemp) charts.heatmapTemp.destroy();
  
  charts.heatmapTemp = new Chart(ctx, {
    type: 'bubble',
    data: { datasets: [{ 
      label: 'Anzahl Fahrten',
      data: points,
      backgroundColor: points.map(p => {
        const maxVal = Math.max(...matrix.flat());
        const ratio = p.value / maxVal;
        if (ratio < 0.2) return 'rgba(64, 224, 208, 0.5)';
        if (ratio < 0.4) return 'rgba(46, 204, 113, 0.6)';
        if (ratio < 0.6) return 'rgba(241, 196, 15, 0.7)';
        if (ratio < 0.8) return 'rgba(230, 126, 34, 0.8)';
        return 'rgba(231, 76, 60, 0.9)';
      }),
      borderWidth: 1,
      borderColor: 'rgba(0,0,0,0.2)'
    }]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `Temp: ${tempBins[ctx.raw.y]}, Verbrauch: ${consBins[ctx.raw.x]} → ${ctx.raw.value} Fahrten`
          }
        }
      },
      scales: {
        x: { 
          type: 'linear',
          min: -0.5, max: 4.5,
          ticks: { stepSize: 1, callback: (v) => consBins[v] },
          title: { display: true, text: 'Verbrauch (kWh/100km)' }
        },
        y: { 
          type: 'linear',
          min: -0.5, max: 4.5,
          ticks: { stepSize: 1, callback: (v) => tempBins[v] },
          title: { display: true, text: 'Temperatur' },
          reverse: true
        }
      }
    }
  });
  
  // Legend
  setHtml('legendTempConsumption', 
    '<div class="d-flex flex-wrap gap-2 small text-muted">' +
    ['< 14', '14–16', '16–18', '18–20', '> 20'].map((label, i) => 
      `<span class="d-inline-flex align-items-center gap-1"><span class="badge bg-secondary" style="background:${['rgba(64,224,208,0.5)','rgba(46,204,113,0.6)','rgba(241,196,15,0.7)','rgba(230,126,34,0.8)','rgba(231,76,60,0.9)'][i]}">${label}</span></span>`
    ).join('') +
    '</div>');
}

function renderHeatmapWeekdayConsumption(series) {
  // Weekday bins: Mo-So (0-6)
  // Consumption bins: <14, 14-16, 16-18, 18-20, >20
  const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const consBins = ['<14', '14–16', '16–18', '18–20', '>20'];
  
  const matrix = Array(7).fill().map(() => Array(5).fill(0));
  
  series.forEach(d => {
    if (d.consumption !== null && d.consumption !== undefined && d.day) {
      const date = new Date(d.day);
      const wday = date.getDay(); // 0=So, 1=Mo...
      const wdayIdx = wday === 0 ? 6 : wday - 1; // Mo=0 ... So=6
      
      let consIdx = 0;
      if (d.consumption >= 20) consIdx = 4;
      else if (d.consumption >= 18) consIdx = 3;
      else if (d.consumption >= 16) consIdx = 2;
      else if (d.consumption >= 14) consIdx = 1;
      else consIdx = 0;
      
      matrix[wdayIdx][consIdx]++;
    }
  });
  
  const points = [];
  matrix.forEach((row, wIdx) => {
    row.forEach((val, cIdx) => {
      if (val > 0) {
        const maxVal = Math.max(...matrix.flat());
        const size = Math.max(8, (val / maxVal) * 30);
        points.push({ x: cIdx, y: wIdx, r: size, value: val });
      }
    });
  });
  
  const ctx = getEl('heatmapWeekdayConsumption');
  if (!ctx || !window.Chart) return;
  
  if (charts.heatmapWeekday) charts.heatmapWeekday.destroy();
  
  charts.heatmapWeekday = new Chart(ctx, {
    type: 'bubble',
    data: { datasets: [{ 
      label: 'Anzahl Fahrten',
      data: points,
      backgroundColor: points.map(p => {
        const maxVal = Math.max(...matrix.flat());
        const ratio = p.value / maxVal;
        if (ratio < 0.2) return 'rgba(64, 224, 208, 0.5)';
        if (ratio < 0.4) return 'rgba(46, 204, 113, 0.6)';
        if (ratio < 0.6) return 'rgba(241, 196, 15, 0.7)';
        if (ratio < 0.8) return 'rgba(230, 126, 34, 0.8)';
        return 'rgba(231, 76, 60, 0.9)';
      }),
      borderWidth: 1,
      borderColor: 'rgba(0,0,0,0.2)'
    }]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${weekdays[ctx.raw.y]}, Verbrauch: ${consBins[ctx.raw.x]} → ${ctx.raw.value} Fahrten`
          }
        }
      },
      scales: {
        x: { 
          type: 'linear',
          min: -0.5, max: 4.5,
          ticks: { stepSize: 1, callback: (v) => consBins[v] },
          title: { display: true, text: 'Verbrauch (kWh/100km)' }
        },
        y: { 
          type: 'linear',
          min: -0.5, max: 6.5,
          ticks: { stepSize: 1, callback: (v) => weekdays[v] },
          title: { display: true, text: 'Wochentag' },
          reverse: true
        }
      }
    }
  });
  
  // Legend
  setHtml('legendWeekdayConsumption', 
    '<div class="d-flex flex-wrap gap-2 small text-muted">' +
    ['< 14', '14–16', '16–18', '18–20', '> 20'].map((label, i) => 
      `<span class="d-inline-flex align-items-center gap-1"><span class="badge" style="background:${['rgba(64,224,208,0.5)','rgba(46,204,113,0.6)','rgba(241,196,15,0.7)','rgba(230,126,34,0.8)','rgba(231,76,60,0.9)'][i]}">${label}</span></span>`
    ).join('') +
    '</div>');
}

document.addEventListener('DOMContentLoaded', () => {
  // Listen to global date range changes
  window.addEventListener('globalRangeChange', (e) => {
    const params = e.detail;
    if (params.startsWith('from=')) {
      const urlParams = new URLSearchParams(params);
      currentFrom = urlParams.get('from');
      currentTo = urlParams.get('to');
      currentDays = 365;
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
      setHtml('rangeFrom', currentFrom);
      setHtml('rangeTo', currentTo);
    } else {
      const urlParams = new URLSearchParams(params);
      currentDays = parseInt(urlParams.get('days'), 10);
      currentFrom = null;
      currentTo = null;
      setHtml('rangeFrom', '');
      setHtml('rangeTo', '');
      document.querySelectorAll('[data-days]').forEach(b => {
        if (parseInt(b.getAttribute('data-days'), 10) === currentDays) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });
    }
    currentPageMerged = 1;
    loadOverview();
  });
  
  loadOverview();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';