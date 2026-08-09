import React, { useState, useCallback } from 'react';
import { useTheme } from '../app/ThemeContext';
import { useTimeRange } from '../app/TimeRangeContext';
import { Sun, Moon, Menu, RefreshCw, Calendar, X } from 'lucide-react';
import { api } from '../lib/apiClient';
import './TopBar.css';

const RANGE_OPTIONS = [
  { value: '7d', label: '7 Tage' },
  { value: '30d', label: '30 Tage' },
  { value: '90d', label: '90 Tage' },
  { value: '365d', label: '365 Tage' },
  { value: 'all', label: 'Alles' },
  { value: 'custom', label: 'Benutzerdefiniert…' },
] as const;

type RangeValue = '7d' | '30d' | '90d' | '365d' | 'all' | 'custom';

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const { theme, toggleTheme } = useTheme();
  const { selectedRange, setSelectedRange, customFrom, setCustomFrom, customTo, setCustomTo, showCustomPicker, setShowCustomPicker, getRangeLabel } = useTimeRange();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState(false);

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
  };

  const handleCustomRangeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customFrom && customTo) {
      setShowCustomPicker(false);
    }
  };

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncSuccess(false);
    try {
      const result = await api.syncDataSources();
      if (result.ok) {
        setSyncSuccess(true);
        setTimeout(() => setSyncSuccess(false), 3000);
      } else {
        setSyncError('Sync fehlgeschlagen');
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync-Fehler');
    } finally {
      setSyncing(false);
    }
  }, []);

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <button
          className="topbar__btn topbar__btn--icon topbar__menu-btn"
          onClick={onMenuClick}
          aria-label="Hauptmenü öffnen"
        >
          <Menu size={24} />
        </button>
        <h1 className="topbar__title">CarTankLogger 2.0</h1>
        <div className="topbar__status" role="status" aria-live="polite">
          <span className="status-indicator status-indicator--connected" aria-hidden="true" />
          <span className="status-text">Backend verbunden</span>
          <span className="status-detail">{getRangeLabel(selectedRange)}</span>
        </div>
      </div>
      <div className="topbar__center">
        <div className="topbar__range-selector">
          <label htmlFor="range-select" className="sr-only">Zeitraum</label>
          <div className="topbar__range-wrapper">
            <select
              id="range-select"
              value={selectedRange}
              onChange={(e) => handleRangeChange(e.target.value as RangeValue)}
              className="topbar__range-select"
            >
              {RANGE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {showCustomPicker && (
              <form onSubmit={handleCustomRangeSubmit} className="topbar__custom-range">
                <div className="topbar__date-inputs">
                  <div className="topbar__date-input-group">
                    <label htmlFor="custom-from" className="topbar__date-label">Von</label>
                    <input
                      id="custom-from"
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="topbar__date-input"
                      max={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                  <div className="topbar__date-input-group">
                    <label htmlFor="custom-to" className="topbar__date-label">Bis</label>
                    <input
                      id="custom-to"
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="topbar__date-input"
                      max={new Date().toISOString().split('T')[0]}
                    />
                  </div>
                </div>
                <div className="topbar__custom-actions">
                  <button type="submit" className="topbar__apply-btn">Anwenden</button>
                  <button type="button" onClick={() => setSelectedRange('30d')} className="topbar__cancel-btn">
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </form>
            )}
          </div>
          <span className="topbar__range-label">{getRangeLabel(selectedRange)}</span>
        </div>
      </div>
      <div className="topbar__right">
        <button
          className={`topbar__btn topbar__btn--icon ${syncing ? 'topbar__btn--syncing' : ''} ${syncSuccess ? 'topbar__btn--sync-success' : ''}`}
          onClick={handleSync}
          disabled={syncing}
          aria-label="Daten synchronisieren"
          title="Sync (EVCC + TeslaMate)"
        >
          <RefreshCw size={20} className={syncing ? 'topbar__sync-spin' : ''} />
        </button>
        {syncError && (
          <span className="topbar__sync-error">{syncError}</span>
        )}
        <button
          className="topbar__btn topbar__btn--icon"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Dark Mode aktivieren' : 'Light Mode aktivieren'}
          title={theme === 'light' ? 'Dark Mode' : 'Light Mode'}
        >
          {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
        </button>
      </div>
    </header>
  );
}