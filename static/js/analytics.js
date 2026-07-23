// analytics.js - Nerd Analytics Dashboard

let currentDays = 365;
let currentFrom = null;
let currentTo = null;
let degradationChart = null;
let tempEfficiencyChart = null;

function buildApiParams() {
  if (currentFrom && currentTo) {
    return `from=${currentFrom}&to=${currentTo}`;
  }
  return `days=${currentDays}`;
}

async function loadAnalytics() {
  try {
    const params = buildApiParams();
    const [kpis, charts, vampire] = await Promise.all([
      fetch(`/api/nerd/kpis?${params}`, {credentials: "same-origin"}).then(r => r.json()),
      fetch(`/api/nerd/charts?${params}`, {credentials: "same-origin"}).then(r => r.json()),
      fetch(`/api/nerd/vampire-drain?${params}`, {credentials: "same-origin"}).then(r => r.json())
    ]);
    
    renderKPIs(kpis);
    renderCharts(charts);
    renderVampireDrain(vampire);
    updateRangeLabel();
  } catch (e) {
    console.error('loadAnalytics failed', e);
  }
}

function renderKPIs(kpis) {
  const cards = [
    {
      icon: '🧛',
      title: 'Vampire Drain',
      value: kpis.vampire_drain?.pct_per_day !== undefined ? kpis.vampire_drain.pct_per_day.toFixed(2) + ' %/Tag' : '–',
      subtitle: `${kpis.vampire_drain?.intervals_count || 0} Intervalle | Sentry: ~${Math.round(kpis.vampire_drain?.watts_sentry_on || 0)}W an / ~${Math.round(kpis.vampire_drain?.watts_sentry_off || 0)}W aus`,
      color: 'warning'
    },
    {
      icon: '🔋',
      title: 'Batterie-Degradation',
      value: kpis.battery_degradation?.degradation_pct !== undefined ? kpis.battery_degradation.degradation_pct.toFixed(2) + ' %' : '–',
      subtitle: `${kpis.battery_degradation?.first_range_km || 0} km → ${kpis.battery_degradation?.last_range_km || 0} km (100% Reichweite) | ${kpis.battery_degradation?.data_points || 0} Datenpunkte`,
      color: 'danger'
    },
    {
      icon: '⚡',
      title: 'Ladeeffizienz',
      value: `AC ${kpis.charging_efficiency?.ac_avg_pct || 0}% | DC ${kpis.charging_efficiency?.dc_avg_pct || 0}%`,
      subtitle: `${kpis.charging_efficiency?.ac_sessions || 0} AC-Sessions | ${kpis.charging_efficiency?.dc_sessions || 0} DC-Sessions`,
      color: 'primary'
    },
    {
      icon: '🌡️',
      title: 'Temp.-Effizienz',
      value: kpis.temperature_efficiency?.diff_pct !== undefined ? (kpis.temperature_efficiency.diff_pct > 0 ? '+' : '') + kpis.temperature_efficiency.diff_pct.toFixed(1) + ' %' : '–',
      subtitle: `Winter ${kpis.temperature_efficiency?.winter_wh_km || 0} Wh/km | Sommer ${kpis.temperature_efficiency?.summer_wh_km || 0} Wh/km (${kpis.temperature_efficiency?.winter_drives || 0} / ${kpis.temperature_efficiency?.summer_drives || 0} Fahrten)`,
      color: 'info'
    }
  ];
  
  document.getElementById('nerdKpis').innerHTML = cards.map(c => `
    <div class="col-6 col-md-3">
      <div class="card kpi-card text-white bg-${c.color} h-100">
        <div class="card-body py-2">
          <div class="kpi-label opacity-75"><span class="kpi-icon">${c.icon}</span> ${c.title}</div>
          <div class="kpi-value">${c.value}</div>
          <div class="kpi-sub">${c.subtitle}</div>
        </div>
      </div>
    </div>`).join('');
}

