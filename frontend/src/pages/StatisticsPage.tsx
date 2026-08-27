import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Zap,
  Hash,
  ChevronLeft,
  ChevronRight,
  BarChart2,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  MapPin,
  Minus,
  BarChart,
  BarChart3,
  AlertTriangle,
  Battery,
  Gauge,
  TrendingUp as TrendingUpIcon,
  Sun,
} from 'lucide-react';
import { useTimeRange, type RangeValue } from '../app/TimeRangeContext';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '../components/StateViews';
import {
  api,
  type StatisticsResponse,
  type StatisticsKPIs,
  type SourceBreakdown,
} from '../lib/apiClient';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ArcElement,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import { attachFloatingTooltip } from '../lib/chartTooltip';
import './StatisticsPage.css';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ArcElement
);

export function StatisticsPage() {
  const externalTooltip = useMemo(attachFloatingTooltip, []);
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { selectedRange, customFrom, customTo, showCustomPicker, getRangeLabel, getDaysFromRange, getFromDate, getToDate, setSelectedRange } = useTimeRange();

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
  };
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');

  const fetchStatistics = useCallback(async () => {
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
      const response: StatisticsResponse = await api.getStatistics(
        days,
        from_date,
        to_date
      );

      if (!response.ok) {
        throw new Error('API returned error status');
      }

      setData(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden der Statistiken: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedRange, customFrom, customTo]);

  useEffect(() => {
    fetchStatistics();
  }, [fetchStatistics]);

  const handleCustomRangeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customFrom && customTo) {
      fetchStatistics();
    }
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'k';
    }
    return num.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  };

  const formatKWh = (num: number | undefined | null): string => {
    if (num === null || num === undefined) return '—';
    return num.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  };

  const formatEur = (num: number | undefined | null): string => {
    if (num === null || num === undefined) return '—';
    return (
      num.toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + ' €'
    );
  };

  const formatCostPerKWh = (num: number | null): string => {
    if (num === null || num === undefined) return '—';
    return (
      num.toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      }) + ' €/kWh'
    );
  };

  const getPercentage = (value: number, total: number): number => {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
  };

  // Chart data for Daily Drives (km and kWh)
  const dailyDrivesChartData = useMemo(() => {
    if (!data?.kpis?.daily_dates || data?.kpis?.daily_dates.length === 0) return null;

    return {
      labels: data?.kpis?.daily_dates.map((d) => { const p = d.slice(5).split("-"); return `${p[1]}.${p[0]}`; }), // DD.MM
      datasets: [
        {
          label: 'km',
          data: data.kpis.daily_km || [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: false,
          tension: 0.2,
          yAxisID: 'y',
          pointRadius: 4,
          pointHoverRadius: 6,
        },
        {
          label: 'kWh',
          data: data.kpis.daily_kwh || [],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          fill: false,
          tension: 0.2,
          yAxisID: 'y1',
          pointRadius: 4,
          pointHoverRadius: 6,
        },
      ],
    };
  }, [data?.kpis?.daily_dates, data?.kpis?.daily_km, data?.kpis?.daily_kwh]);

  const dailyDrivesChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: {
          usePointStyle: true,
          padding: 20,
          font: { size: 13, family: 'system-ui' },
        },
      },
      tooltip: {
        enabled: false,
        // Universelles Floating-Tooltip (am Body, nie abgeschnitten)
        external: externalTooltip,
        callbacks: {
          label: (context: any) => {
            const label = context.dataset.label || '';
            const value = context.parsed.y;
            const idx = context.dataIndex;
            const dateStr = data?.kpis?.daily_dates?.[idx] || '';
            const formattedDate = dateStr ? new Date(dateStr).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + new Date(dateStr).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            return `${formattedDate} — ${label}: ${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${label === 'km' ? 'km' : 'kWh'}`;
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
          color: '#666',
          maxTicksLimit: 12,
        },
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: true,
          text: 'km',
          font: { size: 12, family: 'system-ui', weight: '500' as const },
          color: '#3b82f6',
        },
        grid: {
          color: '#e0e0e0',
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: '#444',
        },
        min: 0,
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        title: {
          display: true,
          text: 'kWh',
          font: { size: 12, family: 'system-ui', weight: '500' as const },
          color: '#f59e0b',
        },
        grid: {
          drawOnChartArea: false,
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: '#444',
        },
        min: 0,
      },
    },
  }), []);

  // Chart data for Daily Charged Energy (stacked bars + line)
  const dailyChargedChartData = useMemo(() => {
    if (!data?.kpis?.daily_charged_dates || data?.kpis?.daily_charged_dates.length === 0)
      return null;

    return {
      labels: data?.kpis?.daily_charged_dates.map((d) => { const p = d.slice(5).split("-"); return `${p[1]}.${p[0]}`; }), // DD.MM
      datasets: [
        {
          type: 'bar',
          label: 'Home',
          data: data.kpis.daily_home_kwh || [],
          backgroundColor: '#22c55e',
          borderColor: '#16a34a',
          borderWidth: 1,
          yAxisID: 'y',
          order: 3,
        },
        {
          type: 'bar',
          label: 'Extern',
          data: data.kpis.daily_external_kwh || [],
          backgroundColor: '#3b82f6',
          borderColor: '#2563eb',
          borderWidth: 1,
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line',
          label: 'Gesamt',
          data: data.kpis.daily_total_kwh || [],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          borderWidth: 3,
          fill: false,
          tension: 0.2,
          yAxisID: 'y',
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#f59e0b',
          order: 1,
        },
      ],
    };
  }, [
    data?.kpis?.daily_charged_dates,
    data?.kpis?.daily_home_kwh,
    data?.kpis?.daily_external_kwh,
    data?.kpis?.daily_total_kwh,
  ]);

  const dailyChargedChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: {
          usePointStyle: true,
          padding: 20,
          font: { size: 13, family: 'system-ui' },
        },
      },
      tooltip: {
        enabled: false,
        // Universelles Floating-Tooltip (am Body, nie abgeschnitten)
        external: externalTooltip,
        callbacks: {
          label: (context: any) => {
            const label = context.dataset.label || '';
            const value = context.parsed.y;
            const idx = context.dataIndex;
            const dateStr = data?.kpis?.daily_charged_dates?.[idx] || '';
            const formattedDate = dateStr ? new Date(dateStr).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + new Date(dateStr).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            return `${formattedDate} — ${label}: ${value.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWh`;
          },
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        grid: {
          display: false,
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: '#666',
          maxTicksLimit: 12,
        },
      },
      y: {
        type: 'linear' as const,
        stacked: true,
        title: {
          display: true,
          text: 'kWh',
          font: { size: 12, family: 'system-ui', weight: '500' as const },
          color: '#444',
        },
        grid: {
          color: '#e0e0e0',
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: '#444',
        },
        min: 0,
      },
    },
  }), []);

  // Cumulative kilometers chart data
  const cumulativeKmChartData = useMemo(() => {
    if (!data?.kpis?.daily_dates || data?.kpis?.daily_dates.length === 0) return null;

    // Calculate cumulative km from daily_km
    const dailyKm = data.kpis.daily_km || [];
    const cumulativeKm: number[] = [];
    let runningTotal = 0;
    for (const km of dailyKm) {
      runningTotal += km;
      cumulativeKm.push(runningTotal);
    }

    return {
      labels: data?.kpis?.daily_dates.map((d) => { const p = d.slice(5).split("-"); return `${p[1]}.${p[0]}`; }), // DD.MM
      datasets: [
        {
          label: 'Kumulierte km',
          data: cumulativeKm,
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
    };
  }, [data?.kpis?.daily_dates, data?.kpis?.daily_km]);

  const cumulativeKmChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        enabled: false,
        // Universelles Floating-Tooltip (am Body, nie abgeschnitten)
        external: externalTooltip,
        callbacks: {
          label: (context: any) => {
            const value = context.parsed.y;
            const idx = context.dataIndex;
            const dateStr = data?.kpis?.daily_dates?.[idx] || '';
            const formattedDate = dateStr ? new Date(dateStr).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + new Date(dateStr).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            return `${formattedDate} — Kumuliert: ${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} km`;
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
          color: '#666',
          maxTicksLimit: 12,
        },
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: true,
          text: 'km',
          font: { size: 12, family: 'system-ui', weight: '500' as const },
          color: '#0d9488',
        },
        grid: {
          color: '#e0e0e0',
        },
        ticks: {
          font: { size: 11, family: 'system-ui' },
          color: '#444',
        },
        min: 0,
      },
    },
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
  }), []);

  if (loading) {
    return <LoadingState message="Statistiken werden geladen…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={fetchStatistics} />;
  }

  if (!data) {
    return <EmptyState title="Keine Daten" message="Keine statistischen Daten verfügbar." />;
  }

  const {
    kpis: k,
    energy_by_source: rawEnergy,
    cost_by_source: rawCost,
    sessions_by_source: rawSessions,
    range_label,
  } = data;

  const kpis = k!;

  const energy_by_source = {
    home: rawEnergy?.home ?? 0,
    external: rawEnergy?.external ?? 0,
    import_: rawEnergy?.import_ ?? 0,
    total: rawEnergy?.total ?? 0,
  };
  const cost_by_source = {
    home: rawCost?.home ?? 0,
    external: rawCost?.external ?? 0,
    import_: rawCost?.import_ ?? 0,
    total: rawCost?.total ?? 0,
  };
  const sessions_by_source = {
    home: rawSessions?.home ?? 0,
    external: rawSessions?.external ?? 0,
    import_: rawSessions?.import_ ?? 0,
    total: rawSessions?.total ?? 0,
  };

  return (
    <div className="page-container">
      <div className="statistics-page">
        <header className="statistics-page__header">
          <div>
            <h1 className="statistics-page__title">Statistik</h1>
            <p className="statistics-page__subtitle">
              Auswertung der Ladevorgänge ·{' '}
              <span className="statistics-page__range-badge">
                {getRangeLabel(selectedRange)}
              </span>
            </p>
          </div>
        </header>

        {/* KPI Cards */}
        <section className="statistics-page__section" aria-labelledby="kpis-heading">
          <h2 id="kpis-heading" className="statistics-page__section-title">
            Kennzahlen
          </h2>
          <div className="statistics-page__kpi-grid">
            <article className="kpi-card">
              <div className="kpi-card__icon" aria-hidden="true">
                <Zap size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Gesamt geladen</span>
                <span className="kpi-card__value">
                  {formatKWh(kpis.total_energy_kwh)} kWh
                </span>
              </div>
            </article>

            <article className="kpi-card">
              <div className="kpi-card__icon" aria-hidden="true">
                <DollarSign size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Gesamtkosten</span>
                <span className="kpi-card__value">{formatEur(kpis.total_cost_eur)}</span>
              </div>
            </article>

            <article className="kpi-card">
              <div className="kpi-card__icon" aria-hidden="true">
                <TrendingUp size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Ø Kosten/kWh</span>
                <span className="kpi-card__value">
                  {formatCostPerKWh(kpis.avg_cost_per_kwh)}
                </span>
              </div>
            </article>

            <article className="kpi-card">
              <div className="kpi-card__icon" aria-hidden="true">
                <Hash size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Sessions</span>
                <span className="kpi-card__value">{kpis.total_sessions}</span>
              </div>
            </article>

            <article className="kpi-card">
              <div className="kpi-card__icon kpi-card__icon--home" aria-hidden="true">
                <Zap size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Home Sessions</span>
                <span className="kpi-card__value">{kpis.home_sessions}</span>
              </div>
            </article>

            <article className="kpi-card">
              <div className="kpi-card__icon kpi-card__icon--external" aria-hidden="true">
                <BarChart2 size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">External Sessions</span>
                <span className="kpi-card__value">{kpis.external_sessions}</span>
              </div>
            </article>

            {/* Ladeverlust-Kachel (Home: EVCC wallbox energy vs TM charge_energy_added) */}
            <article className="kpi-card">
              <div className="kpi-card__icon kpi-card__icon--loss" aria-hidden="true">
                <Activity size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Ladeverlust (Home)</span>
                <span className="kpi-card__value">
                  {kpis.charging_losses_kwh !== null &&
                  kpis.charging_losses_pct !== null ? (
                    <>
                      <span className="kpi-card__value-main">
                        {formatKWh(Math.abs(kpis.charging_losses_kwh ?? 0))} kWh
                      </span>
                      <span className="kpi-card__value-sub">
                        {(kpis.charging_losses_kwh ?? 0) >= 0 ? (
                          <ArrowUpRight
                            size={12}
                            className="kpi-card__loss-positive"
                          />
                        ) : (
                          <ArrowDownRight
                            size={12}
                            className="kpi-card__loss-negative"
                          />
                        )}
                        {Math.abs(kpis.charging_losses_pct ?? 0).toFixed(1)}%
                      </span>
                    </>
                  ) : (
                    <span className="kpi-card__empty-state">
                      Keine belastbaren EVCC↔TM-Home-Matches im Zeitraum
                    </span>
                  )}
                </span>
              </div>
            </article>

            {/* NEU: DC/AC Aggregation */}
            <article className="kpi-card">
              <div className="kpi-card__icon kpi-card__icon--dcac" aria-hidden="true">
                <Zap size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">DC / AC (External)</span>
                <span className="kpi-card__value">
                  {kpis.external_dc_sessions !== null &&
                  kpis.external_ac_sessions !== null ? (
                    <>
                      <span className="kpi-card__value-main">
                        DC: {kpis.external_dc_sessions} · AC:{' '}
                        {kpis.external_ac_sessions}
                      </span>
                      <span className="kpi-card__value-sub">
                        {kpis.external_dc_energy_kwh !== null &&
                        kpis.external_ac_energy_kwh !== null && (
                          <>
                            DC:{' '}
                            {formatKWh(kpis.external_dc_energy_kwh)} kWh · AC:{' '}
                            {formatKWh(kpis.external_ac_energy_kwh)} kWh
                          </>
                        )}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            </article>

            {/* NEU: Externer Ladeverlust (TM charge_energy_used - charge_energy_added) */}
            <article className="kpi-card">
              <div className="kpi-card__icon kpi-card__icon--loss" aria-hidden="true">
                <Activity size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Externer Ladeverlust</span>
                <span className="kpi-card__value">
                  {kpis.external_charging_losses_kwh !== null &&
                  kpis.external_charging_losses_pct !== null ? (
                    <>
                      <span className="kpi-card__value-main">
                        {formatKWh(Math.abs(kpis.external_charging_losses_kwh ?? 0))} kWh
                      </span>
                      <span className="kpi-card__value-sub">
                        {(kpis.external_charging_losses_kwh ?? 0) >= 0 ? (
                          <ArrowUpRight size={12} className="kpi-card__loss-positive" />
                        ) : (
                          <ArrowDownRight size={12} className="kpi-card__loss-negative" />
                        )}
                        {Math.abs(kpis.external_charging_losses_pct ?? 0).toFixed(1)}%
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
            </article>
          </div>
        </section>

        {/* PV-Anteil Kachel */}
        <section className="statistics-page__section" aria-labelledby="pv-heading">
          <h2 id="pv-heading" className="statistics-page__section-title">
            PV-Anteil
          </h2>
          <div className="statistics-page__kpi-grid">
            <article className="kpi-card">
              <div className="kpi-card__icon" aria-hidden="true">
                <Sun size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">PV-Anteil aller Ladevorgänge</span>
                <span className="kpi-card__value">
                  {kpis.pv_share_pct !== null && kpis.pv_share_pct !== undefined ? (
                    <>
                      <span className="kpi-card__value-main">
                        {kpis.pv_share_pct.toFixed(1)}%
                      </span>
                      <span className="kpi-card__value-sub">
                        {kpis.pv_kwh !== null ? formatKWh(kpis.pv_kwh) : '—'} kWh PV von{' '}
                        {kpis.total_charged_kwh !== null ? formatKWh(kpis.total_charged_kwh) : '—'} kWh geladen
                      </span>
                    </>
                  ) : (
                    <span className="kpi-card__empty-state">Keine PV-Daten im Zeitraum</span>
                  )}
                </span>
              </div>
            </article>
          </div>
        </section>

        {/* Pro Session */}
        <section className="statistics-page__section" aria-labelledby="session-stats-heading">
          <h2 id="session-stats-heading" className="statistics-page__section-title">
            Pro Session
          </h2>
          <div className="statistics-page__session-stats-grid">
            <article className="session-stat-card">
              <span className="session-stat-card__label">Ø Energie / Session</span>
              <span className="session-stat-card__value">
                {kpis.avg_energy_per_session !== null
                  ? formatKWh(kpis.avg_energy_per_session) + ' kWh'
                  : '—'}
              </span>
            </article>

            <article className="session-stat-card">
              <span className="session-stat-card__label">Ø Kosten / Session</span>
              <span className="session-stat-card__value">
                {kpis.avg_cost_per_session !== null
                  ? formatEur(kpis.avg_cost_per_session)
                  : '—'}
              </span>
            </article>

            <article className="session-stat-card">
              <span className="session-stat-card__label">Größte Session (kWh)</span>
              <span className="session-stat-card__value">
                {kpis.max_energy_session !== null
                  ? formatKWh(kpis.max_energy_session) + ' kWh'
                  : '—'}
                {kpis.max_energy_session_id && (
                  <span className="session-stat-card__id">
                    ID: {kpis.max_energy_session_id}
                  </span>
                )}
              </span>
            </article>

            <article className="session-stat-card">
              <span className="session-stat-card__label">Teuerste Session</span>
              <span className="session-stat-card__value">
                {kpis.max_cost_session !== null
                  ? formatEur(kpis.max_cost_session)
                  : '—'}
                {kpis.max_cost_session_id && (
                  <span className="session-stat-card__id">
                    ID: {kpis.max_cost_session_id}
                  </span>
                )}
              </span>
            </article>
          </div>
        </section>

        {/* Daily Charts Grid - Side by Side */}
        {(kpis.daily_dates && kpis.daily_dates.length > 0) || (kpis.daily_charged_dates && kpis.daily_charged_dates.length > 0) ? (
          <section className="statistics-page__section" aria-labelledby="daily-charts-heading">
            <h2 id="daily-charts-heading" className="statistics-page__section-title">
              Tagesauswertungen
            </h2>
            <div className="statistics-page__charts-grid">
              {/* Daily Drives Chart */}
              {kpis.daily_dates && kpis.daily_dates.length > 0 && (
                <div className="statistics-page__chart-card">
                  <div className="statistics-page__chart-header">
                    <h3 className="statistics-page__chart-subtitle">Tägliche Fahrten (TeslaMate)</h3>
                    <div className="statistics-page__chart-toggle">
                      <button
                        className={`statistics-page__chart-toggle-btn ${chartType === 'line' ? 'active' : ''}`}
                        onClick={() => setChartType('line')}
                        aria-pressed={chartType === 'line'}
                        title="Liniendiagramm"
                      >
                        <BarChart3 size={16} />
                      </button>
                      <button
                        className={`statistics-page__chart-toggle-btn ${chartType === 'bar' ? 'active' : ''}`}
                        onClick={() => setChartType('bar')}
                        aria-pressed={chartType === 'bar'}
                        title="Balkendiagramm"
                      >
                        <BarChart size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="statistics-page__chart-container">
                    {dailyDrivesChartData && (
                      <div className="statistics-page__chart-wrapper">
                        {chartType === 'line' ? (
                          <Line
                            data={dailyDrivesChartData}
                            options={dailyDrivesChartOptions as any}
                            aria-label={`Tägliche Fahrten: ${kpis.daily_dates.length} Tage, km und kWh (Linien)`}
                          />
                        ) : (
                          <Bar
                            data={{
                              ...dailyDrivesChartData,
                              datasets: dailyDrivesChartData.datasets.map((ds) => ({
                                ...ds,
                                type: 'bar' as const,
                                fill: true,
                                backgroundColor: ds.backgroundColor,
                                borderColor: ds.borderColor,
                                borderWidth: 1,
                              })),
                            }}
                            options={{
                              ...dailyDrivesChartOptions,
                              scales: {
                                ...dailyDrivesChartOptions.scales,
                                x: { ...dailyDrivesChartOptions.scales.x, stacked: false },
                                y: { ...dailyDrivesChartOptions.scales.y, stacked: false },
                                y1: { ...dailyDrivesChartOptions.scales.y1, stacked: false },
                              },
                            } as any}
                            aria-label={`Tägliche Fahrten: ${kpis.daily_dates.length} Tage, km und kWh (Balken)`}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Daily Charged Energy Chart */}
              {kpis.daily_charged_dates && kpis.daily_charged_dates.length > 0 && (
                <div className="statistics-page__chart-card">
                  <div className="statistics-page__chart-header">
                    <h3 className="statistics-page__chart-subtitle">Täglich geladene Energie</h3>
                  </div>
                  <div className="statistics-page__chart-container">
                    {dailyChargedChartData && (
                      <div className="statistics-page__chart-wrapper">
                        <Bar
                          data={dailyChargedChartData as any}
                          options={dailyChargedChartOptions as any}
                          aria-label={`Täglich geladene Energie: ${kpis.daily_charged_dates.length} Tage, Home/Extern/Gesamt kWh`}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Cumulative Kilometers Chart */}
              {kpis.daily_dates && kpis.daily_dates.length > 0 && cumulativeKmChartData && (
                <div className="statistics-page__chart-card">
                  <div className="statistics-page__chart-header">
                    <h3 className="statistics-page__chart-subtitle">Kumulierte gefahrene Kilometer</h3>
                  </div>
                  <div className="statistics-page__chart-container">
                    <div className="statistics-page__chart-wrapper">
                      <Line
                        data={cumulativeKmChartData as any}
                        options={cumulativeKmChartOptions as any}
                        aria-label={`Kumulierte Kilometer: ${kpis.daily_dates.length} Tage`}
                      />
                    </div>
                  </div>
                </div>
              )}

            </div>
          </section>
        ) : null}

        {/* Energy Distribution */}
        <section className="statistics-page__section" aria-labelledby="energy-dist-heading">
          <h2 id="energy-dist-heading" className="statistics-page__section-title">
            Energie-Verteilung (kWh)
          </h2>
          <div className="statistics-page__distribution-grid">
            <article className="distribution-card distribution-card--home">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Home (EVCC)</span>
                <span className="distribution-card__percentage">
                  {getPercentage(energy_by_source.home, energy_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--home"
                  style={{
                    width: `${getPercentage(
                      energy_by_source.home,
                      energy_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {formatKWh(energy_by_source.home)} kWh
                </span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--external">
              <header className="distribution-card__header">
                <span className="distribution-card__source">External (TeslaMate)</span>
                <span className="distribution-card__percentage">
                  {getPercentage(energy_by_source.external, energy_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--external"
                  style={{
                    width: `${getPercentage(
                      energy_by_source.external,
                      energy_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {formatKWh(energy_by_source.external)} kWh
                </span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--import">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Import</span>
                <span className="distribution-card__percentage">
                  {getPercentage(energy_by_source.import_, energy_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--import"
                  style={{
                    width: `${getPercentage(
                      energy_by_source.import_,
                      energy_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {formatKWh(energy_by_source.import_)} kWh
                </span>
              </footer>
            </article>
          </div>
        </section>

        {/* Cost Distribution */}
        <section className="statistics-page__section" aria-labelledby="cost-dist-heading">
          <h2 id="cost-dist-heading" className="statistics-page__section-title">
            Kosten-Verteilung
          </h2>
          <div className="statistics-page__distribution-grid">
            <article className="distribution-card distribution-card--home">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Home (EVCC)</span>
                <span className="distribution-card__percentage">
                  {getPercentage(cost_by_source.home, cost_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--home"
                  style={{
                    width: `${getPercentage(
                      cost_by_source.home,
                      cost_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {formatEur(cost_by_source.home)}
                </span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--external">
              <header className="distribution-card__header">
                <span className="distribution-card__source">External (TeslaMate)</span>
                <span className="distribution-card__percentage">
                  {getPercentage(cost_by_source.external, cost_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--external"
                  style={{
                    width: `${getPercentage(
                      cost_by_source.external,
                      cost_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {formatEur(cost_by_source.external)}
                </span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--import">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Import</span>
                <span className="distribution-card__percentage">
                  {getPercentage(cost_by_source.import_, cost_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--import"
                  style={{
                    width: `${getPercentage(
                      cost_by_source.import_,
                      cost_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {formatEur(cost_by_source.import_)}
                </span>
              </footer>
            </article>
          </div>
        </section>

        {/* Sessions Distribution */}
        <section className="statistics-page__section" aria-labelledby="sessions-dist-heading">
          <h2 id="sessions-dist-heading" className="statistics-page__section-title">
            Sessions-Verteilung
          </h2>
          <div className="statistics-page__distribution-grid">
            <article className="distribution-card distribution-card--home">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Home (EVCC)</span>
                <span className="distribution-card__percentage">
                  {getPercentage(sessions_by_source.home, sessions_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--home"
                  style={{
                    width: `${getPercentage(
                      sessions_by_source.home,
                      sessions_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {sessions_by_source.home.toFixed(0)} Sessions
                </span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--external">
              <header className="distribution-card__header">
                <span className="distribution-card__source">External (TeslaMate)</span>
                <span className="distribution-page__percentage">
                  {getPercentage(sessions_by_source.external, sessions_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--external"
                  style={{
                    width: `${getPercentage(
                      sessions_by_source.external,
                      sessions_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {sessions_by_source.external.toFixed(0)} Sessions
                </span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--import">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Import</span>
                <span className="distribution-card__percentage">
                  {getPercentage(sessions_by_source.import_, sessions_by_source.total)}%
                </span>
              </header>
              <div className="distribution-card__bar">
                <div
                  className="distribution-card__fill distribution-card__fill--import"
                  style={{
                    width: `${getPercentage(
                      sessions_by_source.import_,
                      sessions_by_source.total
                    )}%`,
                  }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">
                  {sessions_by_source.import_.toFixed(0)} Sessions
                </span>
              </footer>
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}