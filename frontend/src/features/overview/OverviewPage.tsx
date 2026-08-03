import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { KpiCard } from '../../components/KpiCard';
import { SessionsTable } from '../../components/SessionsTable';
import { SessionMobileCard } from '../../components/SessionMobileCard';
import { LoadingState, ErrorState, EmptyState, PartialError } from '../../components/StateViews';
import { api, type Session, type OverviewResponse, type OverviewSummaryResponse, type DataSourceStatusResponse } from '../../lib/apiClient';
import './OverviewPage.css';

export function OverviewPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<OverviewSummaryResponse | null>(null);
  const [dataSourceStatus, setDataSourceStatus] = useState<DataSourceStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [recentResponse, summaryResponse, statusResponse] = await Promise.all([
        api.getRecentSessions(10),
        api.getOverviewSummary(),
        api.getDataSourceStatus(),
      ]);

      if (!recentResponse.ok || !summaryResponse.ok || !statusResponse.ok) {
        throw new Error('API returned error status');
      }

      setSessions(recentResponse.data);
      setSummary(summaryResponse);
      setDataSourceStatus(statusResponse);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden der Overview: ${message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRetry = () => {
    fetchData();
  };

  // Helper functions for data source status display
  const getStatusClass = (status: { configured: boolean; reachable: boolean } | undefined): string => {
    if (!status) return 'import-status__value';
    if (!status.configured) return 'import-status__value import-status__value--warn';
    if (status.reachable) return 'import-status__value import-status__value--ok';
    return 'import-status__value import-status__value--error';
  };

  const formatSourceStatus = (status: { configured: boolean; reachable: boolean; error?: string } | undefined, sourceName: string): string => {
    if (!status) return `${sourceName}: Unbekannt`;
    if (!status.configured) return `${sourceName}: Nicht konfiguriert`;
    if (status.reachable) return `${sourceName}: Erreichbar`;
    return `${sourceName}: Nicht erreichbar${status.error ? ` (${status.error})` : ''}`;
  };

  const formatNumber = (num: number): string => {
    return num.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  };

  const formatCostPerKWh = (num: number | null): string => {
    if (num === null || num === undefined) return '—';
    return num.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' €/kWh';
  };

  if (loading) {
    return (
      <div className="page-container">
        <LoadingState message="Overview wird geladen…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <ErrorState message={error} onRetry={handleRetry} />
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="overview-page__header">
        <h1 className="overview-page__title">Overview</h1>
        <p className="overview-page__subtitle">
          Produktiver Einstieg · <span className="overview-page__status">Aktuell</span>
        </p>
      </div>

      {/* KPI Cards - Real Data from Summary API */}\n      {summary && (
        <section className="overview-page__section" aria-labelledby="kpi-heading">
          <h2 id="kpi-heading" className="overview-page__section-title">Kennzahlen (gesamt)</h2>
          <div className="overview-page__kpi-grid">
            <KpiCard
              label="Gesamt Sessions"
              value={summary.total_sessions}
              icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>}
              subtitle="Alle Ladevorgänge"
            />
            <KpiCard
              label="Gesamt Energie"
              value={formatNumber(summary.total_energy_kwh)}
              unit="kWh"
              iconColor="var(--color-home)"
              icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>}
              subtitle="Gesamt geladen"
            />
            <KpiCard
              label="Gesamtkosten"
              value={summary.total_cost_eur.toFixed(2)}
              unit="€"
              iconColor="#f59e0b"
              icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>}
              subtitle="Gesamtkosten"
            />
            <KpiCard
              label="Ø Kosten/kWh"
              value={formatCostPerKWh(summary.avg_cost_per_kwh)}
              iconColor="var(--color-primary)"
              icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>}
              subtitle="Durchschnittspreis"
            />
            <KpiCard
              label="Home Energie"
              value={formatNumber(summary.home_energy_kwh)}
              unit="kWh"
              iconColor="var(--color-home)"
              icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>}
              subtitle="Zuhause geladen"
            />
            <KpiCard
              label="External Energie"
              value={formatNumber(summary.external_energy_kwh)}
              unit="kWh"
              iconColor="var(--color-external)"
              icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>}
              subtitle="Extern geladen"
            />
          </div>
        </section>
      )}

      {/* Sessions List */}
      <section className="overview-page__section" aria-labelledby="sessions-heading">
        <div className="overview-page__section-header">
          <h2 id="sessions-heading" className="overview-page__section-title">Letzte 10 Sessions</h2>
          <button
            className="overview-page__view-all"
            onClick={() => navigate('/sessions')}
          >
            Alle anzeigen →
          </button>
        </div>

        {sessions.length === 0 ? (
          <EmptyState
            title="Keine Sessions"
            message="Es wurden noch keine Ladevorgänge importiert."
            action={{
              label: 'Import starten',
              onClick: () => navigate('/import-review'),
            }}
          />
        ) : (
          <div className="overview-page__sessions">
            <SessionsTable sessions={sessions} />
            <div className="overview-page__mobile-cards">
              {sessions.map(session => (
                <SessionMobileCard key={session.id} session={session} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Small Trend Area */}
      <section className="overview-page__section" aria-labelledby="trend-heading">
        <h2 id="trend-heading" className="overview-page__section-title">Trend: Energie pro Session</h2>
        <div className="overview-page__trend">
          <TrendChart sessions={sessions} />
        </div>
      </section>

      {/* Data Source Status - honest about demo/live mode with reachability */}
      <section className="overview-page__section overview-page__section--subtle" aria-labelledby="data-source-heading">
        <h2 id="data-source-heading" className="overview-page__section-title">
          Datenquellen-Status
          {dataSourceStatus && (
            <span className="overview-page__mode-badge overview-page__mode-badge--live">
              LIVE
            </span>
          )}
        </h2>
        <div className="overview-page__import-status">
          <div className="import-status__item">
            <span className="import-status__label">Modus</span>
            <span className="import-status__value import-status__value--ok">
              Live
            </span>
          </div>
          <div className="import-status__item">
            <span className="import-status__label">EVCC (Home)</span>
            <span className={getStatusClass(dataSourceStatus?.evcc)}>
              {formatSourceStatus(dataSourceStatus?.evcc, 'EVCC')}
            </span>
          </div>
          <div className="import-status__item">
            <span className="import-status__label">TeslaMateAPI (Extern)</span>
            <span className={getStatusClass(dataSourceStatus?.teslamateapi)}>
              {formatSourceStatus(dataSourceStatus?.teslamateapi, 'TeslaMateAPI')}
            </span>
          </div>
          {dataSourceStatus?.data_source === 'live' && dataSourceStatus?.message && (
            <div className="import-status__item import-status__item--full">
              <span className="import-status__label">Status</span>
              <span className="import-status__value import-status__value--warn">
                {dataSourceStatus.message}
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// Simple inline trend chart using SVG
function TrendChart({ sessions }: { sessions: Session[] }) {
  if (sessions.length < 2) {
    return (
      <div className="trend-chart__empty">
        <p>Mindestens 2 Sessions nötig für Trendanzeige</p>
      </div>
    );
  }

  // Sort by date ascending for chart
  const sorted = [...sessions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const energies = sorted.map(s => s.energy_kwh || 0);
  const maxEnergy = Math.max(...energies, 1);
  const minEnergy = Math.min(...energies);
  const range = maxEnergy - minEnergy || 1;

  const width = 760;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const points = energies.map((energy, i) => {
    const x = padding.left + (i / (energies.length - 1)) * innerWidth;
    const y = padding.top + innerHeight - ((energy - minEnergy) / range) * innerHeight;
    return `${x},${y}`;
  }).join(' ');

  const yTicks = [minEnergy, (minEnergy + maxEnergy) / 2, maxEnergy];

  return (
    <div className="trend-chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="trend-chart__svg" role="img" aria-label="Energie-Trend der letzten Sessions">
        <defs>
          <linearGradient id="trend-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y-axis */}
        <g className="trend-chart__axis">
          <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + innerHeight} stroke="var(--color-border)" strokeWidth="1" />
          {yTicks.map((tick, i) => {
            const y = padding.top + innerHeight - ((tick - minEnergy) / range) * innerHeight;
            return (
              <g key={i}>
                <line x1={padding.left - 6} y1={y} x2={padding.left} y2={y} stroke="var(--color-border)" strokeWidth="1" />
                <text x={padding.left - 10} y={y + 4} fontSize="11" fill="var(--color-text-muted)" textAnchor="end" dominantBaseline="middle">{tick.toFixed(1)}</text>
              </g>
            );
          })}
        </g>

        {/* X-axis labels */}
        <g className="trend-chart__x-axis">
          {sorted.map((_, i) => {
            const x = padding.left + (i / (sorted.length - 1)) * innerWidth;
            return (
              <text key={i} x={x} y={height - 10} fontSize="10" fill="var(--color-text-muted)" textAnchor="middle">
                {new Date(sorted[i].date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}
              </text>
            );
          })}
        </g>

        {/* Area */}
        <path
          d={`M${points} L${padding.left + innerWidth} ${padding.top + innerHeight} L${padding.left} ${padding.top + innerHeight} Z`}
          fill="url(#trend-gradient)"
        />

        {/* Line */}
        <path
          d={`M${points}`}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Points */}
        {sorted.map((session, i) => {
          const x = padding.left + (i / (sorted.length - 1)) * innerWidth;
          const y = padding.top + innerHeight - ((energies[i] - minEnergy) / range) * innerHeight;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={4}
              fill="var(--color-primary)"
              stroke="var(--color-bg-card)"
              strokeWidth="2"
              className="trend-chart__point"
            />
          );
        })}
      </svg>
      <div className="trend-chart__legend">
        <span className="trend-chart__unit">kWh</span>
        <span className="trend-chart__range">
          {minEnergy.toFixed(1)} – {maxEnergy.toFixed(1)} kWh
        </span>
      </div>
    </div>
  );
}