function renderCharts(charts) {
  // Degradation Scatter Chart
  const degCtx = document.getElementById('degChart');
  if (degCtx && window.Chart) {
    const degData = charts.degradation || [];
    
    if (degradationChart) degradationChart.destroy();
    
    degradationChart = new Chart(degCtx, {
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
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Batterie-Degradation: Odometer vs. projizierte 100% Reichweite', font: { size: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => `Odo: ${ctx.parsed.x.toLocaleString('de-DE')} km | Range@100%: ${ctx.parsed.y.toFixed(1)} km`
            }
          }
        },
        scales: {
          x: { 
            title: { display: true, text: 'Kilometerstand (km)', font: { size: 10 } },
            ticks: { font: { size: 9 } }
          },
          y: { 
            title: { display: true, text: 'Reichweite @ 100% (km)', font: { size: 10 } },
            ticks: { font: { size: 9 } },
            suggestedMin: 200,
            suggestedMax: 500
          }
        }
      }
    });
  }
  
  // Temperature Efficiency Scatter Chart
  const tempCtx = document.getElementById('tempChart');
  if (tempCtx && window.Chart) {
    const tempData = charts.temp_efficiency || [];
    
    if (tempEfficiencyChart) tempEfficiencyChart.destroy();
    
    tempEfficiencyChart = new Chart(tempCtx, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Verbrauch (Wh/km)',
          data: tempData.map(d => ({x: d.temp, y: d.wh_km})),
          backgroundColor: 'rgba(250, 204, 21, 0.6)',
          borderColor: 'rgba(250, 204, 21, 1)',
          pointRadius: 4,
          pointHoverRadius: 6,
          showLine: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Effizienz vs. Temperatur: Verbrauch (Wh/km) pro Fahrt', font: { size: 12 } },
          tooltip: {
            callbacks: {
              label: ctx => `Temp: ${ctx.parsed.x.toFixed(1)}°C | Verbrauch: ${ctx.parsed.y.toFixed(1)} Wh/km`
            }
          }
        },
        scales: {
          x: { 
            title: { display: true, text: 'Außentemperatur (°C)', font: { size: 10 } },
            ticks: { font: { size: 9 } },
            suggestedMin: -10,
            suggestedMax: 40
          },
          y: { 
            title: { display: true, text: 'Verbrauch (Wh/km)', font: { size: 10 } },
            ticks: { font: { size: 9 } },
            suggestedMin: 100,
            suggestedMax: 350
          }
        }
      }
    });
  }
}

function renderVampireDrain(vampire) {
  const sessions = vampire.park_sessions || [];
  
  if (!sessions.length) {
    document.getElementById('vampireDrainTable').innerHTML = `
      <div class="text-center py-4 text-muted">
        <i class="bi bi-info-circle fs-1 mb-2"></i>
        <p>Keine Park-Sessions mit SoC-Verlust erkannt.</p>
        <small>Benötigt Fahrten mit SoC-Daten und Parkzeiten > 1h.</small>
      </div>`;
    return;
  }
  
  const html = `
    <div class="table-responsive">
      <table class="table table-sm table-striped align-middle mb-0">
        <thead class="sticky-header">
          <tr>
            <th>Datum / Zeit</th>
            <th>Dauer (h)</th>
            <th>SoC Verlust (%)</th>
            <th>Gesch. Verlust (kWh)</th>
            <th>Wächtermodus</th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map(s => `
            <tr>
              <td>${s.date}</td>
              <td>${s.duration_h.toFixed(1)}</td>
              <td>${s.soc_loss_pct.toFixed(2)}</td>
              <td>${s.est_loss_kwh.toFixed(2)}</td>
              <td><span class="badge bg-secondary">${s.sentry_mode}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  
  document.getElementById('vampireDrainTable').innerHTML = html;
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
      loadAnalytics();
    });
  });
  
  const btnRange = document.getElementById('btnRange');
  if (btnRange) {
    btnRange.addEventListener('click', () => {
      const from = document.getElementById('rangeFrom').value;
      const to = document.getElementById('rangeTo').value;
      if (from && to) {
        currentFrom = from;
        currentTo = to;
        document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
        loadAnalytics();
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
    loadAnalytics();
  });
  
  loadAnalytics();
});