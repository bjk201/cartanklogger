import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TrendingUp, TrendingDown, DollarSign, Zap, Hash, ChevronLeft, ChevronRight, BarChart2, Activity, ArrowUpRight, ArrowDownRight, MapPin, Minus, BarChart, BarChart3 } from 'lucide-react';
import { LoadingState, ErrorState, EmptyState } from '../components/StateViews';
import { api, type StatisticsResponse, type StatisticsKPIs, type SourceBreakdown } from '../lib/apiClient';
import './StatisticsPage.css';

const RANGE_OPTIONS = [
  { value: '7d', label: '7 Tage' },
  { value: '30d', label: '30 Tage' },
  { value: '90d', label: '90 Tage' },
  { value: '365d', label: '365 Tage' },
  { value: 'all', label: 'Alles' },
  { value: 'custom', label: 'Benutzerdefiniert…' },
] as const;

type RangeValue = '7d' | '30d' | '90d' | '365d' | 'all' | 'custom';

export function StatisticsPage() {
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<RangeValue>('30d');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');

  const fetchStatistics = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    // Determine API parameters based on selected range
    let days: number | undefined;
    let from_date: string | undefined;
    let to_date: string | undefined;

    if (selectedRange === 'custom') {
      if (customFrom) from_date = customFrom;
      if (customTo) to_date = customTo;
    } else if (selectedRange === 'all') {
      days = 36500; // ~100 years
    } else {
      const option = RANGE_OPTIONS.find(o => o.value === selectedRange);
      if (option?.value) {
        const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
        days = daysMap[option.value];
      }
    }

    try {
      const response: StatisticsResponse = await api.getStatistics(days, from_date, to_date);
      
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

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
    if (value !== 'custom') {
      setShowCustomPicker(false);
      setCustomFrom('');
      setCustomTo('');
    } else {
      setShowCustomPicker(true);
    }
  };

  const handleCustomRangeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customFrom && customTo) {
      fetchStatistics();
    }
  };

  const getRangeLabel = (range: RangeValue): string => {
    if (range === 'custom') {
      if (customFrom && customTo) return `${customFrom} – ${customTo}`;
      return 'Benutzerdefiniert';
    }
    const option = RANGE_OPTIONS.find(o => o.value === range);
    return option?.label || range;
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

  const formatKWh = (num: number): string => {
    return num.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  };

  const formatEur = (num: number): string => {
    return num.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  };

  const formatCostPerKWh = (num: number | null): string => {
    if (num === null || num === undefined) return '—';
    return num.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) + ' €/kWh';
  };

  const getPercentage = (value: number, total: number): number => {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
  };

  if (loading) {
    return <LoadingState message="Statistiken werden geladen…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={fetchStatistics} />;
  }

  if (!data) {
    return <EmptyState title="Keine Daten" message="Keine statistischen Daten verfügbar." />;
  }

  const { kpis, energy_by_source, cost_by_source, sessions_by_source, range_label } = data;

  return (
    <div className="page-container">
      <div className="statistics-page">
        <header className="statistics-page__header">
          <div>
            <h1 className="statistics-page__title">Statistik</h1>
            <p className="statistics-page__subtitle">
              Auswertung der Ladevorgänge · <span className="statistics-page__range-badge">{getRangeLabel(selectedRange)}</span>
            </p>
          </div>
          <div className="statistics-page__range-selector">
            <label htmlFor="range-select" className="sr-only">Zeitraum</label>
            <select
              id="range-select"
              value={selectedRange}
              onChange={(e) => handleRangeChange(e.target.value as RangeValue)}
              className="statistics-page__range-select"
            >
              {RANGE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {showCustomPicker && (
              <form onSubmit={handleCustomRangeSubmit} className="statistics-page__custom-range">
                <div className="statistics-page__date-inputs">
                  <div className="statistics-page__date-input-group">
                    <label htmlFor="custom-from" className="statistics-page__date-label">Von</label>
                    <input
                      id="custom-from"
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="statistics-page__date-input"
                      max={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                  <div className="statistics-page__date-input-group">
                    <label htmlFor="custom-to" className="statistics-page__date-label">Bis</label>
                    <input
                      id="custom-to"
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="statistics-page__date-input"
                      max={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                </div>
                <div className="statistics-page__custom-actions">
                  <button type="submit" className="statistics-page__apply-btn">Anwenden</button>
                  <button type="button" onClick={() => handleRangeChange('30d')} className="statistics-page__cancel-btn">
                    Abbrechen
                  </button>
                </div>
              </form>
            )}
          </div>
        </header>

        {/* KPI Cards */}
        <section className="statistics-page__section" aria-labelledby="kpis-heading">
          <h2 id="kpis-heading" className="statistics-page__section-title">Kennzahlen</h2>
          <div className="statistics-page__kpi-grid">
            <article className="kpi-card">
              <div className="kpi-card__icon" aria-hidden="true">
                <Zap size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Gesamt geladen</span>
                <span className="kpi-card__value">{formatKWh(kpis.total_energy_kwh)} kWh</span>
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
                <span className="kpi-card__value">{formatCostPerKWh(kpis.avg_cost_per_kwh)}</span>
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

            {/* NEU: Ladeverlust-Kachel */}
            <article className="kpi-card">
              <div className="kpi-card__icon kpi-card__icon--loss" aria-hidden="true">
                <Activity size={24} />
              </div>
              <div className="kpi-card__content">
                <span className="kpi-card__label">Ladeverlust</span>
                <span className="kpi-card__value">
                  {kpis.charging_losses_kwh !== null && kpis.charging_losses_pct !== null ? (
                    <>
                      <span className="kpi-card__value-main">{formatKWh(Math.abs(kpis.charging_losses_kwh))} kWh</span>
                      <span className="kpi-card__value-sub">
                        {kpis.charging_losses_kwh >= 0 ? <ArrowUpRight size={12} className="kpi-card__loss-positive" /> : <ArrowDownRight size={12} className="kpi-card__loss-negative" />}
                        {Math.abs(kpis.charging_losses_pct).toFixed(1)}%
                      </span>
                    </>
                  ) : (
                    '—'
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
                  {kpis.external_dc_sessions !== null && kpis.external_ac_sessions !== null ? (
                    <>
                      <span className="kpi-card__value-main">
                        DC: {kpis.external_dc_sessions} · AC: {kpis.external_ac_sessions}
                      </span>
                      <span className="kpi-card__value-sub">
                        {kpis.external_dc_energy_kwh !== null && kpis.external_ac_energy_kwh !== null && (
                          <>
                            DC: {formatKWh(kpis.external_dc_energy_kwh)} kWh · AC: {formatKWh(kpis.external_ac_energy_kwh)} kWh
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
                  {kpis.external_charging_losses_kwh !== null && kpis.external_charging_losses_pct !== null ? (
                    <>
                      <span className="kpi-card__value-main">{formatKWh(Math.abs(kpis.external_charging_losses_kwh))} kWh</span>
                      <span className="kpi-card__value-sub">
                        {kpis.external_charging_losses_kwh >= 0 ? <ArrowUpRight size={12} className="kpi-card__loss-positive" /> : <ArrowDownRight size={12} className="kpi-card__loss-negative" />}
                        {Math.abs(kpis.external_charging_losses_pct).toFixed(1)}%
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

        {/* Pro Session */}
        <section className="statistics-page__section" aria-labelledby="session-stats-heading">
          <h2 id="session-stats-heading" className="statistics-page__section-title">Pro Session</h2>
          <div className="statistics-page__session-stats-grid">
            <article className="session-stat-card">
              <span className="session-stat-card__label">Ø Energie / Session</span>
              <span className="session-stat-card__value">
                {kpis.avg_energy_per_session !== null ? formatKWh(kpis.avg_energy_per_session) + ' kWh' : '—'}
              </span>
            </article>

            <article className="session-stat-card">
              <span className="session-stat-card__label">Ø Kosten / Session</span>
              <span className="session-stat-card__value">
                {kpis.avg_cost_per_session !== null ? formatEur(kpis.avg_cost_per_session) : '—'}
              </span>
            </article>

            <article className="session-stat-card">
              <span className="session-stat-card__label">Größte Session (kWh)</span>
              <span className="session-stat-card__value">
                {kpis.max_energy_session !== null ? formatKWh(kpis.max_energy_session) + ' kWh' : '—'}
                {kpis.max_energy_session_id && (
                  <span className="session-stat-card__id">ID: {kpis.max_energy_session_id}</span>
                )}
              </span>
            </article>

            <article className="session-stat-card">
              <span className="session-stat-card__label">Teuerste Session</span>
              <span className="session-stat-card__value">
                {kpis.max_cost_session !== null ? formatEur(kpis.max_cost_session) : '—'}
                {kpis.max_cost_session_id && (
                  <span className="session-stat-card__id">ID: {kpis.max_cost_session_id}</span>
                )}
              </span>
            </article>
          </div>
        </section>

        {/* Daily Drives Chart */}
        {(kpis.daily_dates && kpis.daily_dates.length > 0) && (
          <section className="statistics-page__section" aria-labelledby="daily-drives-heading">
            <div className="statistics-page__chart-header">
              <h2 id="daily-drives-heading" className="statistics-page__section-title">Tägliche Fahrten (TeslaMate)</h2>
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
              <DailyDrivesChart 
                dates={kpis.daily_dates} 
                km={kpis.daily_km} 
                kwh={kpis.daily_kwh}
                type={chartType}
              />
            </div>
          </section>
        )}

        {/* Daily Charged Energy Chart */}
        {(kpis.daily_charged_dates && kpis.daily_charged_dates.length > 0) && (
          <section className="statistics-page__section" aria-labelledby="daily-charged-heading">
            <h2 id="daily-charged-heading" className="statistics-page__section-title">Täglich geladene Energie</h2>
            <div className="statistics-page__chart-container">
              <DailyChargedChart 
                dates={kpis.daily_charged_dates} 
                home_kwh={kpis.daily_home_kwh} 
                external_kwh={kpis.daily_external_kwh}
                total_kwh={kpis.daily_total_kwh}
              />
            </div>
          </section>
        )}

        {/* Energy Distribution */}
        <section className="statistics-page__section" aria-labelledby="energy-dist-heading">
          <h2 id="energy-dist-heading" className="statistics-page__section-title">Energie-Verteilung (kWh)</h2>
          <div className="statistics-page__distribution-grid">
            <article className="distribution-card distribution-card--home">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Home (EVCC)</span>
                <span className="distribution-card__percentage">{getPercentage(energy_by_source.home, energy_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--home"
                  style={{ width: `${getPercentage(energy_by_source.home, energy_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{formatKWh(energy_by_source.home)} kWh</span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--external">
              <header className="distribution-card__header">
                <span className="distribution-card__source">External (TeslaMate)</span>
                <span className="distribution-card__percentage">{getPercentage(energy_by_source.external, energy_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--external"
                  style={{ width: `${getPercentage(energy_by_source.external, energy_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{formatKWh(energy_by_source.external)} kWh</span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--import">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Import</span>
                <span className="distribution-card__percentage">{getPercentage(energy_by_source.import, energy_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--import"
                  style={{ width: `${getPercentage(energy_by_source.import, energy_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{formatKWh(energy_by_source.import)} kWh</span>
              </footer>
            </article>
          </div>
        </section>

        {/* Cost Distribution */}
        <section className="statistics-page__section" aria-labelledby="cost-dist-heading">
          <h2 id="cost-dist-heading" className="statistics-page__section-title">Kosten-Verteilung</h2>
          <div className="statistics-page__distribution-grid">
            <article className="distribution-card distribution-card--home">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Home (EVCC)</span>
                <span className="distribution-card__percentage">{getPercentage(cost_by_source.home, cost_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--home"
                  style={{ width: `${getPercentage(cost_by_source.home, cost_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{formatEur(cost_by_source.home)}</span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--external">
              <header className="distribution-card__header">
                <span className="distribution-card__source">External (TeslaMate)</span>
                <span className="distribution-card__percentage">{getPercentage(cost_by_source.external, cost_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--external"
                  style={{ width: `${getPercentage(cost_by_source.external, cost_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{formatEur(cost_by_source.external)}</span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--import">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Import</span>
                <span className="distribution-card__percentage">{getPercentage(cost_by_source.import, cost_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--import"
                  style={{ width: `${getPercentage(cost_by_source.import, cost_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{formatEur(cost_by_source.import)}</span>
              </footer>
            </article>
          </div>
        </section>

        {/* Sessions Distribution */}
        <section className="statistics-page__section" aria-labelledby="sessions-dist-heading">
          <h2 id="sessions-dist-heading" className="statistics-page__section-title">Sessions-Verteilung</h2>
          <div className="statistics-page__distribution-grid">
            <article className="distribution-card distribution-card--home">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Home (EVCC)</span>
                <span className="distribution-card__percentage">{getPercentage(sessions_by_source.home, sessions_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--home"
                  style={{ width: `${getPercentage(sessions_by_source.home, sessions_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{sessions_by_source.home.toFixed(0)} Sessions</span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--external">
              <header className="distribution-card__header">
                <span className="distribution-card__source">External (TeslaMate)</span>
                <span className="distribution-card__percentage">{getPercentage(sessions_by_source.external, sessions_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--external"
                  style={{ width: `${getPercentage(sessions_by_source.external, sessions_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{sessions_by_source.external.toFixed(0)} Sessions</span>
              </footer>
            </article>

            <article className="distribution-card distribution-card--import">
              <header className="distribution-card__header">
                <span className="distribution-card__source">Import</span>
                <span className="distribution-card__percentage">{getPercentage(sessions_by_source.import, sessions_by_source.total)}%</span>
              </header>
              <div className="distribution-card__bar">
                <div 
                  className="distribution-card__fill distribution-card__fill--import"
                  style={{ width: `${getPercentage(sessions_by_source.import, sessions_by_source.total)}%` }}
                />
              </div>
              <footer className="distribution-card__footer">
                <span className="distribution-card__value">{sessions_by_source.import.toFixed(0)} Sessions</span>
              </footer>
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}

// Daily Drives Chart Component
interface DailyDrivesChartProps {
  dates: string[];
  km: number[];
  kwh: number[];
  type: 'line' | 'bar';
}

function DailyDrivesChart({ dates, km, kwh, type }: DailyDrivesChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Set canvas size for high DPI
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const width = rect.width;
      const height = rect.height;
      const padding = { top: 30, right: 60, bottom: 50, left: 60 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = height - padding.top - padding.bottom;

      // Clear
      ctx.clearRect(0, 0, width, height);

      // Find max values for scaling
      const maxKm = Math.max(...km, 0);
      const maxKwh = Math.max(...kwh, 0);
      const maxKmScaled = maxKm > 0 ? maxKm * 1.1 : 10;
      const maxKwhScaled = maxKwh > 0 ? maxKwh * 1.1 : 10;

      // Draw grid lines and Y-axis labels
      ctx.strokeStyle = '#e0e0e0';
      ctx.font = '13px system-ui';
      ctx.fillStyle = '#444';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      // Grid lines (5 horizontal lines)
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();

        // Left Y-axis (km)
        const kmVal = maxKmScaled * (1 - i / 4);
        ctx.fillText(kmVal.toFixed(1) + ' km', padding.left - 10, y);

        // Right Y-axis (kWh)
        const kwhVal = maxKwhScaled * (1 - i / 4);
        ctx.fillText(kwhVal.toFixed(1) + ' kWh', width - padding.right + 10, y);
      }

      // X-axis labels (dates)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '12px system-ui';
      ctx.fillStyle = '#444';
      const step = Math.max(1, Math.floor(dates.length / 10)); // Show max ~10 labels
      dates.forEach((date, i) => {
        if (i % step === 0 || i === dates.length - 1) {
          const x = padding.left + (chartWidth / (dates.length - 1)) * i;
          ctx.fillText(date.slice(5), x, height - padding.bottom + 8); // MM-DD format
        }
      });

      const barWidth = dates.length > 1 ? (chartWidth / (dates.length - 1)) * 0.6 : chartWidth * 0.6;
      const barOffset = dates.length > 1 ? (chartWidth / (dates.length - 1)) * 0.2 : 0;

      if (type === 'bar') {
        // Draw km bars (blue)
        ctx.fillStyle = '#3b82f6';
        km.forEach((val, i) => {
          const x = padding.left + (chartWidth / (dates.length - 1)) * i - barWidth / 2 + barOffset;
          const barHeight = (val / maxKmScaled) * chartHeight;
          const y = padding.top + chartHeight - barHeight;
          ctx.fillRect(x, y, barWidth, barHeight);
        });

        // Draw kWh bars (orange) - offset to the right
        ctx.fillStyle = '#f59e0b';
        kwh.forEach((val, i) => {
          const x = padding.left + (chartWidth / (dates.length - 1)) * i + barWidth / 2 + barOffset;
          const barHeight = (val / maxKwhScaled) * chartHeight;
          const y = padding.top + chartHeight - barHeight;
          ctx.fillRect(x, y, barWidth, barHeight);
        });
      } else {
        // Draw km line (blue)
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        km.forEach((val, i) => {
          const x = padding.left + (chartWidth / (dates.length - 1)) * i;
          const y = padding.top + chartHeight * (1 - val / maxKmScaled);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Draw kWh line (orange)
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        kwh.forEach((val, i) => {
          const x = padding.left + (chartWidth / (dates.length - 1)) * i;
          const y = padding.top + chartHeight * (1 - val / maxKwhScaled);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      // Legend
      ctx.font = '13px system-ui';
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(padding.left, padding.top - 22, 14, 14);
      ctx.fillStyle = '#333';
      ctx.textAlign = 'left';
      ctx.fillText('km', padding.left + 20, padding.top - 10);

      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(padding.left + 60, padding.top - 22, 14, 14);
      ctx.fillStyle = '#333';
      ctx.fillText('kWh', padding.left + 78, padding.top - 10);

    }, [dates, km, kwh, type]);

  return (
    <canvas 
      ref={canvasRef} 
      className="statistics-page__chart-canvas"
      width={800} 
      height={300}
      role="img"
      aria-label={`Tägliche Fahrten: ${dates.length} Tage, km und kWh (${type === 'line' ? 'Linien' : 'Balken'})`}
    />
  );
}

// Daily Charged Energy Chart Component
interface DailyChargedChartProps {
  dates: string[];
  home_kwh: number[];
  external_kwh: number[];
  total_kwh: number[];
}

function DailyChargedChart({ dates, home_kwh, external_kwh, total_kwh }: DailyChargedChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size for high DPI
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 30, right: 60, bottom: 50, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Find max values for scaling
    const maxTotal = Math.max(...total_kwh, 0);
    const maxTotalScaled = maxTotal > 0 ? maxTotal * 1.1 : 10;

    // Draw grid lines and Y-axis labels
    ctx.strokeStyle = '#e0e0e0';
    ctx.font = '13px system-ui';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // Grid lines (5 horizontal lines)
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartHeight / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // Y-axis (kWh)
      const kwhVal = maxTotalScaled * (1 - i / 4);
      ctx.fillText(kwhVal.toFixed(1) + ' kWh', padding.left - 10, y);
    }

    // X-axis labels (dates)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '12px system-ui';
    ctx.fillStyle = '#444';
    const step = Math.max(1, Math.floor(dates.length / 10));
    dates.forEach((date, i) => {
      if (i % step === 0 || i === dates.length - 1) {
        const x = padding.left + (chartWidth / (dates.length - 1)) * i;
        ctx.fillText(date.slice(5), x, height - padding.bottom + 8);
      }
    });

    const barWidth = dates.length > 1 ? (chartWidth / (dates.length - 1)) * 0.7 : chartWidth * 0.7;

    // Draw stacked bars: Home (bottom) + External (top)
    // Home bars (green)
    ctx.fillStyle = '#22c55e';
    home_kwh.forEach((val, i) => {
      const x = padding.left + (chartWidth / (dates.length - 1)) * i - barWidth / 2;
      const barHeight = (val / maxTotalScaled) * chartHeight;
      const y = padding.top + chartHeight - barHeight;
      ctx.fillRect(x, y, barWidth, barHeight);
    });

    // External bars (blue) stacked on top
    ctx.fillStyle = '#3b82f6';
    external_kwh.forEach((val, i) => {
      const x = padding.left + (chartWidth / (dates.length - 1)) * i - barWidth / 2;
      const barHeight = (val / maxTotalScaled) * chartHeight;
      const homeHeight = (home_kwh[i] / maxTotalScaled) * chartHeight;
      const y = padding.top + chartHeight - homeHeight - barHeight;
      ctx.fillRect(x, y, barWidth, barHeight);
    });

    // Total line (orange) on top
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    total_kwh.forEach((val, i) => {
      const x = padding.left + (chartWidth / (dates.length - 1)) * i;
      const y = padding.top + chartHeight * (1 - val / maxTotalScaled);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Legend
    ctx.font = '13px system-ui';
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(padding.left, padding.top - 22, 14, 14);
    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    ctx.fillText('Home', padding.left + 20, padding.top - 10);

    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(padding.left + 70, padding.top - 22, 14, 14);
    ctx.fillStyle = '#333';
    ctx.fillText('Extern', padding.left + 90, padding.top - 10);

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(padding.left + 140, padding.top - 15);
    ctx.lineTo(padding.left + 160, padding.top - 15);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.fillText('Gesamt', padding.left + 170, padding.top - 10);

  }, [dates, home_kwh, external_kwh, total_kwh]);

  return (
    <canvas 
      ref={canvasRef} 
      className="statistics-page__chart-canvas"
      width={800} 
      height={300}
      role="img"
      aria-label={`Täglich geladene Energie: ${dates.length} Tage, Home/Extern/Gesamt kWh`}
    />
  );
}