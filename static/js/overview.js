// CarTankLogger Overview JavaScript - Chart Configuration
const PER_PAGE = 10;

let chartType = 'line';
let averageMode = 'mean';

function initOverview() {
  loadOverview();
  document.getElementById('globalDateRangeApply').addEventListener('click', loadOverview);
}

function loadOverview() {
  fetch(`/api/merged?${getGlobalRangeParams()}&page=${currentPageMerged}&per_page=${PER_PAGE}`)
    .then(response => response.json())
    .then(data => {
      console.log('Overview data received:', data);
      currentPageMerged = data.page || 1;
      totalPagesMerged = data.pages || 1;
      renderTable(data.data || []);
      renderPaginationMerged(data.page, data.pages);
      renderCharts(data.charts || {});
    })
    .catch(error => console.error('Load overview error:', error));
}

function renderCharts(chartsData) {
  if (!chartsData || typeof chartsData !== 'object') {
    console.error('Invalid charts data:', chartsData);
    return;
  }

  // Ensure chronological sorting (oldest → newest)
  const chronologicalSeries = [...(chartsData.consumption || [])].sort((a, b) => {
    const aDate = new Date(a.day || a.date || a.created_at || 0);
    const bDate = new Date(b.day || b.date || b.created_at || 0);
    return aDate - bDate;
  });

  // Consumption chart
  if (chronologicalSeries.length) {
    const ctx = document.getElementById('chartConsumption');
    if (ctx && !Chart.getChart(ctx)) {
      Chart.defaults.font.size = 11;
      Chart.defaults.font.family = 'system-ui, -apple-system, sans-serif';
      Chart.defaults.plugins.tooltip.bodyFont.size = 12;
      Chart.defaults.plugins.legend.display = false;

      new Chart(ctx, {
        type: 'line',
        data: {
          labels: chronologicalSeries.map(d => {
            const date = new Date(d.day || d.date || d.created_at || 0);
            return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
          }),
          datasets: [{
            label: 'Tageswert',
            data: chronologicalSeries.map(d => {
              const value = d.consumption_kwh_100km || d.kwh || d.consumption || d.value;
              return parseFloat(value) || 0;
            }),
            borderColor: '#18bfd8',
            backgroundColor: 'rgba(24, 191, 216, 0.05)',
            borderWidth: 2,
            tension: 0.28,
            spanGaps: true,
            pointRadius: 2.5,
            pointHoverRadius: 4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              ticks: { maxRotation: 0, autoSkip: true, font: { size: 10 } },
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
      });
    }
  }

  // Cost chart
  if (chartsData.fuelCosts && chartsData.fuelCosts.length) {
    const ctx = document.getElementById('chartCost');
    if (ctx && !Chart.getChart(ctx)) {
      new Chart(ctx, {
        type: 'line',
        data: {
          labels: chartsData.fuelCosts.map(d => d.day || d.date || d.label || ''),
          datasets: [{
            label: 'Kosten',
            data: chartsData.fuelCosts.map(d => parseFloat(d.eur_100km) || 0),
            borderColor: '#f5aa12',
            backgroundColor: 'rgba(245, 170, 18, 0.05)',
            borderWidth: 2,
            tension: 0.28,
            spanGaps: true,
            pointRadius: 2.5,
            pointHoverRadius: 4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { ticks: { font: { size: 10 } } },
            y: { ticks: { font: { size: 10 } } }
          },
          plugins: { legend: { display: false } }
        }
      });
    }
  }

  // Distance chart
  if (chartsData.trips && chartsData.trips.length) {
    const ctx = document.getElementById('chartKm');
    if (ctx && !Chart.getChart(ctx)) {
      new Chart(ctx, {
        type: 'line',
        data: {
          labels: chartsData.trips.map(d => d.day || d.date || d.label || ''),
          datasets: [{
            label: 'km',
            data: chartsData.trips.map(d => parseFloat(d.distance || d.km || d.total_km) || 0),
            borderColor: '#1677ff',
            backgroundColor: 'rgba(22, 119, 255, 0.05)',
            borderWidth: 2,
            tension: 0.28,
            spanGaps: true,
            pointRadius: 2.5,
            pointHoverRadius: 4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { ticks: { font: { size: 10 } } },
            y: { ticks: { font: { size: 10 } } }
          },
          plugins: { legend: { display: false } }
        }
      });
    }
  }

  // Home vs. Extern Donut
  if (chartsData.homeVsExternal && chartsData.homeVsExternal.home_kwh != null) {
    const homeKwh = parseFloat(chartsData.homeVsExternal.home_kwh) || 0;
    const extKwh = parseFloat(chartsData.homeVsExternal.ext_kwh) || 0;
    const total = homeKwh + extKwh;
    const homePercent = total ? (homeKwh / total) * 100 : 0;
    const extPercent = total ? (extKwh / total) * 100 : 0;

    if (document.getElementById('chartHomeExtern')) {
      new Chart(document.getElementById('chartHomeExtern'), {
        type: 'doughnut',
        data: {
          labels: ['Zuhause', 'Extern'],
          datasets: [{
            data: [homeKwh, extKwh],
            backgroundColor: ['#18bfd8', '#1677ff'],
            borderColor: ['#0d1c2b', '#0d1c2b'],
            borderWidth: 3,
            hoverOffset: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  const label = ctx.label || '';
                  const value = ctx.raw || 0;
                  return `${label}: ${value.toLocaleString('de-DE')} kWh`;
                }
              }
            }
          },
          animation: { animateRotate: true, animateScale: false }
        }
      });
    }

    document.getElementById('homeKwh').textContent = homeKwh.toLocaleString('de-DE');
    document.getElementById('homePct').textContent = homePercent.toFixed(1) + '%';
    document.getElementById('extKwh').textContent = extKwh.toLocaleString('de-DE');
    document.getElementById('extPct').textContent = extPercent.toFixed(1) + '%';
  }

  // Heatmap (Weekday consumption categories)
  if (chartsData.consumptionByWeekday && Object.keys(chartsData.consumptionByWeekday).length) {
    const heatmapData = chartsData.consumptionByWeekday;
    const container = document.getElementById('weekdayHeatmap');
    const legend = document.getElementById('legendWeekdayConsumption');

    if (container) {
      container.innerHTML = '';

      // Build the grid structure
      const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      const categories = [
        { label: '<14', class: 'heatmap-cell--lt14', color: '#137d7c' },
        { label: '14-16', class: 'heatmap-cell--14-16', color: '#32a96c' },
        { label: '16-18', class: 'heatmap-cell--16-18', color: '#b9b845' },
        { label: '18-20', class: 'heatmap-cell--18-20', color: '#e78b43' },
        { label: '>20', class: 'heatmap-cell--gt20', color: '#d95656' }
      ];

      // Create day labels column
      const dayLabels = document.createElement('div');
      dayLabels.className = 'heatmap-grid__label';
      days.forEach(day => {
        const el = document.createElement('div');
        el.textContent = day;
        dayLabels.appendChild(el);
      });
      container.appendChild(dayLabels);

      // Create heatmap cells
      days.forEach((day, rowIndex) => {
        categories.forEach((cat, colIndex) => {
          const value = heatmapData[rowIndex]?.[colIndex] || 0;
          const cell = document.createElement('div');
          cell.className = `heatmap-cell ${cat.class}`;
          cell.title = `${day} ${cat.label}: ${value} Fahrten`;
          cell.style.backgroundColor = value ? cat.color : 'rgba(0, 0, 0, 0.04)';
          container.appendChild(cell);
        });
      });

      // Render legend
      if (legend) {
        legend.innerHTML = '';
        categories.forEach(cat => {
          const item = document.createElement('div');
          item.className = 'heatmap-legend__item';
          item.innerHTML = `<div class="heatmap-legend__swatch" style="background:${cat.color}"></div><span>${cat.label}</span>`;
          legend.appendChild(item);
        });
      }
    }
  }

  // Trip comparison table (simplified example)
  if (chartsData.trips && chartsData.trips.length) {
    const tripContainer = document.getElementById('tripComparison') || document.createElement('div');
    if (tripContainer.id === 'tripComparison' && !tripContainer.innerHTML) {
      const table = document.createElement('table');
      table.className = 'table table-sm table-striped';

      const thead = document.createElement('thead');
      thead.innerHTML = `<tr><th>Datum</th><th>km</th><th>kWh</th><th>Verbrauch</th></tr>`;
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      chartsData.trips.forEach(trip => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${trip.day || trip.date || ''}</td>
          <td>${trip.distance || trip.km || 0}</td>
          <td>${trip.kwh || trip.energy || 0}</td>
          <td>${trip.consumption || 0} kWh/100km</td>
        `;
        tbody.appendChild(row);
      });
      table.appendChild(tbody);

      if (!tripContainer.id) {
        tripContainer.id = 'tripComparison';
        tripContainer.appendChild(table);
      }
    }
  }
}

// Helper function for global date range parameters
function getGlobalRangeParams() {
  return window.globalDateRange ? getGlobalRangeParamsHelper(window.globalDateRange) : '';
}

function getGlobalRangeParamsHelper(range) {
  if (range.from && range.to) {
    return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  }
  return `days=${range.days}`;
}

// Simple table rendering function
function renderTable(data) {
  const tableBody = document.querySelector('#tblMerged tbody');
  if (!tableBody) return;

  tableBody.innerHTML = '';
  data.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.datum || row.day || row.date || ''}</td>
      <td>${row.stationen || row.stations || row.station || ''}</td>
      <td>${row.home_kwh || row.home_kwh || row.home || ''}</td>
      <td>${row.home_eur || row.home_eur || row.home_cost || ''}</td>
      <td>${row.pv_prozent || row.pv_percent || row.pv_pct || ''}</td>
      <td>${row.ladeverlust || row.charge_loss || ''}</td>
      <td>${row.extern_kwh || row.extern || row.external_kwh || ''}</td>
      <td>${row.extern_eur || row.extern_eur || row.external_cost || ''}</td>
      <td>${row.gesamt_kwh || row.gesamt || row.total_kwh || ''}</td>
      <td>${row.gesamt_eur || row.gesamt || row.total_cost || ''}</td>
      <td><button class="btn btn-sm btn-outline-primary">Details</button></td>
    `;
    tableBody.appendChild(tr);
  });
}

// Simplified pagination rendering
function renderPaginationMerged(current, total) {
  const pagination = document.getElementById('paginationMerged');
  if (!pagination) return;

  pagination.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'pagination pagination-sm justify-content-center';

  // Previous button
  if (current > 1) {
    const li = document.createElement('li');
    li.className = 'page-item';
    li.innerHTML = `<a class="page-link" href="#" onclick="setPageMerged(${current - 1}); return false;">«</a>`;
    ul.appendChild(li);
  }

  // Page numbers
  for (let i = Math.max(1, current - 2); i <= Math.min(total, current + 2); i++) {
    const li = document.createElement('li');
    li.className = `page-item ${i === current ? 'active' : ''}`;
    li.innerHTML = `<a class="page-link" href="#" onclick="setPageMerged(${i}); return false;">${i}</a>`;
    ul.appendChild(li);
  }

  // Next button
  if (current < total) {
    const li = document.createElement('li');
    li.className = 'page-item';
    li.innerHTML = `<a class="page-link" href="#" onclick="setPageMerged(${current + 1}); return false;">»</a>`;
    ul.appendChild(li);
  }

  pagination.appendChild(ul);
}

// Global page state
let currentPageMerged = 1;
let totalPagesMerged = 1;

function setPageMerged(page) {
  currentPageMerged = page;
  if (currentPageMerged > totalPagesMerged) currentPageMerged = totalPagesMerged;
  if (currentPageMerged < 1) currentPageMerged = 1;
  loadOverview();
}

// Expose functions globally for inline onclick
window.setPageMerged = setPageMerged;

// Export functions for external use
window.loadOverview = loadOverview;
window.initOverview = initOverview;