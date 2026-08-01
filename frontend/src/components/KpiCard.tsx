import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import './KpiCard.css';

interface KpiCardProps {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ComponentType<{ size?: number }>;
  iconColor?: string;
  trend?: {
    value: number;
    label: string;
  };
  subtitle?: string;
}

export function KpiCard({ label, value, unit, icon: Icon, iconColor = 'var(--color-primary)', trend, subtitle }: KpiCardProps) {
  const iconStyle = { '--icon-color': iconColor } as React.CSSProperties;
  const trendColor = trend?.value ?? 0 >= 0 ? 'var(--color-home)' : '#ef4444';
  const trendStyle = { '--trend-color': trendColor } as React.CSSProperties;

  return (
    <article className="kpi-card">
      <div className="kpi-card__header">
        <div className="kpi-card__icon" style={iconStyle}>
          <Icon size={24} aria-hidden="true" />
        </div>
        {trend && (
          <div className="kpi-card__trend" style={trendStyle}>
            <span className="kpi-card__trend-icon" aria-hidden="true">
              {trend.value >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            </span>
            <span className="kpi-card__trend-value">{trend.value >= 0 ? '+' : ''}{trend.value.toFixed(1)}%</span>
            <span className="kpi-card__trend-label">{trend.label}</span>
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
    </article>
  );
}