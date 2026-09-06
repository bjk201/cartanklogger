import React, { useMemo } from 'react';
import { Zap, Wallet, TrendingUp, BatteryCharging, Euro, Sun, Activity, Car, BarChart3, Calendar } from 'lucide-react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  RadialLinearScale,
  Filler,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line, Bar, Pie } from 'react-chartjs-2';
import './TestPage.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  RadialLinearScale,
  Filler,
  Title,
  Tooltip,
  Legend
);

/* =========================================================
   Sample-Daten (Demo - keine echten DB-Werte)
   ========================================================= */
const sampleSeries = [
  { day: 'Mo', kwh: 12.4, cost: 1.85 },
  { day: 'Di', kwh: 18.7, cost: 2.92 },
  { day: 'Mi', kwh: 9.1, cost: 1.42 },
  { day: 'Do', kwh: 22.3, cost: 3.18 },
  { day: 'Fr', kwh: 16.8, cost: 2.51 },
  { day: 'Sa', kwh: 28.5, cost: 4.12 },
  { day: 'So', kwh: 11.2, cost: 1.69 },
];

const pieData = [
  { name: 'Zuhause', value: 217.8, fill: '#4f46e5' },
  { name: 'Extern', value: 0, fill: '#94a3b8' },
];

/* =========================================================
   Chart.js vorne konfiguriert für alle 3 Varianten
   ========================================================= */
function useChartTheme() {
  return useMemo(() => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    return { textColor, gridColor };
  }, []);
}

const baseChartOptions = (textColor: string, gridColor: string) => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: 'var(--color-bg-card)',
      titleColor: 'var(--color-text)',
      bodyColor: 'var(--color-text)',
      borderColor: 'var(--color-border)',
      borderWidth: 1,
    },
  },
  scales: {
    x: {
      ticks: { color: textColor, font: { size: 11 } },
      grid: { color: gridColor },
      border: { display: false },
    },
    y: {
      ticks: { color: textColor, font: { size: 11 } },
      grid: { color: gridColor },
      border: { display: false },
    },
  },
});

/* =========================================================
   VARIANTE A — Modern Minimal (Apple/Linear)
   ========================================================= */
function VariantAKpi({ label, value, unit, color, trend, sparkData }: any) {
  const sparkChartData = {
    labels: sparkData.labels,
    datasets: [
      {
        data: sparkData.values,
        borderColor: color,
        backgroundColor: `${color}20`,
        borderWidth: 1.5,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      },
    ],
  };
  const sparkOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { display: false }, y: { display: false } },
  };

  return (
    <div className="variant-a__kpi">
      <div className="variant-a__kpi-top">
        <span className="variant-a__kpi-label">{label}</span>
        {trend != null && (
          <span className={`variant-a__trend variant-a__trend--${trend >= 0 ? 'up' : 'down'}`}>
            {trend >= 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="variant-a__kpi-value-row">
        <span className="variant-a__kpi-value">{value}</span>
        {unit && <span className="variant-a__kpi-unit">{unit}</span>}
      </div>
      <div className="variant-a__kpi-sparkline">
        <Line data={sparkChartData} options={sparkOptions} />
      </div>
    </div>
  );
}

/* =========================================================
   VARIANTE B — Data-Dense Dashboard (Vercel/Stripe)
   ========================================================= */
function VariantBKpi({ label, value, unit, status_level, sparkData }: any) {
  const colorMap: Record<string, string> = {
    good: '#16a34a',
    neutral: '#4f46e5',
    warn: '#f59e0b',
  };
  const color = colorMap[status_level] || colorMap.neutral;
  const sparkChartData = {
    labels: sparkData.labels,
    datasets: [
      {
        data: sparkData.values,
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 0,
      },
    ],
  };
  const sparkOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { display: false }, y: { display: false } },
  };

  return (
    <div className={`variant-b__kpi variant-b__kpi--${status_level}`}>
      <div className="variant-b__kpi-left">
        <div className="variant-b__kpi-label">{label}</div>
        <div className="variant-b__kpi-value-row">
          <span className="variant-b__kpi-value">{value}</span>
          {unit && <span className="variant-b__kpi-unit">{unit}</span>}
        </div>
        <span className="variant-b__kpi-status" style={{ background: `${color}1F`, color }}>
          ● {status_level === 'good' ? 'Optimal' : status_level === 'warn' ? 'Beobachten' : 'Neutral'}
        </span>
      </div>
      <div className="variant-b__kpi-sparkline">
        <Line data={sparkChartData} options={sparkOptions} />
      </div>
    </div>
  );
}

/* =========================================================
   VARIANTE C — Modern Glass (Material3 / iOS)
   ========================================================= */
