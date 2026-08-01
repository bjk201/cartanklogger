import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { KpiCard } from '../../components/KpiCard';
import { SessionsTable } from '../../components/SessionsTable';
import { SessionMobileCard } from '../../components/SessionMobileCard';
import { LoadingState, ErrorState, EmptyState, PartialError } from '../../components/StateViews';
import { api, type Session, type OverviewResponse } from '../../lib/apiClient';
import './OverviewPage.css';

export function OverviewPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [kpiData, setKpiData] = useState({
    totalSessions: 0,
    totalEnergy: 0,
    totalCost: 0,
    homeShare: 0,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPartialError(null);
    
    try {
      const response: OverviewResponse = await api.getRecentSessions(10);
      
      if (!response.ok) {
        throw new Error('API returned error status');
      }
      
      setSessions(response.data);
      
      // Calculate KPIs from the 10 sessions
      const homeSessions = response.data.filter(s => s.source_type === 'home');
      const totalEnergy = response.data.reduce((sum, s) => sum + (s.energy_kwh || 0), 0);
      const totalCost = response.data.reduce((sum, s) => sum + (s.cost_eur || 0), 0);
      const homeShare = response.data.length > 0 
        ? (homeSessions.length / response.data.length) * 100 
        : 0;
      
      setKpiData({
        totalSessions: response.data.length,
        totalEnergy: Math.round(totalEnergy * 10) / 10,
        totalCost: Math.round(totalCost * 100) / 100,
        homeShare: Math.round(homeShare),
      });
      
      // Check if we have seed data (legacy sessions without legacy_source)
      // This is a soft warning since we're still showing data
      const hasSeedData = response.data.some(s => 
        s.location === 'Garage' && s.note === 'Home charging' ||
        s.location?.includes('Supercharger') && s.note === 'Long distance trip'
      );
      
      if (hasSeedData) {
        setPartialError('Hinweis: Aktuell werden Demo-Daten angezeigt. Echte Daten folgen nach Import.');
      }
      
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden der Sessions: ${message}`);
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

  return (
    <div className="overview-page">
      <div className="overview-page__header">
        <h1 className="overview-page__title">Overview</h1>
        <p className="overview-page__subtitle">
          Letzte 10 Sessions · 
          <span className="overview-page__status">
            {loading ? 'Lädt…' : error ? 'Fehler' : 'Aktuell'}
          </span>
        </p>
      </div>

      {partialError && (
        <PartialError message={partialError} onDismiss={() => setPartialError(null)} />
      )}

      {error && !loading ? (
        <ErrorState message={error} onRetry={handleRetry} />
      ) : (
        <>
          {/* KPI Cards */}
          <section className="overview-page__section" aria-labelledby="kpi-heading">
            <h2 id="kpi-heading" className="overview-page__section-title">Kennzahlen (letzte 10 Sessions)</h2>
            <div className="overview-page__kpi-grid">
              <KpiCard
                label="Sessions"
                value={kpiData.totalSessions}
                icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>}
                subtitle="In der Übersicht"
              />
              <KpiCard
                label="Energie"
                value={kpiData.totalEnergy.toFixed(1)}
                unit="kWh"
                iconColor="var(--color-home)"
                icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>}
                subtitle="Gesamt geladen"
              />
              <KpiCard
                label="Kosten"
                value={kpiData.totalCost.toFixed(2)}
                unit="€"
                iconColor="#f59e0b"
                icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>}
                subtitle="Gesamtkosten"
              />
              <KpiCard
                label="Home-Anteil"
                value={kpiData.homeShare}
                unit="%"
                iconColor="var(--color-primary)"
                icon={() => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>}
                subtitle="von 10 Sessions"
              />
            </div>
          </section>

          {/* Sessions List */}
          <section className="overview-page__section" aria-labelledby="sessions-heading">
            <div className="overview-page__section-header">
              <h2 id="sessions-heading" className="overview-page__section-title">Letzte Sessions</h2>
              <button
                className="overview-page__view-all"
                onClick={() => navigate('/sessions')}
              >
                Alle anzeigen →
              </button>
            </div>
            
            {loading ? (
              <LoadingState message="Sessions werden geladen…" />
            ) : sessions.length === 0 ? (
              <EmptyState
                title="Keine Sessions"
                message="Es wurden noch keine Ladevorgänge importiert."
                action={{
                  label: 'Import starten',
                  onClick: () => navigate('/import'),
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

          {/* Import Status */}
          <section className="overview-page__section overview-page__section--subtle" aria-labelledby="import-status-heading">
            <h2 id="import-status-heading" className="overview-page__section-title">Import-Status</h2>
            <div className="overview-page__import-status">
              <div className="import-status__item">
                <span className="import-status__label">Datenquelle</span>
                <span className="import-status__value import-status__value--ok">EVCC (Home)</span>
              </div>
              <div className="import-status__item">
                <span className="import-status__label">Datenquelle</span>
                <span className="import-status__value import-status__value--ok">TeslaMate (Extern)</span>
              </div>
              <div className="import-status__item">
                <span className="import-status__label">Letzter Sync</span>
                <span className="import-status__value">Nicht durchgeführt</span>
              </div>
              <div className="import-status__item">
                <span className="import-status__label">Status</span>
                <span className="import-status__value import-status__value--warn">Dry-Run DB aktiv</span>
              </div>
            </div>
          </section>
        </>
      )}
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
  
  const width = 100;
  const height = 80;
  const padding = { top: 10, right: 10, bottom: 20, left: 35 };
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
                <line x1={padding.left - 4} y1={y} x2={padding.left} y2={y} stroke="var(--color-border)" strokeWidth="1" />
                <text x={padding.left - 8} y={y + 4} fontSize="9" fill="var(--color-text-muted)" textAnchor="end" dominantBaseline="middle">{tick.toFixed(1)}</text>
              </g>
            );
          })}
        </g>
        
        {/* X-axis labels */}
        <g className="trend-chart__x-axis">
          {sorted.map((_, i) => {
            const x = padding.left + (i / (sorted.length - 1)) * innerWidth;
            return (
              <text key={i} x={x} y={height - 4} fontSize="8" fill="var(--color-text-muted)" textAnchor="middle">
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
              r={3}
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