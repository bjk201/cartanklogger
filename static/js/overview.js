// overview.js - Übersichtsseite (merged Tabelle + KPIs + Charts)
let currentDays = 90;
let currentFrom = null;
let currentTo = null;
let currentPageMerged = 1;
const PER_PAGE = 20;

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
    const [merged, stats, charts] = await Promise.all([
      fetch(`/api/merged?${params}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({rows: [], pagination: {}})),
      fetch(`/api/stats?days=${currentDays}${currentFrom ? '&from='+currentFrom+'&to='+currentTo : ''}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({totals: {}, home: {}, external: {}, monthly: []})),
      fetch(`/api/charts?days=${currentDays}${currentFrom ? '&from='+currentFrom+'&to='+currentTo : ''}`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({series: [], kpis: {}}))
    ]);
    
    renderMergedTable(merged.rows || merged);
    renderPaginationMerged(merged.pagination?.total || merged.pagination?.merged_total || 0);
    renderKPIs(stats, merged.rows || merged);
    renderSourceChart(stats);
    renderMergedDayChart(charts);
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
    // Check if monthly has distance_km, otherwise skip comparison
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
  
  // Second row (mergedKpis) - keep existing additional KPIs
  const rows = mergedRows || [];
  const totKwhM = rows.reduce((a, r) => a + (r.total_kwh || 0), 0);
  const totCostM = rows.reduce((a, r) => a + (r.total_cost || 0), 0);
  const extKwhM = rows.reduce((a, r) => a + (r.ext_kwh || 0), 0);
  const homeLossM = rows.reduce((a, r) => a + (r.home_loss || 0), 0);
  const consM = t.distance_km > 0 ? t.kwh / (t.distance_km / 100.0) : 0;
  const consNetM = consM * 0.85;
  const tco = t.tco || 0;
  const tco100 = t.tco_per_100km || 0;
  
  document.getElementById('mergedKpis').innerHTML = [
    kpiStat('💰 TCO gesamt', fmtEUR(tco), 'inkl. Anschaffung/Versicherung/Steuer'),
    kpiStat('💡 TCO / 100km', tco100.toLocaleString('de-DE', {minimumFractionDigits: 2}) + ' €'),
    kpiStat('🔌 Extern', extKwhM.toLocaleString('de-DE', {minimumFractionDigits: 1}) + ' kWh'),
    kpiStat('📉 Ladeverlust (Summe)', homeLossM.toLocaleString('de-DE', {minimumFractionDigits: 1}) + ' kWh'),
    kpiStat('☀️ PV-Anteil Zuhause', fmtPct(h.pv_share_pct), `${fmtKwh(h.pv_kwh||0)} PV von ${fmtKwh(t.home_kwh||0)}`),
    kpiStat('🏠 Zuhause vs. Extern', `${((t.home_kwh||0) + (t.ext_kwh||0)) > 0 ? Math.round((t.home_kwh||0) / ((t.home_kwh||0) + (t.ext_kwh||0)) * 100) : 0}% Zuhause`, `${fmtKwh(t.home_kwh||0)} zu Hause · ${fmtKwh(t.ext_kwh||0)} extern`),
  ].join('');
}

function kpiStat(label, value, sub) {
  return `<div class="col-6 col-md-4 col-lg-2"><div class="card h-100 text-center shadow-sm"><div class="card-body py-2"><div class="text-muted small">${label}</div><div class="fs-6 fw-bold">${value}</div><div class="small opacity-75">${sub||''}</div></div></div></div>`;
}

function renderSourceChart(s) {
  const h = s.home, e = s.external;
  const ctx = document.getElementById('chartSource');
  if (!ctx || !window.Chart) return;
  if (window.charts?.source) window.charts.source.destroy();
  const srcData = [h?.grid_kwh || 0, h?.pv_kwh || 0, e?.kwh || 0];
  window.charts = window.charts || {};
  window.charts.source = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['Zuhause Netz', 'Zuhause PV', 'Extern'], datasets: [{ data: srcData, backgroundColor: ['#0d6efd','#198754','#0dcaf0'] }]},
    options: { plugins: { legend: { position: 'bottom' } } }
  });
}

function renderMergedDayChart(charts) {
  const s = charts.series || [];
  const labels = s.map(d => d.day).slice().reverse();
  const ctx = document.getElementById('mergedDayChart');
  if (!ctx || !window.Chart) return;
  if (window.__mergedDayChart) window.__mergedDayChart.destroy();
  window.__mergedDayChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'km', data: s.map(d => d.km).slice().reverse(), backgroundColor: '#6f42c1', yAxisID: 'y' },
        { label: 'kWh', data: s.map(d => d.kwh).slice().reverse(), backgroundColor: '#198754', yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: { position: 'left', title: { display: true, text: 'km' } },
        y1: { position: 'right', title: { display: true, text: 'kWh' }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

function updateRangeLabel() {
  const el = document.getElementById('rangeLabel');
  if (!el) return;
  
  // Try to get global range state
  if (typeof globalDateRange !== 'undefined') {
    if (globalDateRange.from && globalDateRange.to) {
      el.textContent = `${globalDateRange.from} bis ${globalDateRange.to}`;
    } else if (globalDateRange.days >= 9999) {
      el.textContent = 'Alle Daten';
    } else {
      el.textContent = `Letzte ${globalDateRange.days} Tage`;
    }
  } else {
    el.textContent = currentDays >= 9999 ? 'Alle Daten' : `Letzte ${currentDays} Tage`;
  }
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
    currentPageMerged = 1;
    loadOverview();
  });
  
  loadOverview();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';