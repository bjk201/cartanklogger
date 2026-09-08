/**
 * Helper-Funktionen für chart.js Trend-Charts.
 *
 *  - movingAverage(values, window)  → gleitender Durchschnitt
 *  - buildTrendDatasets(primary, ma) → fertige datasets[] für chart.js mit
 *    Hauptlinie/Säule + gestrichelter MA-Linie
 *  - applyTrendOptions(opts) → Standardoptionen mit MA-Legende, Tooltip, Achsen
 */

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Filler,
  Tooltip,
  Legend
);

/**
 * Gleitender Durchschnitt. Für die ersten window-1 Werte wird 'null' zurückgegeben
 * (chart.js überspringt diese Punkte).
 */
export function movingAverage(values: number[], windowSize: number): (number | null)[] {
  const w = Math.min(windowSize, Math.max(2, Math.floor(values.length / 2) || 2));
  return values.map((_, i) => {
    const start = Math.max(0, i - w + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= i; j++) {
      const v = values[j];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  });
}

/**
 * Erstellt dataset[] für ein Trend-Chart mit Hauptlinie + gestrichelter MA-Linie.
 *
 * - primary: Haupt-Balken/Linie (Werte)
 * - ma: gleitender Durchschnitt (kann null-Werte enthalten)
 * - color: Hauptfarbe (z.B. '#4f46e5')
 * - kind: 'line' oder 'bar'
 */
export function buildTrendDatasets(
  labels: string[],
  primary: number[],
  color: string,
  kind: 'line' | 'bar' = 'line',
  ma?: (number | null)[]
) {
  const mainDataset = kind === 'bar'
    ? {
        type: 'bar' as const,
        label: 'Wert',
        data: primary,
        backgroundColor: color,
        borderRadius: 4,
        order: 2,
      }
    : {
        type: 'line' as const,
        label: 'Wert',
        data: primary,
        borderColor: color,
        backgroundColor: color + '20',
        borderWidth: 2,
        fill: false,
        tension: 0.4,
        pointRadius: 2,
        pointBackgroundColor: color,
        order: 2,
      };

  const datasets: any[] = [mainDataset];

  if (ma && ma.some(v => v != null)) {
    datasets.push({
      type: 'line' as const,
      label: '7-Tage-MA',
      data: ma,
      borderColor: 'rgba(127, 127, 127, 0.85)',
      borderWidth: 1.5,
      borderDash: [5, 3],
      fill: false,
      tension: 0.4,
      pointRadius: 0,
      order: 1,
    });
  }

  return { labels, datasets };
}

/**
 * Standard-Chart-Optionen für Trend-Charts mit MA-Legende, Hover-Tooltip, Theme-aware Achsen.
 *
 * - unit: 'kWh' / '€' / 'km' — wird im Tooltip angezeigt
 * - textColor, gridColor: vom useChartTheme()-Hook (siehe TestPage-Beispiel)
 */
export function trendChartOptions(
  unit: string,
  textColor: string,
  gridColor: string
): any {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: {
          color: textColor,
          font: { size: 11 },
          boxWidth: 16,
          boxHeight: 2,
          padding: 12,
          usePointStyle: false,
        },
      },
      tooltip: {
        backgroundColor: 'var(--color-bg-card)',
        titleColor: 'var(--color-text)',
        bodyColor: 'var(--color-text)',
        borderColor: 'var(--color-border)',
        borderWidth: 1,
        padding: 8,
        callbacks: {
          label: function (ctx: any) {
            const v = ctx.parsed.y;
            if (v == null || !Number.isFinite(v)) return `${ctx.dataset.label}: —`;
            return `${ctx.dataset.label}: ${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${unit}`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: { color: textColor, font: { size: 11 } },
        grid: { color: gridColor, display: false },
        border: { display: false },
      },
      y: {
        ticks: {
          color: textColor,
          font: { size: 11 },
          callback: function (v: any) {
            return v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
          },
        },
        grid: { color: gridColor },
        border: { display: false },
      },
    },
  };
}

/**
 * Hook: liest aktuelle Theme-Farben aus dem DOM. In einer Komponente:
 *
 *   const theme = useChartTheme();
 *   <Line options={trendChartOptions('kWh', theme.textColor, theme.gridColor)} />
 */
export function useChartTheme() {
  if (typeof document === 'undefined') {
    return { textColor: '#64748b', gridColor: 'rgba(0,0,0,0.06)' };
  }
  const isDark = document.documentElement.dataset.theme === 'dark';
  return {
    textColor: isDark ? '#94a3b8' : '#64748b',
    gridColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
  };
}