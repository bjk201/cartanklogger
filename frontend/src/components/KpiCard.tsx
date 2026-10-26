import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, Info, Minus } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import './KpiCard.css';

interface KpiCardProps {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ComponentType<{ size?: number }>;
  iconColor?: string;
  /** Optionale Trend-Information aus dem Vergleich zum vorherigen Zeitraum */
  trend?: {
    value: number;       // % Änderung (positiv = gut, negativ = schlecht)
    label: string;       // z.B. "vs. letzte 30 Tage"
    /** Farblogik: 'good' = Wert stieg (gut für kWh, Kosten runter = gut);**
     *            Wenn undefined, wird der trend.value automatisch interpretiert */
    direction?: 'up-good' | 'down-good' | 'neutral';
  }[];
  subtitle?: string;
  horizontal?: boolean;
  /** Sparkline-Daten + optional gleitender Durchschnitt (7 Tage) */
  sparkData?: {
    labels: string[];
    values: number[];
    /** Wenn gesetzt, wird eine zweite Linie als MA gezeichnet */
    movingAverage?: (number | null)[];
  };
  /** Detail-Liste für Mouseover-Effekt (Hover-Popup) */
  details?: Array<{ label: string; value: string | number; emphasis?: boolean }>;
  /** Status für linke 3px-Stripe (default: 'neutral') */
  status?: 'good' | 'neutral' | 'warn';
}

/** Erkennt das Design-Modus aus dem HTML-Attribut */
function useDesignMode(): 'legacy' | 'new' {
  const html = document.documentElement;
  const mode = html.getAttribute('data-design-mode');
  if (mode === 'new' || mode === 'legacy') {
    return mode;
  }
  return 'legacy'; // Fallback
}

/** Berechnet die Klasse für den Vergleichs-Badge */
function getTrendBadgeClass(direction: 'up-good' | 'down-good' | 'neutral' | undefined, value: number): string {
  if (direction === 'neutral') {
    return 'kpi-card__trend--neutral';
  }
  // Einfache Logik: positiv = up, negativ = down
  return value >= 0 ? 'kpi-card__trend--up' : 'kpi-card__trend--down';
}

/** Erstellt die Klasse für den Icon-Kreis */
function getIconCircleClass(designMode: 'legacy' | 'new'): string {
  if (designMode === 'new') {
    return 'kpi-card__icon kpi-card__icon--new';
  }
  return 'kpi-card__icon';
}

/** Erstellt die Klasse für den Status-Punkt (NEW mode) */
function getStatusCircleClass(designMode: 'legacy' | 'new', status: 'good' | 'neutral' | 'warn'): string {
  if (designMode !== 'new') {
    // Legacy: linke 3px-Stripe wird via CSS-Class .kpi-card--status-* behandelt
    return '';
  }
  // NEW mode: return status circle classes
  if (status === 'good') return 'kpi-card--status-good';
  if (status === 'neutral') return 'kpi-card--status-neutral';
  return 'kpi-card--status-warn';
}

export function KpiCard({
  label,
  value,
  unit,
  icon: Icon,
  iconColor,
  trend,
  subtitle,
  horizontal = false,
  sparkData,
  details,
  status = 'neutral',
}: any) {
  // Design-Modus erkennen
  const designMode = useDesignMode();

  // Klassennamen basieren auf Design-Modus
  const iconCircleClass = getIconCircleClass(designMode);
  const statusCircleClass = getStatusCircleClass(designMode, status);

  // Sparkline-Daten verarbeiten
  const sparkChartData = sparkData ? {
    labels: sparkData.labels,
    datasets: [
      {
        data: sparkData.values,
        borderColor: iconColor,
        backgroundColor: `${iconColor}1A`,
        borderWidth: 1.5,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        order: 2,
      },
      // Gleitender Durchschnitt (nur wenn vorhanden)
      ...(sparkData.movingAverage ? [
        {
          data: sparkData.movingAverage,
          borderColor: 'rgba(127, 127, 127, 0.85)',
          borderWidth: 1.5,
          borderDash: [4, 3],
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          order: 1,
        }
      ] : []),
    ],
  } : null;

  const sparkOptions: any = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: { display: false },
    },
    interaction: { mode: 'index', intersect: false },
    animation: false,
  };

  const hasSpark = !!sparkChartData;
  const hasDetails = !!details && details.length > 0;

  /* === useState fürHover-Zustand === */
  const [hovering, setHovering] = useState(false);

  /* === Modus-spezifische Klassen zum HTML-Element hinzufügen === */
  React.useEffect(() => {
    const html = document.documentElement;
    if (!html.getAttribute('data-design-mode')) {
      html.setAttribute('data-design-mode', 'legacy');
    }
  }, [designMode]);

  /* === Layout: Horizontal oder Vertical === */
  if (horizontal) {
    return (
      <article
        className="kpi-card kpi-card--status-neutral"
        onMouseEnter={() => setHovering?.(true)}
        onMouseLeave={() => setHovering?.(false)}
      >
        <div className="kpi-card__icon kpi-card__icon--sm">
          <Icon size={18} aria-hidden="true" />
        </div>
        <div className="kpi-card__body kpi-card__body--compact">
          <span className="kpi-card__label">{label}</span>
          <div className="kpi-card__value-row">
            <span className="kpi-card__value">{value}</span>
            {unit && <span className="kpi-card__unit">{unit}</span>}
          </div>
          {subtitle && <span className="kpi-card__subtitle">{subtitle}</span>}
        </div>
      </article>
    );
  }

  /* === Standard-Layout (Vertical) === */
  return (
    <article
      className="kpi-card kpi-card--status-neutral"
      onMouseEnter={() => setHovering?.(true)}
      onMouseLeave={() => setHovering?.(false)}
    >
      <div className="kpi-card__header">
        <div className="kpi-card__header">
          <Icon size={24} aria-hidden="true" />
        </div>
      </div>
      <div className="kpi-card__body">
        <p className="kpi-card__label">{label}</p>
        <div className="kpi-card__value-row">
          <span className="kpi-card__value">{value}</span>
          {unit && <span className="kpi-card__unit">{unit}</span>}
        </div>
        {subtitle && <p className="kpi-card__subtitle">{subtitle}</p>}
      </div>
    </article>
  );
}