function VariantCKpi({ label, value, unit, icon: Icon, accent, sparkData }: any) {
  const sparkChartData = {
    labels: sparkData.labels,
    datasets: [
      {
        data: sparkData.values,
        borderColor: accent,
        backgroundColor: `${accent}30`,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      },
    ],
  };
  const sparkOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { display: false }, y: { display: false } },
  };

  return (
    <div className="variant-c__kpi" style={{ '--accent': accent } as React.CSSProperties}>
      <div className="variant-c__kpi-icon">
        <Icon size={22} />
      </div>
      <div className="variant-c__kpi-body">
        <span className="variant-c__kpi-label">{label}</span>
        <div className="variant-c__kpi-value-row">
          <span className="variant-c__kpi-value">{value}</span>
          {unit && <span className="variant-c__kpi-unit">{unit}</span>}
        </div>
      </div>
      <div className="variant-c__kpi-sparkline">
        <Line data={sparkChartData} options={sparkOptions} />
      </div>
    </div>
  );
}

/* =========================================================
   Chart-Helpers für die "richtigen" Charts
   ========================================================= */
function DemoBarChart({ theme }: { theme: any }) {
  const data = {
    labels: sampleSeries.map(d => d.day),
    datasets: [
      {
        label: 'kWh',
        data: sampleSeries.map(d => d.kwh),
        backgroundColor: '#4f46e5',
        borderRadius: 6,
      },
    ],
  };
  return (
    <Bar
      data={data}
      options={{
        ...baseChartOptions(theme.textColor, theme.gridColor),
        plugins: { ...baseChartOptions(theme.textColor, theme.gridColor).plugins, legend: { display: false } },
      }}
    />
  );
}

function DemoLineChart({ theme }: { theme: any }) {
  const data = {
    labels: sampleSeries.map(d => d.day),
    datasets: [
      {
        label: '€',
        data: sampleSeries.map(d => d.cost),
        borderColor: '#10b981',
        backgroundColor: '#10b98120',
        borderWidth: 2.5,
        fill: false,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#10b981',
      },
    ],
  };
  return (
    <Line
      data={data}
      options={{
        ...baseChartOptions(theme.textColor, theme.gridColor),
        plugins: { ...baseChartOptions(theme.textColor, theme.gridColor).plugins, legend: { display: false } },
      }}
    />
  );
}

function DemoPieChart({ theme }: { theme: any }) {
  const data = {
    labels: pieData.map(d => d.name),
    datasets: [
      {
        data: pieData.map(d => d.value),
        backgroundColor: pieData.map(d => d.fill),
        borderWidth: 0,
      },
    ],
  };
  return (
    <Pie
      data={data}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'var(--color-bg-card)',
            titleColor: 'var(--color-text)',
            bodyColor: 'var(--color-text)',
            borderColor: 'var(--color-border)',
            borderWidth: 1,
          },
        },
      }}
    />
  );
}

/* =========================================================
   Hauptseite
   ========================================================= */
