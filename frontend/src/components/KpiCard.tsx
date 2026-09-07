import React, { useState } from 'react';
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
    /** Farblogik: 'good' = Wert stieg (gut für kWh, Kosten runter = gut);
     *            Wenn undefined, wird der trend.value automatisch interpretiert */
    direction?: 'up-good' | 'down-good' | 'neutral';
  };
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

/**
 * Berechnet die Farbe für einen Trend:
 * - direction='up-good' → +% = grün, -% = rot
 * - direction='down-good' → -% = grün, +% = rot (z.B. Kosten)
 * - direction='neutral' → nur grau
 * - direction undefined → automatisch: +% = grün (Standard)
 */
function getTrendColors(direction: 'up-good' | 'down-good' | 'neutral' | undefined, value: number) {
  let isGood: boolean;
  if (direction === 'down-good') {
    isGood = value < 0;
  } else if (direction === 'neutral') {
    isGood = true; // keine Färbung
  } else {
    // up-good (default)
    isGood = value >= 0;
  }
  if (direction === 'neutral') {
    return { color: 'var(--color-text-muted)', bg: 'var(--color-bg-hover, rgba(127,127,127,0.12))' };
  }
  return isGood
    ? { color: '#16a34a', bg: 'rgba(34, 197, 94, 0.12)' }
    : { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' };
}

export function KpiCard({
  label,
  value,
  unit,
  icon: Icon,
  iconColor = 'var(--color-primary)',
  trend,
  subtitle,
  horizontal = false,
  sparkData,
  details,
  status = 'neutral',
}: KpiCardProps) {
  const [hovering, setHovering] = useState(false);
  const iconStyle = { '--icon-color': iconColor } as React.CSSProperties;
  const trendColors = trend ? getTrendColors(trend.direction, trend.value) : null;

  const sparkChartData = sparkData ? {
    labels: sparkData.labels,
    datasets: [
      // Hauptlinie (Werte)
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
      ...(sparkData.movingAverage ? [{
        data: sparkData.movingAverage,
        borderColor: 'rgba(127, 127, 127, 0.85)',
        borderWidth: 1.5,
        borderDash: [4, 3],
        fill: false,
        tension: 0.4,
        pointRadius: 0,
        order: 1,
      }] : []),
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

  /* === Horizontal-Layout (kompakt) === */
  if (horizontal) {
    return (
      <article
        className={`kpi-card kpi-card--horizontal kpi-card--status-${status}${hasDetails ? ' kpi-card--has-details' : ''}`}
        onMouseEnter={() => hasDetails && setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="kpi-card__icon kpi-card__icon--sm" style={iconStyle}>
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
        {hasSpark && (
          <div className="kpi-card__spark kpi-card__spark--horizontal">
            <Line data={sparkChartData!} options={sparkOptions} />
          </div>
        )}
        {trend && trendColors && (
          <div className="kpi-card__trend" style={{ color: trendColors.color, background: trendColors.bg }}>
            <span className="kpi-card__trend-icon" aria-hidden="true">
              {trend.value === 0 ? <Minus size={12} /> : trend.value > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            </span>
            <span className="kpi-card__trend-value">
              {trend.value > 0 ? '+' : ''}{trend.value.toFixed(1)}%
            </span>
          </div>
        )}
        {hasDetails && (
          <div className={`kpi-card__details-popup${hovering ? ' kpi-card__details-popup--visible' : ''}`}>
            <div className="kpi-card__details-header">
              <Info size={12} />
              <span>{label}</span>
            </div>
            <ul className="kpi-card__details-list">
              {details!.map((d, i) => (
                <li key={i} className={d.emphasis ? 'kpi-card__details-item--emphasis' : ''}>
                  <span className="kpi-card__details-label">{d.label}</span>
                  <span className="kpi-card__details-value">{d.value}</span>
                </li>
              ))}
            </ul>
            {sparkData?.movingAverage && (
              <div className="kpi-card__details-footer">
                <span className="kpi-card__details-legend">
                  <span className="kpi-card__legend-line kpi-card__legend-line--solid"></span>
                  Wert
                </span>
                <span className="kpi-card__details-legend">
                  <span className="kpi-card__legend-line kpi-card__legend-line--dashed"></span>
                  7-Tage-MA
                </span>
              </div>
            )}
          </div>
        )}
      </article>
    );
  }

  /* === Standard-Layout === */
  return (
    <article
      className={`kpi-card kpi-card--status-${status}${hasDetails ? ' kpi-card--has-details' : ''}`}
      onMouseEnter={() => hasDetails && setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="kpi-card__header">
        <div className="kpi-card__icon" style={iconStyle}>
          <Icon size={24} aria-hidden="true" />
        </div>
        {trend && trendColors && (
          <div className="kpi-card__trend" style={{ color: trendColors.color, background: trendColors.bg }}>
            <span className="kpi-card__trend-icon" aria-hidden="true">
              {trend.value === 0 ? <Minus size={12} /> : trend.value > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            </span>
            <span className="kpi-card__trend-value">
              {trend.value > 0 ? '+' : ''}{trend.value.toFixed(1)}%
            </span>
          </div>
        )}
      </div>
      <div className="kpi-card__body">
        <p className="kpi-card__label">{label}</p>
        <div className="kpi-card__value-row">
          <span className="kpi-card__value">{value}</span>
          {unit && <span className="kpi-card__unit">{unit}</span>}
        </div>
        {subtitle && <p className="kpi-card__subtitle">{subtitle}</p>}
      </div>
      {hasSpark && (
        <div className="kpi-card__spark">
          <Line data={sparkChartData!} options={sparkOptions} />
        </div>
      )}
      {hasDetails && (
        <div className={`kpi-card__details-popup${hovering ? ' kpi-card__details-popup--visible' : ''}`}>
          <div className="kpi-card__details-header">
            <Info size={12} />
            <span>{label}</span>
          </div>
          <ul className="kpi-card__details-list">
            {details!.map((d, i) => (
              <li key={i} className={d.emphasis ? 'kpi-card__details-item--emphasis' : ''}>
                <span className="kpi-card__details-label">{d.label}</span>
                <span className="kpi-card__details-value">{d.value}</span>
              </li>
            ))}
          </ul>
          {sparkData?.movingAverage && (
            <div className="kpi-card__details-footer">
              <span className="kpi-card__details-legend">
                <span className="kpi-card__legend-line kpi-card__legend-line--solid"></span>
                Wert
              </span>
              <span className="kpi-card__details-legend">
                <span className="kpi-card__legend-line kpi-card__legend-line--dashed"></span>
                7-Tage-MA
              </span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}