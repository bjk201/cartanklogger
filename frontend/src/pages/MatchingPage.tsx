import React, { useState, useEffect, useCallback } from 'react';
import { Save, Wifi, AlertCircle, CheckCircle, Loader2, Shield, Eye, EyeOff, RefreshCw, Link, MinusCircle, PlusCircle, ArrowRight, HelpCircle, Table, List, ChevronRight, ChevronDown, Database, Server, Globe, Wifi as WifiIcon, AlertTriangle } from 'lucide-react';
import { api } from '../lib/apiClient';
import type { 
  MatchingDryRunResponse, 
  EVCCSessionMatch, 
  MatchedCharge,
  MatchingRawDataResponse,
  EVCCRawSession,
  TMRawCharge,
  LiveMatchingDryRunResponse,
  LiveEVCCSessionMatch,
  LiveMatchedCharge,
  LiveMatchingStatusResponse
} from '../types/api';
import './MatchingPage.css';

const MatchingPage: React.FC = () => {
  const [dryRun, setDryRun] = useState<MatchingDryRunResponse | null>(null);
  const [liveDryRun, setLiveDryRun] = useState<LiveMatchingDryRunResponse | null>(null);
  const [rawData, setRawData] = useState<MatchingRawDataResponse | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveMatchingStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawLoading, setRawLoading] = useState(false);
  const [liveLoading, setLiveLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [selectedTmCharge, setSelectedTmCharge] = useState<MatchedCharge | LiveMatchedCharge | null>(null);
  const [selectedEvccSession, setSelectedEvccSession] = useState<EVCCSessionMatch | LiveEVCCSessionMatch | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideSuccess, setOverrideSuccess] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const [showOnlyWithOverrides, setShowOnlyWithOverrides] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [viewMode, setViewMode] = useState<'summary' | 'raw' | 'live'>('live');
  const [dataSource, setDataSource] = useState<'database' | 'live'>('live');

  const fetchDryRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getMatchingDryRun(limit);
      if (!response.ok) throw new Error('API Error');
      setDryRun(response);
      setDataSource('database');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  const fetchLiveDryRun = useCallback(async () => {
    setLiveLoading(true);
    setError(null);
    try {
      const response = await api.getMatchingDryRunLive(limit);
      setLiveDryRun(response);
      setDataSource('live');
      if (!response.ok) {
        setError(response.error || 'Live-Matching fehlgeschlagen');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden der Live-Daten');
    } finally {
      setLiveLoading(false);
    }
  }, [limit]);

  const fetchLiveStatus = useCallback(async () => {
    try {
      const response = await api.getMatchingLiveStatus();
      setLiveStatus(response);
    } catch (err) {
      console.error('Live status check failed:', err);
    }
  }, []);

  const fetchRawData = useCallback(async () => {
    setRawLoading(true);
    try {
      const response = await api.getMatchingRawData(limit);
      if (!response.ok) throw new Error('API Error');
      setRawData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden der Originaldaten');
    } finally {
      setRawLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchLiveStatus();
  }, [fetchLiveStatus]);

  useEffect(() => {
    if (viewMode === 'live') {
      fetchLiveDryRun();
    } else if (viewMode === 'summary') {
      fetchDryRun();
    }
  }, [viewMode, fetchLiveDryRun, fetchDryRun]);

  useEffect(() => {
    if (viewMode === 'raw') {
      fetchRawData();
    }
  }, [viewMode, fetchRawData]);

  const handleCreateOverride = async (tmCharge: MatchedCharge, evccSession: EVCCSessionMatch) => {
    if (!overrideReason.trim()) {
      setOverrideError('Grund eingeben');
      return;
    }
    setSaving(`create-${tmCharge.charge_id}`);
    setOverrideError(null);
    setOverrideSuccess(null);
    try {
      const response = await api.createMatchingOverride({
        teslamate_charge_id: tmCharge.charge_id,
        evcc_session_id: evccSession.evcc_session_id,
        override_type: 'manual_assign',
        reason: overrideReason.trim(),
      });
      if (!response.ok) throw new Error('API Error');
      setOverrideSuccess(`TM ${tmCharge.charge_id} → EVCC ${evccSession.evcc_session_id} zugewiesen`);
      setOverrideReason('');
      setSelectedTmCharge(null);
      setSelectedEvccSession(null);
      fetchDryRun();
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      setSaving(null);
    }
  };

  const handleDeleteOverride = async (overrideId: number, tmChargeId: number) => {
    if (!window.confirm('Override wirklich zurücksetzen? (Zurück auf Auto-Matching)')) return;
    setSaving(`delete-${tmChargeId}`);
    setOverrideError(null);
    setOverrideSuccess(null);
    try {
      const response = await api.deleteMatchingOverride(overrideId);
      if (!response.ok) throw new Error('API Error');
      setOverrideSuccess(`Override für TM ${tmChargeId} zurückgesetzt`);
      fetchDryRun();
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Fehler beim Zurücksetzen');
    } finally {
      setSaving(null);
    }
  };

  const openAssignModal = (tmCharge: MatchedCharge, evccSession: EVCCSessionMatch) => {
    setSelectedTmCharge(tmCharge);
    setSelectedEvccSession(evccSession);
    setOverrideReason('');
    setOverrideError(null);
    setOverrideSuccess(null);
  };

  const openAssignModalForSkipped = (tmCharge: MatchedCharge) => {
    // Find the EVCC session that has the manual override for this TM charge
    const targetSession = dryRun?.matches.find(m => 
      m.matched_charges.some(c => 
        c.charge_id === tmCharge.charge_id && 
        c.match_source === 'manual_override' && 
        c.accepted_as_candidate
      )
    );
    if (targetSession) {
      openAssignModal(tmCharge, targetSession);
    }
  };

  const closeModal = () => {
    setSelectedTmCharge(null);
    setSelectedEvccSession(null);
    setOverrideReason('');
    setOverrideError(null);
    setOverrideSuccess(null);
  };

  if (loading && viewMode === 'summary') {
    return (
      <div className="matching-page">
        <div className="matching-page__loading">
          <Loader2 className="matching-page__spinner" />
          <p>Matching Dry-Run wird geladen…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="matching-page">
        <div className="matching-page__error">
          <AlertCircle className="matching-page__error-icon" />
          <h2>Fehler</h2>
          <p>{error}</p>
          <button className="btn btn--primary" onClick={viewMode === 'live' ? fetchLiveDryRun : fetchDryRun}>Erneut versuchen</button>
        </div>
      </div>
    );
  }

  if (viewMode === 'summary' && !dryRun) {
    return (
      <div className="matching-page">
        <div className="matching-page__error">
          <AlertCircle className="matching-page__error-icon" />
          <h2>Keine Daten</h2>
          <p>Matching Dry-Run lieferte keine Ergebnisse</p>
        </div>
      </div>
    );
  }

  if (viewMode === 'live' && liveLoading) {
    return (
      <div className="matching-page">
        <div className="matching-page__loading">
          <Loader2 className="matching-page__spinner" />
          <p>Live-Matching wird geladen…</p>
        </div>
      </div>
    );
  }

  const { matches, summary } = dryRun || { matches: [], summary: { total_evcc_sessions_checked: 0, total_matched: 0, total_evcc_energy: 0, total_tm_energy: 0 } };

  // Filter matches
  let filteredMatches = matches;
  if (showOnlyWithOverrides) {
    filteredMatches = matches.filter(m => 
      m.matched_charges.some(c => c.match_source === 'manual_override' || c.skipped_due_to_other_override)
    );
  }

  const allCharges = filteredMatches.flatMap(m => m.matched_charges);
  const manualCharges = allCharges.filter(c => c.match_source === 'manual_override' && c.accepted_as_candidate);
  const skippedCharges = allCharges.filter(c => c.skipped_due_to_other_override);
  const autoCharges = allCharges.filter(c => c.match_source === 'auto' && c.accepted_as_candidate && !c.skipped_due_to_other_override);

  return (
    <div className="matching-page">
      <header className="matching-page__header">
        <h1>Matching & Overrides</h1>
        <p className="matching-page__subtitle">
          EVCC ↔ TeslaMateAPI Zuordnung — Dry-Run mit manueller Korrektur
        </p>
      </header>

      {/* Controls */}
      <div className="matching-page__controls">
        <div className="matching-page__control-group">
          <label htmlFor="limit" className="matching-page__label">Limit</label>
          <select
            id="limit"
            className="matching-page__select"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
        <div className="matching-page__control-group">
          <label className="matching-page__checkbox">
            <input
              type="checkbox"
              checked={showOnlyWithOverrides}
              onChange={(e) => setShowOnlyWithOverrides(e.target.checked)}
            />
            <span>Nur Sessions mit Overrides</span>
          </label>
        </div>
        <div className="matching-page__control-group">
          <label className="matching-page__checkbox">
            <input
              type="checkbox"
              checked={showSkipped}
              onChange={(e) => setShowSkipped(e.target.checked)}
            />
            <span>Skipped Charges anzeigen</span>
          </label>
        </div>
        <div className="matching-page__control-group">
          <label className="matching-page__label">Modus</label>
          <select
            className="matching-page__select"
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value as 'summary' | 'raw' | 'live')}
          >
            <option value="live">Live (EVCC + TeslaMateAPI)</option>
            <option value="summary">Summary (DB)</option>
            <option value="raw">Originaldaten (DB)</option>
          </select>
        </div>
        <button className="btn btn--secondary" onClick={viewMode === 'raw' ? fetchRawData : (viewMode === 'live' ? fetchLiveDryRun : fetchDryRun)}>
          <RefreshCw className="btn__icon" /> {viewMode === 'raw' ? 'Raw-Daten laden' : (viewMode === 'live' ? 'Live laden' : 'Aktualisieren')}
        </button>
      </div>

      {/* Live Status Banner */}
      {liveStatus && viewMode === 'live' && (
        <div className={`matching-page__live-banner ${liveStatus.live_available ? 'matching-page__live-banner--ok' : 'matching-page__live-banner--error'}`}>
          <WifiIcon className="matching-page__live-banner-icon" />
          <span>
            {liveStatus.live_available 
              ? '✅ Live-Modus aktiv — EVCC & TeslaMateAPI erreichbar'
              : `❌ Live nicht verfügbar: ${liveStatus.reason}`}
          </span>
          {liveStatus.live_available && (
            <span className="matching-page__live-banner-detail">
              EVCC: {liveStatus.evcc_reachable ? '✅' : '❌'} | TeslaMateAPI: {liveStatus.teslamateapi_reachable ? '✅' : '❌'}
            </span>
          )}
        </div>
      )}

      {/* Live Error Banner */}
      {liveDryRun && !liveDryRun.ok && viewMode === 'live' && (
        <div className="matching-page__live-banner matching-page__live-banner--error">
          <AlertTriangle className="matching-page__live-banner-icon" />
          <span>{liveDryRun.error || 'Live-Matching fehlgeschlagen'}</span>
          {liveDryRun.config_missing && (
            <a href="/settings" className="matching-page__live-banner-link">Einstellungen konfigurieren</a>
          )}
          {liveDryRun.live_mode && !liveDryRun.config_missing && (
            <span className="matching-page__live-banner-detail">
              EVCC: {liveDryRun.evcc_reachable ? '✅ erreichbar' : '❌ nicht erreichbar'} | 
              TeslaMateAPI: {liveDryRun.teslamateapi_reachable ? '✅ erreichbar' : '❌ nicht erreichbar'}
            </span>
          )}
        </div>
      )}

      {/* Summary (DB-based) - only show in summary view mode */}
      {viewMode === 'summary' && (
        <section className="matching-page__summary">
          <div className="matching-page__summary-grid">
            <div className="matching-page__summary-card">
              <div className="matching-page__summary-value">{summary.total_evcc_sessions_checked}</div>
              <div className="matching-page__summary-label">EVCC Sessions geprüft</div>
            </div>
            <div className="matching-page__summary-card matching-page__summary-card--matched">
              <div className="matching-page__summary-value">{summary.total_matched}</div>
              <div className="matching-page__summary-label">Mit Matches</div>
            </div>
            <div className="matching-page__summary-card matching-page__summary-card--manual">
              <div className="matching-page__summary-value">{manualCharges.length}</div>
              <div className="matching-page__summary-label">Manuelle Overrides</div>
            </div>
            <div className="matching-page__summary-card matching-page__summary-card--skipped">
              <div className="matching-page__summary-value">{skippedCharges.length}</div>
              <div className="matching-page__summary-label">Skipped (anderer Override)</div>
            </div>
            <div className="matching-page__summary-card">
              <div className="matching-page__summary-value">{summary.total_evcc_energy.toFixed(1)}</div>
              <div className="matching-page__summary-label">EVCC Energie (kWh)</div>
            </div>
            <div className="matching-page__summary-card">
              <div className="matching-page__summary-value">{summary.total_tm_energy.toFixed(1)}</div>
              <div className="matching-page__summary-label">TM Energie gematcht (kWh)</div>
            </div>
          </div>
        </section>
      )}

      {/* Live Matching View */}
      {viewMode === 'live' && liveDryRun && (
        <section className="matching-page__live-view">
          <header className="matching-page__live-header">
            <h2>
              <WifiIcon className="matching-page__live-header-icon" />
              Live Matching — EVCC API ↔ TeslaMateAPI
            </h2>
            {liveLoading && (
              <Loader2 className="matching-page__live-spinner" />
            )}
          </header>

          {liveDryRun.ok ? (
            <>
              {/* Summary Cards for Live */}
              <div className="matching-page__live-summary">
                <div className="matching-page__live-summary-card">
                  <div className="matching-page__live-summary-value">{liveDryRun.summary.total_evcc_sessions_checked}</div>
                  <div className="matching-page__live-summary-label">EVCC Sessions (Live)</div>
                </div>
                <div className="matching-page__live-summary-card matching-page__live-summary-card--matched">
                  <div className="matching-page__live-summary-value">{liveDryRun.summary.total_matched}</div>
                  <div className="matching-page__live-summary-label">Mit Matches</div>
                </div>
                <div className="matching-page__live-summary-card matching-page__live-summary-card--manual">
                  <div className="matching-page__live-summary-value">
                    {liveDryRun.matches.flatMap(m => m.matched_charges).filter(c => c.match_source === 'manual_override' && c.accepted_as_candidate).length}
                  </div>
                  <div className="matching-page__live-summary-label">Manuelle Overrides</div>
                </div>
                <div className="matching-page__live-summary-card matching-page__live-summary-card--skipped">
                  <div className="matching-page__live-summary-value">
                    {liveDryRun.matches.flatMap(m => m.matched_charges).filter(c => c.skipped_due_to_other_override).length}
                  </div>
                  <div className="matching-page__live-summary-label">Skipped (anderer Override)</div>
                </div>
                <div className="matching-page__live-summary-card">
                  <div className="matching-page__live-summary-value">{liveDryRun.summary.total_evcc_energy.toFixed(1)}</div>
                  <div className="matching-page__live-summary-label">EVCC Energie (kWh)</div>
                </div>
                <div className="matching-page__live-summary-card">
                  <div className="matching-page__live-summary-value">{liveDryRun.summary.total_tm_energy.toFixed(1)}</div>
                  <div className="matching-page__live-summary-label">TM Energie gematcht (kWh)</div>
                </div>
              </div>

              {/* Matches List - Live */}
              <section className="matching-page__live-matches">
                <h2>Live Matching Details</h2>
                {liveDryRun.matches.length === 0 ? (
                  <p className="matching-page__empty">Keine EVCC Sessions von der Live-API gefunden</p>
                ) : (
                  liveDryRun.matches.map((session) => {
                    const manualMatches = session.matched_charges.filter(c => c.match_source === 'manual_override' && c.accepted_as_candidate);
                    const skippedMatches = showSkipped ? session.matched_charges.filter(c => c.skipped_due_to_other_override) : [];
                    const autoMatches = session.matched_charges.filter(c => c.match_source === 'auto' && c.accepted_as_candidate && !c.skipped_due_to_other_override);
                    const rejectedMatches = session.matched_charges.filter(c => !c.accepted_as_candidate && !c.skipped_due_to_other_override);

                    if (manualMatches.length === 0 && skippedMatches.length === 0 && autoMatches.length === 0 && rejectedMatches.length === 0) {
                      return null;
                    }

                    return (
                      <details key={session.evcc_session_id} className="matching-page__session">
                        <summary className="matching-page__session-summary">
                          <div className="matching-page__session-header">
                            <span className="matching-page__session-id">EVCC #{session.evcc_session_id}</span>
                            <span className="matching-page__session-source">{session.evcc_source_id}</span>
                            <span className="matching-page__session-time">
                              {new Date(session.evcc_start).toLocaleString('de-DE')}
                            </span>
                            <span className="matching-page__session-energy">
                              {session.evcc_energy_kwh?.toFixed(1)} kWh
                            </span>
                            <span className="matching-page__session-location">{session.evcc_location}</span>
                          </div>
                          <div className="matching-page__session-badges">
                            {manualMatches.length > 0 && (
                              <span className="matching-page__badge matching-page__badge--manual">
                                <Link className="matching-page__badge-icon" /> {manualMatches.length} Manual
                              </span>
                            )}
                            {skippedMatches.length > 0 && (
                              <span className="matching-page__badge matching-page__badge--skipped">
                                <MinusCircle className="matching-page__badge-icon" /> {skippedMatches.length} Skipped
                              </span>
                            )}
                            {autoMatches.length > 0 && (
                              <span className="matching-page__badge matching-page__badge--auto">
                                <WifiIcon className="matching-page__badge-icon" /> {autoMatches.length} Auto
                              </span>
                            )}
                            {rejectedMatches.length > 0 && (
                              <span className="matching-page__badge matching-page__badge--rejected">
                                <AlertCircle className="matching-page__badge-icon" /> {rejectedMatches.length} Rejected
                              </span>
                            )}
                          </div>
                        </summary>

                        <div className="matching-page__session-content">
                          {/* Manual Overrides */}
                          {manualMatches.length > 0 && (
                            <div className="matching-page__charge-group">
                              <h4 className="matching-page__group-title matching-page__group-title--manual">
                                <Link className="matching-page__group-icon" /> Manuelle Overrides
                              </h4>
                              {manualMatches.map((charge) => (
                                <div key={charge.charge_id} className="matching-page__charge matching-page__charge--manual">
                                  <div className="matching-page__charge-main">
                                    <span className="matching-page__charge-id">TM #{charge.charge_id}</span>
                                    <span className="matching-page__charge-energy">
                                      {charge.charge_energy_added?.toFixed(1)} kWh (added)
                                      {charge.charge_energy_used != null && charge.charge_energy_used !== charge.charge_energy_added && (
                                        <span className="matching-page__charge-energy-used"> / {charge.charge_energy_used?.toFixed(1)} kWh (used)</span>
                                      )}
                                    </span>
                                    <span className="matching-page__charge-location">{charge.location}</span>
                                    <span className="matching-page__charge-source matching-page__charge-source--manual">
                                      Manual Override
                                    </span>
                                  </div>
                                  <div className="matching-page__charge-meta">
                                    {charge.override_id && (
                                      <span className="matching-page__meta">
                                        Override #{charge.override_id}
                                      </span>
                                    )}
                                    {charge.override_reason && (
                                      <span className="matching-page__meta matching-page__meta--reason">
                                        Grund: {charge.override_reason}
                                      </span>
                                    )}
                                    {charge.replaced_auto_match && (
                                      <span className="matching-page__meta matching-page__meta--replaced">
                                        Ersetzt: {charge.replaced_auto_match}
                                      </span>
                                    )}
                                  </div>
                                  <div className="matching-page__charge-actions">
                                    <button
                                      className="btn btn--ghost btn--small matching-page__btn-reset"
                                      onClick={() => handleDeleteOverride(charge.override_id!, charge.charge_id)}
                                      disabled={saving === `delete-${charge.charge_id}`}
                                    >
                                      {saving === `delete-${charge.charge_id}` ? (
                                        <Loader2 className="btn__icon" size={14} />
                                      ) : (
                                        <>
                                          <RefreshCw className="btn__icon" size={14} />
                                          Zurück auf Auto
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>
                              ))}

                              {/* Summe der Manual Overrides für diese Session */}
                              <div className="matching-page__charge-sums">
                                <span className="matching-page__sum-label">Summe Manual Overrides:</span>
                                <span className="matching-page__sum-value">
                                  Added: {manualMatches.reduce((sum, c) => sum + (c.charge_energy_added || 0), 0).toFixed(1)} kWh
                                  {manualMatches.some(c => c.charge_energy_used != null && c.charge_energy_used !== c.charge_energy_added) && (
                                    <span className="matching-page__sum-separator"> | </span>
                                  )}
                                  {manualMatches.some(c => c.charge_energy_used != null && c.charge_energy_used !== c.charge_energy_added) && (
                                    <span>Used: {manualMatches.reduce((sum, c) => sum + (c.charge_energy_used || 0), 0).toFixed(1)} kWh</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Skipped Charges */}
                          {skippedMatches.length > 0 && (
                            <div className="matching-page__charge-group">
                              <h4 className="matching-page__group-title matching-page__group-title--skipped">
                                <MinusCircle className="matching-page__group-icon" /> Skipped (Override bei anderer EVCC-Session)
                              </h4>
                              {skippedMatches.map((charge) => (
                                <div key={charge.charge_id} className="matching-page__charge matching-page__charge--skipped">
                                  <div className="matching-page__charge-main">
                                    <span className="matching-page__charge-id">TM #{charge.charge_id}</span>
                                    <span className="matching-page__charge-energy">{charge.energy_kwh?.toFixed(1)} kWh</span>
                                    <span className="matching-page__charge-location">{charge.location}</span>
                                    <span className="matching-page__charge-source matching-page__charge-source--skipped">
                                      Übersprungen
                                    </span>
                                  </div>
                                  <div className="matching-page__charge-meta">
                                    <span className="matching-page__meta matching-page__meta--skipped">
                                      Diese Charge hat einen manuellen Override für eine andere EVCC-Session.
                                      Auto-Matching wird hier übersprungen.
                                    </span>
                                  </div>
                                  <div className="matching-page__charge-actions">
                                    <button
                                      className="btn btn--ghost btn--small matching-page__btn-reassign"
                                      onClick={() => openAssignModalForSkipped(charge as any)}
                                    >
                                      <ArrowRight className="btn__icon" size={14} />
                                      Hierher umhängen
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Auto Matches */}
                          {autoMatches.length > 0 && (
                            <div className="matching-page__charge-group">
                              <h4 className="matching-page__group-title matching-page__group-title--auto">
                                <WifiIcon className="matching-page__group-icon" /> Auto-Matches
                              </h4>
                              {autoMatches.map((charge) => (
                                <div key={charge.charge_id} className="matching-page__charge matching-page__charge--auto">
                                  <div className="matching-page__charge-main">
                                    <span className="matching-page__charge-id">TM #{charge.charge_id}</span>
                                    <span className="matching-page__charge-energy">
                                      {charge.charge_energy_added?.toFixed(1)} kWh (added)
                                      {charge.charge_energy_used != null && charge.charge_energy_used !== charge.charge_energy_added && (
                                        <span className="matching-page__charge-energy-used"> / {charge.charge_energy_used?.toFixed(1)} kWh (used)</span>
                                      )}
                                    </span>
                                    <span className="matching-page__charge-location">{charge.location}</span>
                                    <span className="matching-page__charge-source matching-page__charge-source--auto">
                                      Auto
                                    </span>
                                  </div>
                                  <div className="matching-page__charge-meta">
                                    <span className="matching-page__meta">
                                      Overlap: {charge.overlap_seconds}s, Containment: {charge.containment}
                                    </span>
                                  </div>
                                  <div className="matching-page__charge-actions">
                                    <button
                                      className="btn btn--ghost btn--small matching-page__btn-assign"
                                      onClick={() => openAssignModal(charge as any, session as any)}
                                    >
                                      <PlusCircle className="btn__icon" size={14} />
                                      Manuell zuordnen
                                    </button>
                                  </div>
                                </div>
                              ))}

                              {/* Summe der Auto-Matches für diese Session */}
                              <div className="matching-page__charge-sums">
                                <span className="matching-page__sum-label">Summe Auto-Matches:</span>
                                <span className="matching-page__sum-value">
                                  Added: {autoMatches.reduce((sum, c) => sum + (c.charge_energy_added || 0), 0).toFixed(1)} kWh
                                  {autoMatches.some(c => c.charge_energy_used != null && c.charge_energy_used !== c.charge_energy_added) && (
                                    <span className="matching-page__sum-separator"> | </span>
                                  )}
                                  {autoMatches.some(c => c.charge_energy_used != null && c.charge_energy_used !== c.charge_energy_added) && (
                                    <span>Used: {autoMatches.reduce((sum, c) => sum + (c.charge_energy_used || 0), 0).toFixed(1)} kWh</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Rejected (collapsed by default) */}
                          {rejectedMatches.length > 0 && (
                            <details className="matching-page__charge-group matching-page__charge-group--collapsed">
                              <summary className="matching-page__group-title matching-page__group-title--rejected">
                                <AlertCircle className="matching-page__group-icon" /> 
                                Abgelehnt (Location: {rejectedMatches[0]?.reject_reason}) — {rejectedMatches.length} Charges
                                <span className="matching-page__reject-hint">(nur für diese EVCC-Session geprüft)</span>
                              </summary>
                              <div className="matching-page__rejected-list">
                                {rejectedMatches.slice(0, 5).map((charge) => (
                                  <div key={charge.charge_id} className="matching-page__rejected-item">
                                    TM #{charge.charge_id} — {charge.charge_energy_added?.toFixed(1)} kWh (added)
                                    {charge.charge_energy_used != null && charge.charge_energy_used !== charge.charge_energy_added && (
                                      <span className="matching-page__charge-energy-used"> / {charge.charge_energy_used?.toFixed(1)} kWh (used)</span>
                                    )}
                                    — {charge.location_normalized}
                                  </div>
                                ))}
                                {rejectedMatches.length > 5 && (
                                  <div className="matching-page__rejected-more">
                                    … und {rejectedMatches.length - 5} weitere
                                  </div>
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                      </details>
                    );
                  })
                )}
              </section>
            </>
          ) : (
            <div className="matching-page__live-error">
              <AlertTriangle className="matching-page__live-error-icon" />
              <p>{liveDryRun.error || 'Live-Matching fehlgeschlagen'}</p>
              {liveDryRun.config_missing && (
                <a href="/settings" className="btn btn--primary">Einstellungen konfigurieren</a>
              )}
            </div>
          )}
        </section>
      )}

      {/* Raw Data View */}
      {viewMode === 'raw' && (
        <section className="matching-page__raw-view">
          <header className="matching-page__raw-header">
            <h2>
              <Database className="matching-page__raw-icon" />
              Originaldaten — EVCC & TeslaMateAPI
            </h2>
            {rawLoading && (
              <Loader2 className="matching-page__raw-spinner" />
            )}
          </header>

          {rawData && (
            <>
              {/* EVCC Sessions */}
              <section className="matching-page__raw-section">
                <h3>
                  <Server className="matching-page__section-icon" />
                  EVCC Sessions (Home) — {rawData.total_evcc} Sessions
                </h3>
                <div className="matching-page__raw-table-container">
                  <table className="matching-page__raw-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Created</th>
                        <th>Location</th>
                        <th>Energy (kWh)</th>
                        <th>Cost (€)</th>
                        <th>€/kWh</th>
                        <th>Cost Source</th>
                        <th>Odometer</th>
                        <th>SoC</th>
                        <th>Vehicle</th>
                        <th>Note</th>
                        <th>Legacy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawData.evcc_sessions.map((evcc) => (
                        <tr key={evcc.evcc_session_id}>
                          <td>#{evcc.evcc_session_id}</td>
                          <td>{evcc.created ? new Date(evcc.created).toLocaleString('de-DE') : '—'}</td>
                          <td>{evcc.location || '—'}</td>
                          <td>{evcc.energy_kwh?.toFixed(1) || '—'}</td>
                          <td>{evcc.cost_eur?.toFixed(2) || '—'}</td>
                          <td>{evcc.cost_per_kwh?.toFixed(4) || '—'}</td>
                          <td>
                            <span className={`matching-page__cost-source matching-page__cost-source--${evcc.cost_per_kwh_source || 'unknown'}`}>
                              {evcc.cost_per_kwh_source || '—'}
                            </span>
                          </td>
                          <td>{evcc.odometer_km?.toLocaleString('de-DE') || '—'}</td>
                          <td>
                            {evcc.soc_start !== null && evcc.soc_end !== null
                              ? `${evcc.soc_start}→${evcc.soc_end}%`
                              : '—'}
                          </td>
                          <td>{evcc.vehicle || '—'}</td>
                          <td className="matching-page__note-cell">{evcc.note || '—'}</td>
                          <td className="matching-page__legacy-cell">
                            {evcc.legacy_source && evcc.legacy_table && evcc.legacy_id
                              ? `${evcc.legacy_source}.${evcc.legacy_table}#${evcc.legacy_id}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* TeslaMate Charges - Home Location */}
              <section className="matching-page__raw-section">
                <h3>
                  <Link className="matching-page__section-icon" />
                  TeslaMateAPI — Zuhause — {rawData.home_tm_charges} Charges
                </h3>
                {rawData.home_tm_charges === 0 ? (
                  <p className="matching-page__raw-empty">Keine TeslaMate-Charges mit Location "Zuhause" gefunden.</p>
                ) : (
                  <div className="matching-page__raw-table-container">
                    <table className="matching-page__raw-table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Start</th>
                          <th>Location (Orig.)</th>
                          <th>Location (Norm.)</th>
                          <th>Energy (kWh)</th>
                          <th>Cost (€)</th>
                          <th>€/kWh</th>
                          <th>Cost Source</th>
                          <th>Odometer</th>
                          <th>SoC</th>
                          <th>Provider</th>
                          <th>Override</th>
                          <th>Legacy</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rawData.teslamate_charges
                          .filter(c => c.is_home_location)
                          .map((tm) => (
                            <tr key={tm.charge_id} className={tm.override ? 'matching-page__raw-row--override' : ''}>
                              <td>#{tm.charge_id}</td>
                              <td>{tm.start_date ? new Date(tm.start_date).toLocaleString('de-DE') : '—'}</td>
                              <td>{tm.location_original || '—'}</td>
                              <td>{tm.location_normalized || '—'}</td>
                              <td>{tm.energy_kwh?.toFixed(1) || '—'}</td>
                              <td>{tm.cost_eur?.toFixed(2) || '—'}</td>
                              <td>{tm.cost_per_kwh?.toFixed(4) || '—'}</td>
                              <td>
                                <span className={`matching-page__cost-source matching-page__cost-source--${tm.cost_per_kwh_source || 'unknown'}`}>
                                  {tm.cost_per_kwh_source || '—'}
                                </span>
                              </td>
                              <td>{tm.odometer_km?.toLocaleString('de-DE') || '—'}</td>
                              <td>
                                {tm.soc_start !== null && tm.soc_end !== null
                                  ? `${tm.soc_start}→${tm.soc_end}%`
                                  : '—'}
                              </td>
                              <td>{tm.provider || '—'}</td>
                              <td>
                                {tm.override ? (
                                  <span className="matching-page__override-badge matching-page__override-badge--manual">
                                    <Link className="matching-page__override-icon" />
                                    Manual → EVCC #{tm.override.evcc_session_id}
                                    {tm.override.reason && (
                                      <span className="matching-page__override-reason" title={tm.override.reason}>
                                        ({tm.override.reason.substring(0, 30)}…)
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="matching-page__override-badge matching-page__override-badge--none">—</span>
                                )}
                              </td>
                              <td className="matching-page__legacy-cell">
                                {tm.legacy_source && tm.legacy_table && tm.legacy_id
                                  ? `${tm.legacy_source}.${tm.legacy_table}#${tm.legacy_id}`
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* TeslaMate Charges - External */}
              <section className="matching-page__raw-section">
                <h3>
                  <Globe className="matching-page__section-icon" />
                  TeslaMateAPI — Extern (Supercharger, etc.) — {rawData.external_tm_charges} Charges
                </h3>
                <div className="matching-page__raw-table-container">
                  <table className="matching-page__raw-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Start</th>
                        <th>Location (Orig.)</th>
                        <th>Location (Norm.)</th>
                        <th>Energy (kWh)</th>
                        <th>Cost (€)</th>
                        <th>€/kWh</th>
                        <th>Cost Source</th>
                        <th>Odometer</th>
                        <th>SoC</th>
                        <th>Provider</th>
                        <th>Override</th>
                        <th>Legacy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawData.teslamate_charges
                        .filter(c => !c.is_home_location)
                        .map((tm) => (
                          <tr key={tm.charge_id} className={tm.override ? 'matching-page__raw-row--override' : ''}>
                            <td>#{tm.charge_id}</td>
                            <td>{tm.start_date ? new Date(tm.start_date).toLocaleString('de-DE') : '—'}</td>
                            <td>{tm.location_original || '—'}</td>
                            <td>{tm.location_normalized || '—'}</td>
                            <td>{tm.energy_kwh?.toFixed(1) || '—'}</td>
                            <td>{tm.cost_eur?.toFixed(2) || '—'}</td>
                            <td>{tm.cost_per_kwh?.toFixed(4) || '—'}</td>
                            <td>
                              <span className={`matching-page__cost-source matching-page__cost-source--${tm.cost_per_kwh_source || 'unknown'}`}>
                                {tm.cost_per_kwh_source || '—'}
                              </span>
                            </td>
                            <td>{tm.odometer_km?.toLocaleString('de-DE') || '—'}</td>
                            <td>
                              {tm.soc_start !== null && tm.soc_end !== null
                                ? `${tm.soc_start}→${tm.soc_end}%`
                                : '—'}
                            </td>
                            <td>{tm.provider || '—'}</td>
                            <td>
                              {tm.override ? (
                                <span className="matching-page__override-badge matching-page__override-badge--manual">
                                  <Link className="matching-page__override-icon" />
                                  Manual → EVCC #{tm.override.evcc_session_id}
                                  {tm.override.reason && (
                                    <span className="matching-page__override-reason" title={tm.override.reason}>
                                      ({tm.override.reason.substring(0, 30)}…)
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <span className="matching-page__override-badge matching-page__override-badge--none">—</span>
                              )}
                            </td>
                            <td className="matching-page__legacy-cell">
                              {tm.legacy_source && tm.legacy_table && tm.legacy_id
                                ? `${tm.legacy_source}.${tm.legacy_table}#${tm.legacy_id}`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </section>
      )}

      {/* Legend */}
      <section className="matching-page__legend">
        <h3>Legende</h3>
        <div className="matching-page__legend-items">
          <span className="matching-page__legend-item matching-page__legend-item--manual">
            <span className="matching-page__legend-dot matching-page__legend-dot--manual"></span>
            Manual Override
          </span>
          <span className="matching-page__legend-item matching-page__legend-item--auto">
            <span className="matching-page__legend-dot matching-page__legend-dot--auto"></span>
            Auto-Match
          </span>
          <span className="matching-page__legend-item matching-page__legend-item--skipped">
            <span className="matching-page__legend-dot matching-page__legend-dot--skipped"></span>
            Skipped (Override woanders)
          </span>
          <span className="matching-page__legend-item matching-page__legend-item--rejected">
            <span className="matching-page__legend-dot matching-page__legend-dot--rejected"></span>
            Abgelehnt (Location)
          </span>
        </div>
      </section>

      {/* Override Success/Error Toast */}
      {(overrideSuccess || overrideError) && (
        <div className={`matching-page__toast ${overrideSuccess ? 'matching-page__toast--success' : 'matching-page__toast--error'}`}>
          {overrideSuccess || overrideError}
          <button className="matching-page__toast-close" onClick={() => { setOverrideSuccess(null); setOverrideError(null); }}>
            ×
          </button>
        </div>
      )}

      {/* Assign Modal */}
      {selectedTmCharge && selectedEvccSession && (
        <div className="matching-page__modal-overlay" onClick={closeModal}>
          <div className="matching-page__modal" onClick={(e) => e.stopPropagation()}>
            <h3>TM Charge zuordnen</h3>
            <div className="matching-page__modal-info">
              <div><strong>TM Charge:</strong> #{selectedTmCharge.charge_id} ({selectedTmCharge.energy_kwh?.toFixed(1)} kWh, {selectedTmCharge.location})</div>
              <div><strong>Ziel EVCC Session:</strong> #{selectedEvccSession.evcc_session_id} ({selectedEvccSession.evcc_energy_kwh?.toFixed(1)} kWh, {selectedEvccSession.evcc_location})</div>
            </div>
            <label className="matching-page__modal-label">
              Grund (erforderlich):
              <textarea
                className="matching-page__modal-textarea"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="z.B. Korrektur: TM Charge gehört zu dieser Home-Session"
                rows={3}
              />
            </label>
            <div className="matching-page__modal-actions">
              <button className="btn btn--secondary" onClick={closeModal}>Abbrechen</button>
              <button
                className="btn btn--primary"
                onClick={() => handleCreateOverride(selectedTmCharge!, selectedEvccSession!)}
                disabled={saving === `create-${selectedTmCharge.charge_id}` || !overrideReason.trim()}
              >
                {saving === `create-${selectedTmCharge.charge_id}` ? (
                  <>
                    <Loader2 className="btn__icon" /> Speichere…
                  </>
                ) : (
                  <>
                    <Save className="btn__icon" /> Override setzen
                  </>
                )}
              </button>
            </div>
            {overrideError && <div className="matching-page__modal-error">{overrideError}</div>}
          </div>
        </div>
      )}

      {/* Matches List */}
      <section className="matching-page__matches">
        <h2>Matching Details</h2>
        {filteredMatches.length === 0 ? (
          <p className="matching-page__empty">Keine Sessions mit aktuellen Filtern</p>
        ) : (
          filteredMatches.map((session) => {
            const manualMatches = session.matched_charges.filter(c => c.match_source === 'manual_override' && c.accepted_as_candidate);
            const skippedMatches = showSkipped ? session.matched_charges.filter(c => c.skipped_due_to_other_override) : [];
            const autoMatches = session.matched_charges.filter(c => c.match_source === 'auto' && c.accepted_as_candidate && !c.skipped_due_to_other_override);
            const rejectedMatches = session.matched_charges.filter(c => !c.accepted_as_candidate && !c.skipped_due_to_other_override);

            // Show session if it has ANY charges (manual, skipped, auto, or rejected)
            if (manualMatches.length === 0 && skippedMatches.length === 0 && autoMatches.length === 0 && rejectedMatches.length === 0) {
              return null;
            }

            return (
              <details key={session.evcc_session_id} className="matching-page__session">
                <summary className="matching-page__session-summary">
                  <div className="matching-page__session-header">
                    <span className="matching-page__session-id">EVCC #{session.evcc_session_id}</span>
                    <span className="matching-page__session-source">{session.evcc_source_id}</span>
                    <span className="matching-page__session-time">
                      {new Date(session.evcc_start).toLocaleString('de-DE')}
                    </span>
                    <span className="matching-page__session-energy">
                      {session.evcc_energy_kwh?.toFixed(1)} kWh
                    </span>
                    <span className="matching-page__session-location">{session.evcc_location}</span>
                  </div>
                  <div className="matching-page__session-badges">
                    {manualMatches.length > 0 && (
                      <span className="matching-page__badge matching-page__badge--manual">
                        <Link className="matching-page__badge-icon" /> {manualMatches.length} Manual
                      </span>
                    )}
                    {skippedMatches.length > 0 && (
                      <span className="matching-page__badge matching-page__badge--skipped">
                        <MinusCircle className="matching-page__badge-icon" /> {skippedMatches.length} Skipped
                      </span>
                    )}
                    {autoMatches.length > 0 && (
                      <span className="matching-page__badge matching-page__badge--auto">
                        <Wifi className="matching-page__badge-icon" /> {autoMatches.length} Auto
                      </span>
                    )}
                    {rejectedMatches.length > 0 && (
                      <span className="matching-page__badge matching-page__badge--rejected">
                        <AlertCircle className="matching-page__badge-icon" /> {rejectedMatches.length} Rejected
                      </span>
                    )}
                  </div>
                </summary>

                <div className="matching-page__session-content">
                  {/* Manual Overrides */}
                  {manualMatches.length > 0 && (
                    <div className="matching-page__charge-group">
                      <h4 className="matching-page__group-title matching-page__group-title--manual">
                        <Link className="matching-page__group-icon" /> Manuelle Overrides
                      </h4>
                      {manualMatches.map((charge) => (
                        <div key={charge.charge_id} className="matching-page__charge matching-page__charge--manual">
                          <div className="matching-page__charge-main">
                            <span className="matching-page__charge-id">TM #{charge.charge_id}</span>
                            <span className="matching-page__charge-energy">{charge.energy_kwh?.toFixed(1)} kWh</span>
                            <span className="matching-page__charge-location">{charge.location}</span>
                            <span className="matching-page__charge-source matching-page__charge-source--manual">
                              Manual Override
                            </span>
                          </div>
                          <div className="matching-page__charge-meta">
                            {charge.override_id && (
                              <span className="matching-page__meta">
                                Override #{charge.override_id}
                              </span>
                            )}
                            {charge.override_reason && (
                              <span className="matching-page__meta matching-page__meta--reason">
                                Grund: {charge.override_reason}
                              </span>
                            )}
                            {charge.replaced_auto_match && (
                              <span className="matching-page__meta matching-page__meta--replaced">
                                Ersetzt: {charge.replaced_auto_match}
                              </span>
                            )}
                          </div>
                          <div className="matching-page__charge-actions">
                            <button
                              className="btn btn--ghost btn--small matching-page__btn-reset"
                              onClick={() => handleDeleteOverride(charge.override_id!, charge.charge_id)}
                              disabled={saving === `delete-${charge.charge_id}`}
                            >
                              {saving === `delete-${charge.charge_id}` ? (
                                <Loader2 className="btn__icon" size={14} />
                              ) : (
                                <>
                                  <RefreshCw className="btn__icon" size={14} />
                                  Zurück auf Auto
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Skipped Charges */}
                  {skippedMatches.length > 0 && (
                    <div className="matching-page__charge-group">
                      <h4 className="matching-page__group-title matching-page__group-title--skipped">
                        <MinusCircle className="matching-page__group-icon" /> Skipped (Override bei anderer EVCC-Session)
                      </h4>
                      {skippedMatches.map((charge) => (
                        <div key={charge.charge_id} className="matching-page__charge matching-page__charge--skipped">
                          <div className="matching-page__charge-main">
                            <span className="matching-page__charge-id">TM #{charge.charge_id}</span>
                            <span className="matching-page__charge-energy">{charge.energy_kwh?.toFixed(1)} kWh</span>
                            <span className="matching-page__charge-location">{charge.location}</span>
                            <span className="matching-page__charge-source matching-page__charge-source--skipped">
                              Übersprungen
                            </span>
                          </div>
                          <div className="matching-page__charge-meta">
                            <span className="matching-page__meta matching-page__meta--skipped">
                              Diese Charge hat einen manuellen Override für eine andere EVCC-Session.
                              Auto-Matching wird hier übersprungen.
                            </span>
                          </div>
                          <div className="matching-page__charge-actions">
                            <button
                              className="btn btn--ghost btn--small matching-page__btn-reassign"
                              onClick={() => openAssignModalForSkipped(charge)}
                            >
                              <ArrowRight className="btn__icon" size={14} />
                              Hierher umhängen
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Auto Matches */}
                  {autoMatches.length > 0 && (
                    <div className="matching-page__charge-group">
                      <h4 className="matching-page__group-title matching-page__group-title--auto">
                        <Wifi className="matching-page__group-icon" /> Auto-Matches
                      </h4>
                      {autoMatches.map((charge) => (
                        <div key={charge.charge_id} className="matching-page__charge matching-page__charge--auto">
                          <div className="matching-page__charge-main">
                            <span className="matching-page__charge-id">TM #{charge.charge_id}</span>
                            <span className="matching-page__charge-energy">{charge.energy_kwh?.toFixed(1)} kWh</span>
                            <span className="matching-page__charge-location">{charge.location}</span>
                            <span className="matching-page__charge-source matching-page__charge-source--auto">
                              Auto
                            </span>
                          </div>
                          <div className="matching-page__charge-meta">
                            <span className="matching-page__meta">
                              Overlap: {charge.overlap_seconds}s, Containment: {charge.containment}
                            </span>
                          </div>
                          <div className="matching-page__charge-actions">
                            <button
                              className="btn btn--ghost btn--small matching-page__btn-assign"
                              onClick={() => openAssignModal(charge, session)}
                            >
                              <PlusCircle className="btn__icon" size={14} />
                              Manuell zuordnen
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Rejected (collapsed by default) */}
                  {rejectedMatches.length > 0 && (
                    <details className="matching-page__charge-group matching-page__charge-group--collapsed">
                      <summary className="matching-page__group-title matching-page__group-title--rejected">
                        <AlertCircle className="matching-page__group-icon" /> Abgelehnt (Location: {rejectedMatches[0]?.reject_reason}) — {rejectedMatches.length} Charges
                      </summary>
                      <div className="matching-page__rejected-list">
                        {rejectedMatches.slice(0, 5).map((charge) => (
                          <div key={charge.charge_id} className="matching-page__rejected-item">
                            TM #{charge.charge_id} — {charge.energy_kwh?.toFixed(1)} kWh — {charge.location_normalized}
                          </div>
                        ))}
                        {rejectedMatches.length > 5 && (
                          <div className="matching-page__rejected-more">
                            … und {rejectedMatches.length - 5} weitere
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </details>
            );
          })
        )}
      </section>
    </div>
  );
};

export default MatchingPage;