export function TestPage() {
  const theme = useChartTheme();

  const sparkEnergy = {
    labels: sampleSeries.map(d => d.day),
    values: sampleSeries.map(d => d.kwh),
  };
  const sparkCost = {
    labels: sampleSeries.map(d => d.day),
    values: sampleSeries.map(d => d.cost),
  };

  return (
    <div className="page-container test-page">
      <header className="page__header test-page__header">
        <div>
          <h1 className="page__title">Design-Vergleich</h1>
          <p className="test-page__subtitle">
            3 Varianten für KPI-Kacheln + Charts. Alle nutzen denselben Datensatz
            (Demo-Werte, keine echten Daten). Wähle die Variante die dir am besten gefällt.
          </p>
        </div>
        <span className="test-page__badge">DEV</span>
      </header>

      {/* =====================================================
          VARIANTE A — Modern Minimal
          ===================================================== */}
      <section className="test-variant">
        <header className="test-variant__header">
          <div>
            <h2 className="test-variant__title">Variante A — Modern Minimal</h2>
            <p className="test-variant__desc">
              Apple/Linear-Stil. Großer Wert, kleines Label oben, dezenter Trend-Pfeil.
              Sehr leichte Schatten, viel Weißraum, ruhig & premium.
            </p>
          </div>
          <div className="test-variant__tags">
            <span className="tag tag--a">ruhig</span>
            <span className="tag tag--a">premium</span>
            <span className="tag tag--a">viel Weißraum</span>
          </div>
        </header>

        <div className="variant-a__grid">
          <VariantAKpi label="GELADENE KWH" value="217,8" unit="kWh" color="#4f46e5" trend={12.4} sparkData={sparkEnergy} />
          <VariantAKpi label="GESAMTKOSTEN" value="32,49" unit="€" color="#10b981" trend={-3.2} sparkData={sparkCost} />
          <VariantAKpi label="Ø KOSTEN / kWh" value="0,149" unit="€" color="#f59e0b" trend={null} sparkData={sparkCost} />
          <VariantAKpi label="AKTUELLER KM-STAND" value="3.713" unit="km" color="#7c3aed" trend={2.1} sparkData={sparkEnergy} />
        </div>

        <div className="variant-a__charts">
          <div className="variant-a__chart">
            <span className="variant-a__chart-label">Energie pro Session (kWh)</span>
            <div style={{ height: 140 }}>
              <DemoBarChart theme={theme} />
            </div>
          </div>
          <div className="variant-a__chart">
            <span className="variant-a__chart-label">Kosten pro Tag (€)</span>
            <div style={{ height: 140 }}>
              <DemoLineChart theme={theme} />
            </div>
          </div>
        </div>
      </section>

      {/* =====================================================
          VARIANTE B — Data-Dense Dashboard
          ===================================================== */}
      <section className="test-variant">
        <header className="test-variant__header">
          <div>
            <h2 className="test-variant__title">Variante B — Data-Dense Dashboard</h2>
            <p className="test-variant__desc">
              Vercel/Stripe-Stil. Sparkline links, Status-Farben (grün/orange/blau),
              zweispaltig. Mehr Daten sichtbar, professionell.
            </p>
          </div>
          <div className="test-variant__tags">
            <span className="tag tag--b">dicht</span>
            <span className="tag tag--b">Status-Farben</span>
            <span className="tag tag--b">Vergleich stark</span>
          </div>
        </header>

        <div className="variant-b__grid">
          <VariantBKpi label="GELADENE KWH" value="217,8" unit="kWh" status_level="good" sparkData={sparkEnergy} />
          <VariantBKpi label="GESAMTKOSTEN" value="32,49" unit="€" status_level="neutral" sparkData={sparkCost} />
          <VariantBKpi label="Ø KOSTEN / kWh" value="0,149" unit="€" status_level="warn" sparkData={sparkCost} />
          <VariantBKpi label="AKTUELLER KM-STAND" value="3.713" unit="km" status_level="good" sparkData={sparkEnergy} />
        </div>

        <div className="variant-b__charts">
          <div className="variant-b__chart">
            <span className="variant-b__chart-label">Energie pro Session (kWh)</span>
            <div style={{ height: 140 }}>
              <DemoBarChart theme={theme} />
            </div>
          </div>
          <div className="variant-b__chart">
            <span className="variant-b__chart-label">Kosten pro Tag (€)</span>
            <div style={{ height: 140 }}>
              <DemoLineChart theme={theme} />
            </div>
          </div>
        </div>
      </section>

      {/* =====================================================
          VARIANTE C — Modern Glass
          ===================================================== */}
      <section className="test-variant">
        <header className="test-variant__header">
          <div>
            <h2 className="test-variant__title">Variante C — Modern Glass</h2>
            <p className="test-variant__desc">
              Material3 / iOS-Stil. Großes farbiges Icon, jede Karte mit eigener
              Akzentfarbe, leichter Gradient im Dark Mode. Frisch & lebendig.
            </p>
          </div>
          <div className="test-variant__tags">
            <span className="tag tag--c">farbig</span>
            <span className="tag tag--c">lebendig</span>
            <span className="tag tag--c">modern</span>
          </div>
        </header>

        <div className="variant-c__grid">
          <VariantCKpi label="GELADENE KWH" value="217,8" unit="kWh" icon={Zap} accent="#f59e0b" sparkData={sparkEnergy} />
          <VariantCKpi label="GESAMTKOSTEN" value="32,49" unit="€" icon={Wallet} accent="#10b981" sparkData={sparkCost} />
          <VariantCKpi label="Ø KOSTEN / kWh" value="0,149" unit="€" icon={Euro} accent="#4f46e5" sparkData={sparkCost} />
          <VariantCKpi label="AKTUELLER KM-STAND" value="3.713" unit="km" icon={Car} accent="#7c3aed" sparkData={sparkEnergy} />
        </div>

        <div className="variant-c__charts">
          <div className="variant-c__chart">
            <span className="variant-c__chart-label">Energie pro Session (kWh)</span>
            <div style={{ height: 140 }}>
              <DemoBarChart theme={theme} />
            </div>
          </div>
          <div className="variant-c__chart">
            <span className="variant-c__chart-label">Kosten pro Tag (€)</span>
            <div style={{ height: 140 }}>
              <DemoLineChart theme={theme} />
            </div>
          </div>
        </div>
      </section>

      {/* =====================================================
          Side-by-side Charts (alle 3 auf einmal zum direkten Vergleich)
          ===================================================== */}
      <section className="test-variant">
        <header className="test-variant__header">
          <div>
            <h2 className="test-variant__title">Charts Side-by-Side</h2>
            <p className="test-variant__desc">
              Gleicher Datensatz, gleiches Layout — hier kannst du direkt vergleichen
              welche Chart-Optik dir gefällt.
            </p>
          </div>
        </header>

        <div className="test-charts-compare">
          <div className="test-charts-compare__col">
            <h3>Energie pro Session</h3>
            <div style={{ height: 180 }}>
              <DemoBarChart theme={theme} />
            </div>
          </div>
          <div className="test-charts-compare__col">
            <h3>Kosten pro Tag</h3>
            <div style={{ height: 180 }}>
              <DemoLineChart theme={theme} />
            </div>
          </div>
          <div className="test-charts-compare__col">
            <h3>Pie Chart (Home vs. Extern)</h3>
            <div style={{ height: 180 }}>
              <DemoPieChart theme={theme} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}