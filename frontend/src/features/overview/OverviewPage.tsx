import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, ChevronLeft, ChevronRight, X, Zap, Euro, MapPin, Sun, Activity, List } from 'lucide-react';
import { useTimeRange, type RangeValue } from '../../app/TimeRangeContext';
import { KpiCard } from '../../components/KpiCard';
import { SessionsTable } from '../../components/SessionsTable';
import { SessionMobileCard } from '../../components/SessionMobileCard';
import { LoadingState, ErrorState, EmptyState } from '../../components/StateViews';
import { api, type Session, type OverviewResponse, type OverviewSummaryResponse, type DataSourceStatusResponse, type PaginationInfo } from '../../lib/apiClient';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Pie } from 'react-chartjs-2';
import './OverviewPage.css';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const OVERVIEW_PAGE_SIZE = 10;

export function OverviewPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<OverviewSummaryResponse | null>(null);
  const [dataSourceStatus, setDataSourceStatus] = useState<DataSourceStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Use global time range context
  const { selectedRange, customFrom, customTo, showCustomPicker, getRangeLabel, getDaysFromRange, getFromDate, getToDate, setSelectedRange } = useTimeRange();

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
  };

  // Pagination state
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    page_size: OVERVIEW_PAGE_SIZE,
    total: 0,
    total_pages: 0,
    has_next: false,
    has_prev: false,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Determine API parameters based on selected range (from global context)
    let days: number | undefined = getDaysFromRange(selectedRange);
    let from_date: string | undefined = getFromDate();
    let to_date: string | undefined = getToDate();

    if (selectedRange === 'custom') {
      if (customFrom) from_date = customFrom;
      if (customTo) to_date = customTo;
    } else if (selectedRange === 'all') {
      days = 36500; // ~100 years
    }

    try {
      const [recentResponse, summaryResponse, statusResponse] = await Promise.all([
        api.getRecentSessions(OVERVIEW_PAGE_SIZE * pagination.page, days, from_date, to_date), // We'll implement pagination manually by fetching more
        api.getOverviewSummary(days, from_date, to_date),
        api.getDataSourceStatus(),
      ]);

      if (!recentResponse.ok || !summaryResponse.ok || !statusResponse.ok) {
        throw new Error('API returned error status');
      }

      // For pagination, we need total count - get it from summary or fetch separately
      // For now, use the full dataset for pagination calculation
      const allSessions = recentResponse.data;
      const totalSessions = summaryResponse.total_sessions;
      const totalPages = Math.ceil(totalSessions / OVERVIEW_PAGE_SIZE);

      // Slice for current page
      const startIdx = (pagination.page - 1) * OVERVIEW_PAGE_SIZE;
      const endIdx = startIdx + OVERVIEW_PAGE_SIZE;
      const pageSessions = allSessions.slice(startIdx, endIdx);

      setSessions(pageSessions);
      setSummary(summaryResponse);
      setDataSourceStatus(statusResponse);
      setPagination(p => ({
        ...p,
        total: totalSessions,
        total_pages: totalPages,
        has_next: pagination.page < totalPages,
        has_prev: pagination.page > 1,
      }));

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden der Overview: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedRange, customFrom, customTo, pagination.page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRetry = () => {
    fetchData();
  };



  const handleCustomRangeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customFrom && customTo) {
      setPagination(p => ({ ...p, page: 1 }));
      fetchData();
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.total_pages) {
      setPagination(p => ({ ...p, page: newPage }));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
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
      <header className="overview-page__header">
        <div>
          <h1 className="overview-page__title">Overview</h1>
          <p className="overview-page__subtitle">
            Produktiver Einstieg · <span className="overview-page__status">{getRangeLabel(selectedRange)}</span>
          </p>
        </div>
      </header>

      {/* KPI Cards - Real Data from Summary API */}
      {summary && (
        <section className="overview-page__section" aria-labelledby="kpi-heading">
          <h2 id="kpi-heading" className="overview-page__section-title">Kennzahlen (gesamt)</h2>
          <div className="overview-page__kpi-grid">
            {/* 1. Gesamt kWh */}
            <KpiCard
              label="Gesamt kWh"
              value={formatNumber(summary.total_energy_kwh)}
              unit="kWh"
              icon={(props) => <Zap {...props} />}
              iconColor="var(--color-home)"
              subtitle="Gesamt geladen"
            />
            {/* 2. Gesamtkosten */}
            <KpiCard
              label="Gesamtkosten"
              value={summary.total_cost_eur.toFixed(2)}
              unit="€"
              icon={(props) => <Euro {...props} />}
              iconColor="#f59e0b"
              subtitle="Gesamtkosten"
            />
            {/* 3. Durchschnittskosten/kWh */}
            <KpiCard
              label="Ø Kosten/kWh"
              value={formatCostPerKWh(summary.avg_cost_per_kwh)}
              icon={(props) => <Activity {...props} />}
              iconColor="var(--color-primary)"
              subtitle="Durchschnittspreis"
            />
            {/* 4. Anzahl Sessions */}
            <KpiCard
              label="Anzahl Sessions"
              value={summary.total_sessions}
              icon={(props) => <Calendar {...props} />}
              iconColor="var(--color-primary)"
              subtitle="Alle Ladevorgänge"
            />
            {/* 5. Haus + Extern Split + Pie Chart (double width) */}
            <article className="kpi-card kpi-card--double-width">
              <div className="kpi-card__content">
                <span className="kpi-card__label">Ladevorgänge: Zuhause & Extern</span>
                <div className="overview-page__split-chart">
                  <div className="overview-page__split-left">
                    <div className="overview-page__split-item">
                      <div className="overview-page__split-icon overview-page__split-icon--home" aria-hidden="true">
                        <Zap size={20} />
                      </div>
                      <div className="overview-page__split-data">
                        <span className="overview-page__split-value">{formatNumber(summary.home_energy_kwh)} kWh</span>
                        <span className="overview-page__split-sub">{summary.home_share_pct.toFixed(1)}% · {formatCostPerKWh(summary.avg_cost_per_kwh)}/kWh</span>
                      </div>
                    </div>
                    <div className="overview-page__split-item">
                      <div className="overview-page__split-icon overview-page__split-icon--external" aria-hidden="true">
                        <MapPin size={20} />
                      </div>
                      <div className="overview-page__split-data">
                        <span className="overview-page__split-value">{formatNumber(summary.external_energy_kwh)} kWh</span>
                        <span className="overview-page__split-sub">{summary.external_sessions} Sessions</span>
                      </div>
                    </div>
                  </div>
                  <div className="overview-page__split-center">
                    {/* Pie Chart */}
                    <Pie
                      data={{
                        labels: ['Zuhause', 'Extern'],
                        datasets: [{
                          data: [summary.home_energy_kwh, summary.external_energy_kwh],
                          backgroundColor: ['var(--color-home)', 'var(--color-external)'],
                          borderWidth: 0,
                        }],
                      }}
                      options={{
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                          legend: { display: false },
                          tooltip: {
                            callbacks: {
                              label: (ctx: any) => `${ctx.label}: ${ctx.parsed.toFixed(1)} kWh`,
                            },
                          },
                        },
                      }}
                    />
                    <span className="overview-page__pie-total">{formatNumber(summary.total_energy_kwh)} kWh</span>
                  </div>
                  <div className="overview-page__split-right">
                    <div className="overview-page__split-item">
                      <div className="overview-page__split-icon overview-page__split-icon--supercharger" aria-hidden="true">
                        <MapPin size={20} />
                      </div>
                      <div className="overview-page__split-data">
                        <span className="overview-page__split-value">{formatNumber(summary.external_energy_kwh)} kWh</span>
                        <span className="overview-page__split-sub">{summary.external_sessions} Extern-Sessions</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>
      )}

      {/* Driving Distance KPI */}
      {summary && (
        <section className="overview-page__section" aria-labelledby="distance-heading">
          <h2 id="distance-heading" className="overview-page__section-title">Gefahrene km</h2>
          <div className="overview-page__kpi-grid">
            <KpiCard
              label="Gesamt km"
              value={summary.total_distance_km !== null && summary.total_distance_km !== undefined ? formatNumber(summary.total_distance_km) : '—'}
              unit="km"
              icon={(props) => <Activity {...props} />}
              iconColor="var(--color-primary)"
              subtitle="Im Zeitraum gefahren"
            />
            <KpiCard
              label="Ø km/Tag"
              value={summary.avg_distance_per_day_km !== null && summary.avg_distance_per_day_km !== undefined ? formatNumber(summary.avg_distance_per_day_km) : '—'}
              unit="km"
              icon={(props) => <Activity {...props} />}
              iconColor="var(--color-primary)"
              subtitle={summary.days_with_data !== null && summary.days_with_data !== undefined ? `${summary.days_with_data} Tage mit Daten` : '—'}
            />
          </div>
        </section>
      )}

      {/* Sessions List with Pagination */}
      <section className="overview-page__section" aria-labelledby="sessions-heading">
        <div className="overview-page__section-header">
          <h2 id="sessions-heading" className="overview-page__section-title">Sessions im Zeitraum</h2>
          <button
            className="overview-page__view-all"
            onClick={() => navigate('/sessions')}
          >
            Alle anzeigen →
          </button>
        </div>

        {sessions.length === 0 ? (
          <EmptyState
            title="Keine Sessions im Zeitraum"
            message="Für den gewählten Zeitraum wurden keine Ladevorgänge gefunden."
            action={{
              label: 'Anderen Zeitraum wählen',
              onClick: () => handleRangeChange('30d'),
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

            {/* Pagination */}
            {pagination.total_pages > 1 && (
              <nav className="overview-page__pagination" aria-label="Seiten-Navigation">
                <button
                  onClick={() => handlePageChange(pagination.page - 1)}
                  disabled={!pagination.has_prev}
                  className="overview-page__page-btn"
                  aria-label="Vorherige Seite"
                >
                  <ChevronLeft size={18} />
                </button>

                <div className="overview-page__page-info">
                  <span>
                    Seite {pagination.page} von {pagination.total_pages} ({pagination.total} Sessions)
                  </span>
                </div>

                <button
                  onClick={() => handlePageChange(pagination.page + 1)}
                  disabled={!pagination.has_next}
                  className="overview-page__page-btn"
                  aria-label="Nächste Seite"
                >
                  <ChevronRight size={18} />
                </button>
              </nav>
            )}
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

// Energy Trend Chart using react-chartjs-2
function TrendChart({ sessions }: { sessions: Session[] }) {
  // Sort by date ascending for chart
  const sorted = useMemo(() => [...sessions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()), [sessions]);
  const energies = useMemo(() => sorted.map(s => s.energy_kwh || 0), [sorted]);

  if (sorted.length < 2) {
    return (
      <div className="trend-chart__empty">
        <p>Mindestens 2 Sessions nötig für Trendanzeige</p>
      </div>
    );
  }

  const chartData = useMemo(() => ({
    labels: sorted.map(s => {
      const d = new Date(s.date);
      return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    }), // DD.MM format
    datasets: [
      {
        label: 'Energie pro Session',
        data: energies,
        borderColor: '#0d9488',
        backgroundColor: 'rgba(13, 148, 136, 0.15)',
        fill: true,
        tension: 0.25,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: '#0d9488',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 1.5,
        borderWidth: 2,
      },
    ],
  }), [sorted, energies]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 12,
        titleFont: { size: 13, family: 'system-ui' },
        bodyFont: { size: 12, family: 'system-ui' },
        callbacks: {
          label: (context: any) => {
            const value = context.parsed.y;
            const idx = context.dataIndex;
            const session = sorted[idx];
            const dateStr = session ? new Date(session.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + new Date(session.date).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            return `${dateStr} — Energie: ${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kWh`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: 'var(--color-text-muted)',
          maxTicksLimit: 10,
        },
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: true,
          text: 'kWh',
          font: { size: 12, family: 'system-ui', weight: '500' as const },
          color: 'var(--color-text-muted)',
        },
        grid: {
          color: 'var(--color-border)',
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: 'var(--color-text-muted)',
        },
        min: 0,
      },
    },
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
  }), []);

  return (
    <div className="trend-chart">
      <div className="trend-chart__wrapper">
        <Line
          data={chartData}
          options={chartOptions as any}
          aria-label={`Energie-Trend: ${sorted.length} Sessions, ${Math.min(...energies).toFixed(1)} – ${Math.max(...energies).toFixed(1)} kWh`}
        />
      </div>
      <div className="trend-chart__legend">
        <span className="trend-chart__unit">kWh</span>
        <span className="trend-chart__range">
          {Math.min(...energies).toFixed(1)} – {Math.max(...energies).toFixed(1)} kWh
        </span>
      </div>
    </div>
  );
}