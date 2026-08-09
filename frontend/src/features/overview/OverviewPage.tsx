import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Euro, Activity, House, Bolt, Gauge, PlugZap, TrendingUp, TrendingDown } from 'lucide-react';
import { useTimeRange, type RangeValue } from '../../app/TimeRangeContext';
import { KpiCard } from '../../components/KpiCard';
import { SessionsTable } from '../../components/SessionsTable';
import { SessionMobileCard } from '../../components/SessionMobileCard';
import { LoadingState, ErrorState, EmptyState } from '../../components/StateViews';
import { api, type Session, type OverviewSummaryResponse, type VehicleInfoResponse, type StatisticsResponse, type StatisticsKPIs } from '../../lib/apiClient';
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

function movingAverage(data: number[], windowSize: number): (number | null)[] {
  return data.map((_, i) => {
    if (i === 0) return data[0]; // start with first value
    const start = Math.max(0, i - windowSize + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= i; j++) { sum += data[j]; count++; }
    return count > 0 ? sum / count : null;
  });
}

export function OverviewPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<OverviewSummaryResponse | null>(null);
  const [vehicleInfo, setVehicleInfo] = useState<VehicleInfoResponse | null>(null);
  const [statistics, setStatistics] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { selectedRange, customFrom, customTo, getRangeLabel, getDaysFromRange, getFromDate, getToDate, setSelectedRange } = useTimeRange();

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    let days: number | undefined = getDaysFromRange(selectedRange);
    let from_date: string | undefined = getFromDate();
    let to_date: string | undefined = getToDate();

    if (selectedRange === 'custom') {
      if (customFrom) from_date = customFrom;
      if (customTo) to_date = customTo;
    } else if (selectedRange === 'all') {
      days = 36500;
    }

    try {
      const [sessionsResponse, summaryResponse, statsResponse, vehicleResponse] = await Promise.all([
        api.getRecentSessions(100, days, from_date, to_date),
        api.getOverviewSummary(days, from_date, to_date),
        api.getStatistics(days, from_date, to_date).catch(() => null),
        api.getVehicleInfo().catch(() => null),
      ]);

      if (!sessionsResponse.ok || !summaryResponse.ok) {
        throw new Error('API returned error status');
      }

      setSessions(sessionsResponse.data || []);
      setSummary(summaryResponse);
      setStatistics(statsResponse);
      setVehicleInfo(vehicleResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden der Overview: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedRange, customFrom, customTo]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRetry = () => fetchData();

  const formatNumber = (num: number): string =>
    num.toLocaleString('de-DE', { maximumFractionDigits: 2 });

  const formatCostPerKWh = (num: number | null | undefined): string => {
    if (num === null || num === undefined) return '—';
    return num.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' €/kWh';
  };

  const recentSessions: Session[] = useMemo(() => {
    return [...sessions]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 5);
  }, [sessions]);

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
            <span className="overview-page__status">{getRangeLabel(selectedRange)}</span>
          </p>
        </div>
      </header>

      {/* KPI CARDS */}
      {summary && (
        <section className="overview-page__section" aria-labelledby="kpi-heading">
          <h2 id="kpi-heading" className="overview-page__section-title">Kennzahlen</h2>
          <div className="overview-page__kpi-grid">
            <KpiCard label="Gesamt kWh" value={summary.total_energy_kwh ? formatNumber(summary.total_energy_kwh) : '—'} unit="kWh" icon={(p) => <Zap {...p} />} iconColor="var(--color-home)" horizontal />
            <KpiCard label="Gesamtkosten" value={summary.total_cost_eur ? summary.total_cost_eur.toFixed(2) : '—'} unit="€" icon={(p) => <Euro {...p} />} iconColor="#f59e0b" horizontal />
            <KpiCard label="Ø Kosten/kWh" value={formatCostPerKWh(summary.avg_cost_per_kwh)} icon={(p) => <Activity {...p} />} iconColor="var(--color-primary)" horizontal />

            {vehicleInfo?.data?.current_odometer_km != null && (
              <KpiCard label="Aktueller KM-Stand" value={formatNumber(vehicleInfo.data.current_odometer_km)} unit="km" icon={(p) => <Gauge {...p} />} iconColor="var(--color-primary)" horizontal />
            )}

            {/* Ladevorgänge double-width card */}
            <article className="kpi-card kpi-card--double-width">
              <div className="kpi-card__content">
                <span className="kpi-card__label">Ladevorgänge: Zuhause & Extern</span>
                <div className="overview-page__split-chart">
                  {/* LEFT: Home */}
                  <div className="overview-page__split-left">
                    <div className="overview-page__split-item">
                      <div className="overview-page__split-icon overview-page__split-icon--home" aria-hidden="true"><House size={36} /></div>
                      <div className="overview-page__split-data">
                        <span className="overview-page__split-value">{summary.home_energy_kwh ? formatNumber(summary.home_energy_kwh) : '—'} kWh</span>
                        <span className="overview-page__split-sub">{summary.home_share_pct != null ? `${summary.home_share_pct.toFixed(1)}%` : '—'}</span>
                        <span className="overview-page__split-sub">{formatCostPerKWh(summary.avg_cost_per_kwh)}</span>
                        <span className="overview-page__split-sub">{summary.home_sessions || 0} Sessions</span>
                      </div>
                    </div>
                  </div>

                  {/* CENTER: Pie */}
                  <div className="overview-page__split-center">
                    <div className="pie-chart-wrapper">
                      <Pie
                        data={{
                          labels: ['Zuhause', 'Extern'],
                          datasets: [{
                            data: [summary.home_energy_kwh || 0, summary.external_energy_kwh || 0],
                            backgroundColor: ['#0d9488', '#2563eb'],
                            borderWidth: 0,
                          }],
                        }}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
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
                    </div>
                    <span className="overview-page__pie-total">{summary.total_energy_kwh ? formatNumber(summary.total_energy_kwh) : '—'} kWh</span>
                  </div>

                  {/* RIGHT: External only */}
                  <div className="overview-page__split-right">
                    <div className="overview-page__split-item overview-page__split-item--right">
                      <div className="overview-page__split-data overview-page__split-data--right">
                        <span className="overview-page__split-value">{summary.external_energy_kwh ? formatNumber(summary.external_energy_kwh) : '—'} kWh</span>
                        <span className="overview-page__split-sub">
                          {summary.home_energy_kwh && summary.external_energy_kwh
                            ? `${(summary.external_energy_kwh / (summary.home_energy_kwh + summary.external_energy_kwh) * 100).toFixed(1)}%`
                            : '—'}
                        </span>
                        <span className="overview-page__split-sub">{formatCostPerKWh(summary.avg_cost_per_kwh)}</span>
                        <span className="overview-page__split-sub">{summary.external_sessions || 0} Sessions</span>
                      </div>
                      <div className="overview-page__split-icon overview-page__split-icon--supercharger" aria-hidden="true"><PlugZap size={36} /></div>
                    </div>
                  </div>
                </div>
              </div>
            </article>

            {/* Gesamt km + Ø km/Tag als eigene Kacheln rechts neben dem Pie */}
            {summary.total_distance_km != null && (
              <KpiCard label="Gesamt km" value={formatNumber(summary.total_distance_km)} unit="km" icon={(p) => <Activity {...p} />} iconColor="var(--color-primary)" horizontal />
            )}
            {summary.avg_distance_per_day_km != null && (
              <KpiCard label="Ø km/Tag" value={formatNumber(summary.avg_distance_per_day_km)} unit="km" icon={(p) => <Activity {...p} />} iconColor="var(--color-home)" horizontal />
            )}
          </div>
        </section>
      )}

      {/* TRENDS mit Daten aus Statistics API */}
      {statistics?.kpis?.daily_dates && statistics.kpis.daily_dates.length >= 2 && (
        <section className="overview-page__section" aria-labelledby="trend-heading">
          <h2 id="trend-heading" className="overview-page__section-title">Trends</h2>
          <div className="overview-page__trends-grid">
            <TrendChartDaily title="Energie pro Session" data={statistics.kpis} />
            <TrendChartDaily title="Verbrauch kWh/100 km" data={statistics.kpis} chartType="consumption" />
            <TrendChartDaily title="Preis pro kWh" data={statistics.kpis} chartType="noData" />
            <TrendChartDaily title="Preis pro km" data={statistics.kpis} chartType="noData" />
            <TrendChartDaily title="Gefahrene km (kumuliert)" data={statistics.kpis} chartType="cumulativeKm" />
          </div>
        </section>
      )}

      {/* SESSIONS + MONTHLY COMPARISON */}
      <section className="overview-page__section" aria-labelledby="recent-sessions-heading">
        <div className="overview-page__section-header">
          <h2 id="recent-sessions-heading" className="overview-page__section-title">Sessions im Zeitraum</h2>
          <button className="overview-page__view-all" onClick={() => navigate('/sessions')}>Alle anzeigen →</button>
        </div>

        {recentSessions.length === 0 ? (
          <EmptyState title="Keine Sessions im Zeitraum" message="Für den gewählten Zeitraum wurden keine Ladevorgänge gefunden." action={{ label: 'Anderen Zeitraum wählen', onClick: () => handleRangeChange('30d') }} />
        ) : (
          <div className="overview-page__sessions-split">
            <div className="overview-page__sessions-left">
              <h3 className="overview-page__sessions-subtitle">Letzte Ladevorgänge</h3>
              <SessionsTable sessions={recentSessions} compact />
              <div className="overview-page__mobile-cards">
                {recentSessions.map(session => (
                  <SessionMobileCard key={session.id} session={session} />
                ))}
              </div>
            </div>
            <div className="overview-page__sessions-right">
              <MonthlyComparison sessions={sessions} statsData={statistics?.kpis} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ===== TrendChartDaily (based on Statistics KPIs daily data) ===== */
interface TrendChartDailyProps {
  title: string;
  data: StatisticsKPIs;
  chartType?: 'energy' | 'consumption' | 'cumulativeKm' | 'noData';
}

function TrendChartDaily({ title, data, chartType = 'energy' }: TrendChartDailyProps) {
  const chartConfig = useMemo(() => {
    const dates = data.daily_dates || [];
    let values: number[] = [];
    let yLabel = '';
    let color = '#0d9488';

    switch (chartType) {
      case 'noData': {
        values = [];
        yLabel = '—';
        break;
      }
      case 'consumption': {
        // kWh/100km = daily_kwh / daily_km * 100
        const km = data.daily_km || [];
        const kwh = data.daily_kwh || [];
        values = dates.map((_, i) => {
          const kmVal = km[i] || 0;
          const kwhVal = kwh[i] || 0;
          return kmVal > 0 ? (kwhVal / kmVal * 100) : 0;
        });
        yLabel = 'kWh/100km';
        break;
      }
      case 'cumulativeKm': {
        const km = data.daily_km || [];
        let cum = 0;
        values = km.map(v => { cum += (v || 0); return cum; });
        yLabel = 'km';
        color = '#2563eb';
        break;
      }
      default: {
        values = data.daily_kwh || data.daily_total_kwh || [];
        yLabel = 'kWh';
      }
    }

    const labels = dates.map((d: string) => {
      try { return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
      catch { return d; }
    });

    const windowSize = Math.min(7, Math.max(2, Math.floor(values.length / 3)));
    const ma = movingAverage(values, windowSize);

    return { labels, values, ma, yLabel, color };
  }, [data, chartType]);

  const { labels, values, ma, yLabel, color } = chartConfig;

  if (labels.length < 2 || values.every(v => v === 0)) {
    return <div className="overview-page__trend-card"><h3 className="overview-page__trend-title">{title}</h3><div className="overview-page__empty-trend">Nicht genug Daten</div></div>;
  }

  return (
    <div className="overview-page__trend-card">
      <h3 className="overview-page__trend-title">{title}</h3>
      <div className="overview-page__trend-chart-container">
        <Line
          data={{
            labels,
            datasets: [
              {
                label: yLabel,
                data: values,
                borderColor: color,
                backgroundColor: `${color}1a`,
                borderWidth: 2,
                pointRadius: 2,
                pointBackgroundColor: color,
                tension: 0.3,
                fill: true,
                order: 2,
              },
              {
                label: `MW (${Math.min(7, Math.max(2, Math.floor(labels.length / 3)))})`,
                data: ma,
                borderColor: '#f59e0b',
                borderWidth: 2,
                borderDash: [5, 3],
                pointRadius: 0,
                tension: 0.3,
                fill: false,
                order: 1,
              },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } },
              tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}` } },
            },
            scales: {
              x: { display: true, grid: { display: false }, ticks: { maxRotation: 45, font: { size: 9 }, maxTicksLimit: 10 } },
              y: { beginAtZero: chartType !== 'cumulativeKm', grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 9 } } },
            },
          }}
        />
      </div>
    </div>
  );
}

/* ===== MonthlyComparison ===== */
interface MonthlyRow {
  monthKey: string;
  monthLabel: string;
  energy_kwh: number;
  pv_pct: number | null;
  distance_km: number;
  prev_energy_diff: number | null;
  prev_pv_diff: number | null;
  prev_distance_diff: number | null;
}

function MonthlyComparison({ sessions, statsData }: { sessions: Session[]; statsData?: StatisticsKPIs | null }) {
  const rows = useMemo<MonthlyRow[]>(() => {
    // Try to use daily data from statistics for real PV and km values
    const dailyDates = statsData?.daily_dates || [];
    const dailyKm = statsData?.daily_km || [];
    const dailyKwh = statsData?.daily_kwh || [];

    // Aggregate by month from daily data
    const byMonth = new Map<string, { energy: number; pv: number; km: number }>();

    // Use daily km/kwh from statistics if available
    if (dailyDates.length > 0 && dailyDates.length === dailyKm.length) {
      for (let i = 0; i < dailyDates.length; i++) {
        const monthKey = dailyDates[i].slice(0, 7);
        const entry = byMonth.get(monthKey) || { energy: 0, pv: 0, km: 0 };
        entry.energy += dailyKwh[i] || 0;
        entry.km += dailyKm[i] || 0;
        byMonth.set(monthKey, entry);
      }
    } else {
      // Fallback: aggregate from sessions
      for (const s of sessions) {
        if (!s.date) continue;
        const monthKey = s.date.slice(0, 7);
        const entry = byMonth.get(monthKey) || { energy: 0, pv: 0, km: 0 };
        entry.energy += s.energy_kwh || 0;
        entry.pv += s.pv_kwh || 0;
        entry.km += s.distance_km || 0;
        byMonth.set(monthKey, entry);
      }
    }

    const sorted = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));

    return sorted.map(([monthKey, data], i) => {
      const [y, m] = monthKey.split('-');
      const monthLabel = new Date(parseInt(y), parseInt(m) - 1).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
      const pv_pct = data.energy > 0 ? (data.pv / data.energy) * 100 : null;
      const prev = i > 0 ? sorted[i - 1][1] : null;

      return {
        monthKey,
        monthLabel,
        energy_kwh: data.energy,
        pv_pct,
        distance_km: data.km,
        prev_energy_diff: prev ? data.energy - prev.energy : null,
        prev_pv_diff: prev && prev.energy > 0 ? (pv_pct ?? 0) - ((prev.pv / prev.energy) * 100) : null,
        prev_distance_diff: prev ? data.km - prev.km : null,
      };
    }).reverse();
  }, [sessions]);

  if (rows.length === 0) {
    return <div className="overview-page__monthly-empty">Keine Monatsdaten verfügbar</div>;
  }

  const formatChange = (diff: number | null, unit: string): React.ReactNode => {
    if (diff === null) return <span className="monthly-change monthly-change--neutral">—</span>;
    const up = diff >= 0;
    return (
      <span className={`monthly-change ${up ? 'monthly-change--up' : 'monthly-change--down'}`}>
        {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
        {' '}{Math.abs(diff).toLocaleString('de-DE', { maximumFractionDigits: 1 })} {unit}
      </span>
    );
  };

  return (
    <div className="monthly-comparison">
      <h3 className="overview-page__sessions-subtitle">Monatsvergleich</h3>
      <div className="monthly-comparison__wrapper">
        <table className="monthly-comparison__table">
          <thead>
            <tr>
              <th>Monat</th>
              <th className="text-end">kWh</th>
              <th className="text-end">%PV</th>
              <th className="text-end">km</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.monthKey}>
                <td className="monthly-comparison__month">{r.monthLabel}</td>
                <td className="text-end">
                  {r.energy_kwh.toFixed(1)}
                  <div className="monthly-change-row">{formatChange(r.prev_energy_diff, 'kWh')}</div>
                </td>
                <td className="text-end">
                  {r.pv_pct !== null ? `${r.pv_pct.toFixed(1)} %` : '—'}
                  <div className="monthly-change-row">{formatChange(r.prev_pv_diff, '%')}</div>
                </td>
                <td className="text-end">
                  {r.distance_km.toFixed(0)}
                  <div className="monthly-change-row">{formatChange(r.prev_distance_diff, 'km')}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}