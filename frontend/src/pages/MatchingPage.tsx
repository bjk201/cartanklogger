import React, { useState, useEffect, useCallback } from 'react';
import { Save, Wifi, AlertCircle, CheckCircle, Loader2, Shield, Eye, EyeOff, RefreshCw, Link, MinusCircle, PlusCircle, ArrowRight, HelpCircle } from 'lucide-react';
import { api } from '../lib/apiClient';
import type { MatchingDryRunResponse, EVCCSessionMatch, MatchedCharge } from '../types/api';
import './MatchingPage.css';

const MatchingPage: React.FC = () => {
  const [dryRun, setDryRun] = useState<MatchingDryRunResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [selectedTmCharge, setSelectedTmCharge] = useState<MatchedCharge | null>(null);
  const [selectedEvccSession, setSelectedEvccSession] = useState<EVCCSessionMatch | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideSuccess, setOverrideSuccess] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const [showOnlyWithOverrides, setShowOnlyWithOverrides] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);

  const fetchDryRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getMatchingDryRun(limit);
      if (!response.ok) throw new Error('API Error');
      setDryRun(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchDryRun();
  }, [fetchDryRun]);

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

  if (loading) {
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
          <button className="btn btn--primary" onClick={fetchDryRun}>Erneut versuchen</button>
        </div>
      </div>
    );
  }

  if (!dryRun) {
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

  const { matches, summary } = dryRun;

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
        <button className="btn btn--secondary" onClick={fetchDryRun}>
          <RefreshCw className="btn__icon" /> Aktualisieren
        </button>
      </div>

      {/* Summary */}
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

            if (manualMatches.length === 0 && skippedMatches.length === 0 && autoMatches.length === 0) {
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