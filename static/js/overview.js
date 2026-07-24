// overview.js - Übersichtsseite (merged Tabelle + KPIs + Charts)
let currentDays = 365;
let currentFrom = null;
let currentTo = null;

function buildApiParams() {
  // Use global date range if available
  if (typeof getGlobalRangeParams === 'function') {
    return getGlobalRangeParams();
  }
  if (currentFrom && currentTo) {
    return `from=${currentFrom}&to=${currentTo}`;
  }
  return `days=${currentDays}`;
}

async function loadOverview() {
  try {
    const params = buildApiParams();
    const [merged, stats, charts, vehicleLive] = await Promise.all([
      fetch(`/api/merged?${params}`, {credentials: "same-origin"}).then(r => r.json()),
      fetch(`/api/stats?${params}`, {credentials: "same-origin"}).then(r => r.json()),
      fetch(`/api/charts?${params}`, {credentials: "same-origin"}).then(r => r.json()),
      fetch(`/api/vehicle/live`, {credentials: "same-origin"}).then(r => r.json()).catch(() => ({available: false}))
    ]);
    
    renderMergedTable(merged);
    renderKPIs(stats);
    renderSourceChart(stats);
    renderMergedDayChart(charts);
    updateRangeLabel();
    renderVehicleLive(vehicleLive);
  } catch (e) {
    console.error('loadOverview failed', e);
  }
}

function renderVehicleLive(data) {
  const section = document.getElementById('vehicleLiveSection');
  const badge = document.getElementById('liveStatusBadge');
  
  if (!data || !data.available) {
    if (section) section.style.display = 'none';
    return;
  }
  
  if (section) section.style.display = 'block';
  if (badge) {
    badge.textContent = data.mock ? 'Demo' : 'Live';
    badge.className = data.mock ? 'badge bg-warning text-dark' : 'badge bg-success';
  }
  
  // Main values
  const setText = (id, val, suffix = '') => {
    const el = document.getElementById(id);
    if (el) el.textContent = val != null ? val + suffix : '–';
  };
  
  setText('liveSoc', data.battery_level, '%');
  setText('liveRange', data.ideal_range_km ? Math.round(data.ideal_range_km) : '–');
  setText('liveOdo', data.odometer_km ? data.odometer_km.toLocaleString('de-DE') : '–');
  setText('liveHealth', data.battery_health_pct ? data.battery_health_pct : '–', '%');
  
  // Temps
  const tempEl = document.getElementById('liveTemp');
  if (tempEl) {
    const out = data.outside_temp != null ? data.outside_temp.toFixed(1) : '–';
    const inn = data.inside_temp != null ? data.inside_temp.toFixed(1) : '–';
    tempEl.textContent = `${out}° / ${inn}°`;
  }
  
  // Tires
  const tiresEl = document.getElementById('liveTires');
  if (tiresEl) {
    const fl = data.tire_pressure_fl?.toFixed(1) || '–';
    const fr = data.tire_pressure_fr?.toFixed(1) || '–';
    const rl = data.tire_pressure_rl?.toFixed(1) || '–';
    const rr = data.tire_pressure_rr?.toFixed(1) || '–';
    tiresEl.innerHTML = `FL ${fl} FR ${fr}<br>RL ${rl} RR ${rr}`;
  }
  
  // Charging
  const chgEl = document.getElementById('liveCharging');
  if (chgEl) {
    const plugged = data.plugged_in ? '🔌 Angesteckt' : '🔋 Nicht angesteckt';
    const state = data.charging_state ? ` (${data.charging_state})` : '';
    chgEl.textContent = plugged + state;
  }
  
  // Doors/Climate
  const doorsEl = document.getElementById('liveDoors');
  if (doorsEl) {
    const doors = [data.door_fl, data.door_fr, data.door_rl, data.door_rr].filter(Boolean).length;
    const trunks = [data.trunk_front, data.trunk_rear].filter(Boolean).length;
    const open = doors + trunks;
    const climate = data.climate_on ? `🌡️ ${data.climate_temp?.toFixed(1) || 'on'}°` : '🌡️ aus';
    doorsEl.textContent = open > 0 ? `🚪 ${open} offen / ${climate}` : `🔒 zu / ${climate}`;
  }
}

function renderMergedTable(rows) {
  const tb = document.querySelector('#tblMerged tbody');
  if (!tb) return;
  
  if (!rows || rows.length === 0) {
    tb.innerHTML = '<tr><td colspan="11" class="text-center py-4 text-muted">Keine Daten</td></tr>';
    return;
  }
  
  const displayRows = rows.slice(0, 25);
  
  tb.innerHTML = displayRows.map((r, i) => `
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
  
  document.getElementById('summaryCards').innerHTML = cards.map(c => `
    <div class="col-6 col-md-4 col-lg-3">
      <div class="card kpi-card text-white bg-${c.c} h-100">
        <div class="card-body py-2">
          <div class="kpi-label opacity-75"><span class="kpi-icon">${c.icon}</span> ${c.t}</div>
          <div class="kpi-value">${c.v}</div>
          <div class="kpi-sub">${c.s}</div>
        </div>
      </div>
    </div>`).join('');
  
  // mergedKpis
  const days = rows.length;
  const totKwh = rows.reduce((a, r) => a + (r.total_kwh || 0), 0);
  const totCost = rows.reduce((a, r) => a + (r.total_cost || 0), 0);
  const extKwhM = rows.reduce((a, r) => a + (r.ext_kwh || 0), 0);
  const homeLossM = rows.reduce((a, r) => a + (r.home_loss || 0), 0);
  const cons = totKwh > 0 ? totKwh / (t.distance_km / 100) : 0;
  const consNet = cons * 0.85;
  const tco = (t.tco) || 0;
  const tco100 = (t.tco_per_100km) || 0;
  
  document.getElementById('mergedKpis').innerHTML = [
    kpiStat('🛣️ Gefahrene km', Math.round(totKwh).toLocaleString('de-DE')+' km'),
    kpiStat('⚡ Geladene kWh', totKwh.toLocaleString('de-DE', {minimumFractionDigits:1})+' kWh'),
    kpiStat('💶 Ausgaben (Energie)', fmtEUR(totCost)),
    kpiStat('💰 TCO gesamt', fmtEUR(tco), 'inkl. Anschaffung/Versicherung/Steuer'),
    kpiStat('💡 TCO / 100km', tco100.toLocaleString('de-DE', {minimumFractionDigits:2})+' €'),
    kpiStat('🔋 Ø Verbrauch', cons.toLocaleString('de-DE', {minimumFractionDigits:1})+' kWh/100km', `von der Wand · Akku ≈ ${consNet.toLocaleString('de-DE', {minimumFractionDigits:1})}`),
    kpiStat('🔌 Extern', extKwhM.toLocaleString('de-DE', {minimumFractionDigits:1})+' kWh'),
    kpiStat('📉 Ladeverlust', homeLossM.toLocaleString('de-DE', {minimumFractionDigits:1})+' kWh'),
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
  document.querySelectorAll('[data-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDays = parseInt(btn.getAttribute('data-days'), 10);
      currentFrom = null;
      currentTo = null;
      document.getElementById('rangeFrom').value = '';
      document.getElementById('rangeTo').value = '';
      loadOverview();
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
        loadOverview();
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
    loadOverview();
  });
  
  loadOverview();
});

const fmtEUR = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {style:'currency', currency:'EUR'});
const fmtKwh = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:1, maximumFractionDigits:1}) + ' kWh';
const fmtPct = v => v == null ? '–' : Number(v).toLocaleString('de-DE', {maximumFractionDigits:1}) + ' %';