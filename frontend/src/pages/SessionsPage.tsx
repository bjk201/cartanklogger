import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, RefreshCw, Edit2, Link2, ChevronRight as ChevronRightIcon, ExternalLink, Trash2 } from 'lucide-react';
import { useTimeRange, type RangeValue } from '../app/TimeRangeContext';
import { SessionsTable } from '../components/SessionsTable';
import { SessionMobileCard } from '../components/SessionMobileCard';
import { LoadingState, ErrorState, EmptyState } from '../components/StateViews';
import { api, updateSession, deleteSession, type Session, type PaginationInfo, type MatchingRawDataResponse, type UnmatchedChargeItem, type MatchedCharge, type SessionExportStatesResponse } from '../lib/apiClient';
import { TmCostExportPanel } from '../components/TmCostExportPanel';
import './SessionsPage.css';

const PAGE_SIZE = 25;

type SessionsTab = 'all' | 'home' | 'external' | 'unmatched' | 'tmexport';

type TabConfig = { key: SessionsTab; label: string; icon?: string };

const TABS: TabConfig[] = [
  { key: 'all', label: 'Alle' },
  { key: 'home', label: 'Zuhause (EVCC)' },
  { key: 'external', label: 'Extern (TM)' },
  { key: 'unmatched', label: 'Ungematchte TM' },
  { key: 'tmexport', label: 'TM-Export' },
];

/* ===== Edit Modal ===== */
interface EditModalProps {
  session: Session;
  onClose: () => void;
  onSaved: () => void;
}

function EditModal({ session, onClose, onSaved }: EditModalProps) {
  const [date, setDate] = useState(session.date?.slice(0, 16) || '');
  const [energy, setEnergy] = useState(session.energy_kwh?.toString() || '');
  const [cost, setCost] = useState(session.cost_eur?.toString() || '');
  const [costPerKwh, setCostPerKwh] = useState(session.cost_per_kwh?.toString() || '');
  const [location, setLocation] = useState(session.location || '');
  const [odometer, setOdometer] = useState(session.odometer_km?.toString() || '');
  const [distance, setDistance] = useState(session.distance_km?.toString() || '');
  const [note, setNote] = useState(session.note || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lösch-Bestätigung (Checkbox-Zwang, wie beim TM-Kostenexport)
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateSession(session.id, {
        date: date || undefined,
        energy_kwh: energy === '' ? null : Number(energy),
        cost_eur: cost === '' ? null : Number(cost),
        cost_per_kwh: costPerKwh === '' ? null : Number(costPerKwh),
        location: location === '' ? null : location,
        odometer_km: odometer === '' ? null : Number(odometer),
        distance_km: distance === '' ? null : Number(distance),
        note: note === '' ? null : note,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteSession(session.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Löschen');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Session bearbeiten</h3>
          <button className="modal-close-btn" onClick={onClose} aria-label="Schließen">&times;</button>
        </div>
        <div className="modal-body">
          <div className="session-edit-info">
            <span className={`source-badge source-badge--${session.source_type}`}>
              {session.source_type === 'home' ? 'EVCC' : session.source_type === 'external' ? 'TeslaMate' : 'Import'}
            </span>
            <span className="session-edit-id">ID: {session.source_id}</span>
          </div>
          <form onSubmit={handleSubmit} className="record-form">
            <div className="form-row">
              <div className="form-field">
                <label className="form-label">Datum / Zeit</label>
                <input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} />
              </div>
              <div className="form-field">
                <label className="form-label">Energie (kWh)</label>
                <input type="number" step="0.01" value={energy} onChange={e => setEnergy(e.target.value)} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-field">
                <label className="form-label">Kosten (€)</label>
                <input type="number" step="0.01" value={cost} onChange={e => setCost(e.target.value)} />
              </div>
              <div className="form-field">
                <label className="form-label">€/kWh</label>
                <input type="number" step="0.001" value={costPerKwh} onChange={e => setCostPerKwh(e.target.value)} />
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Ort</label>
              <input type="text" value={location} onChange={e => setLocation(e.target.value)} />
            </div>
            <div className="form-row">
              <div className="form-field">
                <label className="form-label">km-Stand</label>
                <input type="number" value={odometer} onChange={e => setOdometer(e.target.value)} />
              </div>
              <div className="form-field">
                <label className="form-label">Gefahrene km</label>
                <input type="number" step="0.1" value={distance} onChange={e => setDistance(e.target.value)} />
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Notiz</label>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} />
            </div>
            {error && <div className="form-submit-error">{error}</div>}
            <div className="form-actions form-actions--split">
              <button
                type="button"
                className="btn-danger"
                onClick={handleDelete}
                disabled={!confirmDelete || deleting || saving}
                title={confirmDelete ? 'Session unwiderruflich löschen' : 'Erst Checkbox bestätigen'}
              >
                {deleting ? 'Wird gelöscht…' : <><Trash2 size={14} aria-hidden /> Löschen</>}
              </button>
              <div className="form-actions__right">
                <button type="button" className="btn-secondary" onClick={onClose} disabled={saving || deleting}>Abbrechen</button>
                <button type="submit" className="btn-primary" disabled={saving || deleting}>
                  {saving ? 'Wird gespeichert…' : 'Speichern'}
                </button>
              </div>
            </div>
            <label className="session-delete-confirm">
              <input
                type="checkbox"
                checked={confirmDelete}
                onChange={e => setConfirmDelete(e.target.checked)}
                disabled={deleting || saving}
              />
              Ich bestätige: Diese Session aus CTL löschen (Quelle z. B. EVCC bleibt unberührt)
            </label>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ===== Sessions Page ===== */
export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SessionsTab>('all');
  // TM-Summen pro EVCC-Session (für Anzeige in der zugeklappten Zeile)
  const [tmSums, setTmSums] = useState<Map<number, { tm_sum_kwh: number | null; tm_used_kwh: number | null; tm_count: number }>>(new Map());
  // TM-Kostenexport-Status je Home-Session (Badge in der TM-Export-Spalte,
  // gleiche Datenquelle wie die Export-Seite -> garantiert identische Zustände)
  const [exportStates, setExportStates] = useState<Map<number, NonNullable<SessionExportStatesResponse['data']>[number]>>(new Map());
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1, page_size: PAGE_SIZE, total: 0, total_pages: 0, has_next: false, has_prev: false,
  });

  // Search & Sort
  const [search, setSearch] = useState('');
  const [sortDesc, setSortDesc] = useState(true);

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Edit modal
  const [editSession, setEditSession] = useState<Session | null>(null);

  // Raw data for unmatched TM
  const [rawData, setRawData] = useState<MatchingRawDataResponse | null>(null);
  const [loadingRaw, setLoadingRaw] = useState(false);

  // TM-Export-Tab: Deep-Link ?session=ID öffnet das Detail der Session direkt
  // im eingebetteten Export-Panel (vorher: Navigation zu /tm-cost-export).
  // nonce = Remount-Zähler: jeder Badge-Klick mountet das Panel neu, damit
  // auch DENSSELBEN Session-Detail erneut geöffnet werden kann.
  const initialTmSession = (() => {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search).get('session');
    return p && !Number.isNaN(Number(p)) ? Number(p) : null;
  })();
  const [tmExportSeed, setTmExportSeed] = useState<number | null>(initialTmSession);
  const [tmExportNonce, setTmExportNonce] = useState(initialTmSession !== null ? 1 : 0);

  // Match dialog (unmatched TM → EVCC session)
  const [matchTarget, setMatchTarget] = useState<any | null>(null);
  const [homeSessions, setHomeSessions] = useState<Session[]>([]);
  const [matchSelector, setMatchSelector] = useState('');
  const [matchSaving, setMatchSaving] = useState(false);
  const [matchMessage, setMatchMessage] = useState<string | null>(null);

  const openMatchDialog = async (charge: any) => {
    setMatchTarget(charge);
    setMatchSelector('');
    setMatchMessage(null);
    try {
      const days = getDaysFromRange(selectedRange) || 30;
      const res = await api.getSessions({ source_type: 'home', page_size: 100, days });
      // Sort by odometer proximity to the TM charge (closest first) — best match candidate on top
      const chargeOdo = Number(charge.odometer ?? 0);
      const sessions = [...(res.data || [])].sort((a, b) =>
        Math.abs((Number(a.odometer_km) || 0) - chargeOdo) - Math.abs((Number(b.odometer_km) || 0) - chargeOdo)
      );
      setHomeSessions(sessions);
    } catch {
      setHomeSessions([]);
    }
  };

  // Odometer delta (km, one decimal) between a home session and the charge in the dialog
  const odoDelta = (sessionOdo: number | null | undefined): number | null => {
    if (!matchTarget || sessionOdo == null || matchTarget.odometer == null) return null;
    return Math.round(Math.abs(Number(sessionOdo) - Number(matchTarget.odometer)) * 10) / 10;
  };

  const confirmMatch = async () => {
    if (!matchTarget || !matchSelector) return;
    setMatchSaving(true);
    setMatchMessage(null);
    try {
      const sessionId = Number(matchSelector);
      const tmChargeId = Number(matchTarget.tm_charge_id ?? matchTarget.charge_id ?? matchTarget.id);
      const result = await api.createSessionMatch(sessionId, tmChargeId);
      setMatchMessage(result.ok ? (result.message || 'Erfolgreich zugeordnet') : 'Fehler');
      if (result.ok) {
        setMatchTarget(null);
        // Refetch unmatched charges (same source the tab renders from)
        api.getUnmatchedCharges(getDaysFromRange(selectedRange) || 36500)
          .then(setRawData)
          .catch(() => {});
      }
    } catch (err) {
      setMatchMessage(err instanceof Error ? err.message : 'Fehler beim Zuordnen');
    } finally {
      setMatchSaving(false);
    }
  };

  const { selectedRange, customFrom, customTo, getRangeLabel, getDaysFromRange, getFromDate, getToDate, setSelectedRange } = useTimeRange();

  const handleRangeChange = (value: RangeValue) => setSelectedRange(value);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    let days: number | undefined = getDaysFromRange(selectedRange);
    let from_date: string | undefined = getFromDate();
    let to_date: string | undefined = getToDate();
    if (selectedRange === 'custom') {
      if (customFrom) from_date = customFrom;
      if (customTo) to_date = customTo;
    } else if (selectedRange === 'all') days = 36500;

    try {
          let sourceType: string | undefined;
          if (activeTab === 'home') sourceType = 'home';
          else if (activeTab === 'external') sourceType = 'external';

          const response = await api.getPaginatedSessions({
            page: pagination.page, page_size: PAGE_SIZE,
            source_type: sourceType,
            search: search || undefined,
            sort_desc: sortDesc,
            days, from_date, to_date,
          });

          if (!response.ok) throw new Error('API returned error status');

          setSessions(response.data);
          const totalPages = Math.ceil(response.pagination.total / PAGE_SIZE);
          setPagination({
            page: pagination.page, page_size: pagination.page_size,
            total: response.pagination.total, total_pages: totalPages,
            has_next: response.pagination.page < totalPages, has_prev: pagination.page > 1,
          });

          // TM-Summen für die zugeklappte EVCC-Zeile laden (ein Call für den gesamten Zeitraum)
          if (activeTab === 'all' || activeTab === 'home') {
            try {
              const tmResponse = await api.getSessionTmSums(days, from_date, to_date);
              const map = new Map<number, { tm_sum_kwh: number | null; tm_used_kwh: number | null; tm_count: number }>();
              for (const item of tmResponse.data || []) {
                map.set(item.session_id, { tm_sum_kwh: item.tm_sum_kwh, tm_used_kwh: item.tm_used_kwh, tm_count: item.tm_count });
              }
              setTmSums(map);
            } catch {
              setTmSums(new Map());
            }
            // TM-Kostenexport-Status (ein Batch-Call, DB-only — identische
            // Quelle wie die Export-Seite)
            try {
              const esResponse = await api.getSessionExportStates(days, from_date, to_date);
              const esMap = new Map<number, NonNullable<SessionExportStatesResponse['data']>[number]>();
              for (const item of esResponse.data || []) {
                if (item.export_state) esMap.set(item.evcc_session_id, item);
              }
              setExportStates(esMap);
            } catch {
              setExportStates(new Map());
            }
          }
        } catch (err) {
      setError(`Fehler beim Laden: ${err instanceof Error ? err.message : 'Unbekannt'}`);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, activeTab, search, sortDesc, selectedRange, customFrom, customTo]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // Deep-Link: ?session=ID -> TM-Export-Tab aktivieren. Danach den Parameter
  // aus der URL entfernen (sonst öffnet ein Reload das Detail wieder) —
  // ohne Re-Render via history.replaceState.
  useEffect(() => {
    if (tmExportSeed !== null) {
      setActiveTab('tmexport');
      const url = new URL(window.location.href);
      url.searchParams.delete('session');
      window.history.replaceState({}, '', url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handler für Badge-Klicks in der Session-Zeile: wechselt in den
  // TM-Export-Tab und öffnet das Session-Detail (Panel remountet via Nonce).
  const openTmExportDetail = useCallback((sessionId: number) => {
    setTmExportSeed(sessionId);
    setTmExportNonce(n => n + 1);
    setActiveTab('tmexport');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Fetch raw data for unmatched tab
  useEffect(() => {
    if (activeTab !== 'unmatched') return;
    setLoadingRaw(true);
    api.getUnmatchedCharges(getDaysFromRange(selectedRange) || 36500)
      .then(setRawData)
      .catch(() => setRawData(null))
      .finally(() => setLoadingRaw(false));
  }, [activeTab, selectedRange]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPagination(p => ({ ...p, page: 1 }));
  };

  const handleTabChange = (tab: SessionsTab) => {
    setActiveTab(tab);
    setPagination(p => ({ ...p, page: 1 }));
  };

  const handleSortToggle = () => setSortDesc(d => !d);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.total_pages) {
      setPagination(p => ({ ...p, page: newPage }));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api.syncDataSources();
      if (!result?.ok) {
        setSyncMessage('Sync teilweise fehlgeschlagen');
      } else {
        const evcc = result.result?.evcc || {};
        const deleted = evcc.deleted || 0;
        const kept = evcc.kept || 0;
        let msg = `Sync OK: ${evcc.synced ?? 0} EVCC-Sessions`;
        if (deleted) msg += `, ${deleted} in EVCC gelöschte entfernt`;
        if (kept) msg += `, ${kept} mit TeslaMate-Export-Historie behalten`;
        setSyncMessage(msg);
      }
      await fetchSessions();
      setTimeout(() => setSyncMessage(null), 5000);
    } catch (err) {
      setSyncMessage('Sync-Fehler: ' + (err instanceof Error ? err.message : 'Unbekannt'));
      setTimeout(() => setSyncMessage(null), 5000);
    } finally {
      setSyncing(false);
    }
  };

  const unmatchedTMCharges = (rawData as any)?.charges || [];

  return (
    <div className="page-container">
      <div className="sessions-page">
        <header className="sessions-page__header">
          <h1 className="sessions-page__title">Sessions</h1>
          <p className="sessions-page__subtitle">
            Ladevorgänge verwalten · <span className="sessions-page__status">{getRangeLabel(selectedRange)}</span>
          </p>
        </header>

        {/* Tabs */}
        <div className="sessions-page__tabs" role="tablist">
          {TABS.map(tab => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`sessions-page__tab ${activeTab === tab.key ? 'sessions-page__tab--active' : ''}`}
              onClick={() => handleTabChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Filter Bar */}
        {activeTab !== 'unmatched' && activeTab !== 'tmexport' && (
          <div className="sessions-page__filter-bar">
            <div className="sessions-page__search">
              <label htmlFor="sessions-search" className="sr-only">Suchen</label>
              <div className="sessions-page__search-input">
                <Search className="sessions-page__search-icon" />
                <input id="sessions-search" type="search" placeholder="Ort, Notiz…" value={search}
                  onChange={(e) => handleSearchChange(e.target.value)} className="sessions-page__search-field" />
              </div>
            </div>
            <div className="sessions-page__filters">
              <button onClick={handleSortToggle} className="sessions-page__sort-btn" aria-pressed={sortDesc}>
                <span>Datum</span>
                {sortDesc ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
              <button onClick={handleSync} disabled={syncing} className="sessions-page__sync-btn" title="Jetzt synchronisieren">
                <RefreshCw size={16} className={syncing ? 'spin' : ''} />
                {syncing ? 'Sync...' : 'Sync'}
              </button>
            </div>
          </div>
        )}

        {syncMessage && (
          <div className={`sessions-page__sync-msg ${syncMessage.includes('Fehler') ? 'error' : 'success'}`}>
            {syncMessage}
          </div>
        )}

        {/* Content */}
        {activeTab === 'tmexport' ? (
          /* === TM-EXPORT TAB (eingebettetes Export-Panel) === */
          <TmCostExportPanel key={`tmexp-${tmExportNonce}`} initialSessionId={tmExportSeed} />
        ) : activeTab === 'unmatched' ? (
          /* === UNMATCHED TM TAB === */
          loadingRaw ? (
            <LoadingState message="Ungematchte TM-Daten werden geladen…" />
          ) : unmatchedTMCharges.length === 0 ? (
            <EmptyState title="Keine ungematchten TM-Charges" message="Alle TeslaMate-Charges sind bereits zugeordnet." />
          ) : (
            <div className="unmatched-table-wrapper">
              <p className="unmatched-hint">
                Diese TeslaMate-Charges haben keine passende EVCC-Session. Du kannst sie manuell zuordnen.
              </p>
              <table className="unmatched-table">
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Ort</th>
                    <th className="text-end">kWh</th>
                    <th className="text-end">Geladen</th>
                    <th className="text-end">Genutzt</th>
                    <th className="text-end">km</th>
                    <th>Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {(unmatchedTMCharges as UnmatchedChargeItem[]).map((charge, idx) => (
                    <tr key={idx}>
                      <td>{charge.date ? new Date(charge.date).toLocaleDateString('de-DE') : '—'}</td>
                      <td>{charge.location || '—'}</td>
                      <td className="text-end">{charge.energy_added != null ? Number(charge.energy_added).toFixed(1) : '—'}</td>
                      <td className="text-end">{charge.energy_added != null ? Number(charge.energy_added).toFixed(1) : '—'}</td>
                      <td className="text-end">{charge.energy_used != null ? Number(charge.energy_used).toFixed(1) : '—'}</td>
                      <td className="text-end">{charge.odometer || '—'}</td>
                      <td>
                        <button className="btn-match" title="Manuell einer EVCC-Session zuordnen" onClick={() => openMatchDialog(charge)}>
                          <Link2 size={14} /> Matchen
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          /* === SESSIONS TAB === */
          loading ? (
            <LoadingState message="Sessions werden geladen…" />
          ) : error ? (
            <ErrorState message={error} onRetry={fetchSessions} />
          ) : sessions.length === 0 ? (
            <EmptyState title="Keine Sessions gefunden" message={search ? 'Versuche die Filter zu ändern.' : 'Keine Ladevorgänge.'} />
          ) : (
            <>
              {/* Expandable Sessions Table */}
              <div className="sessions-page__table-container">
                <table className="sessions-table sessions-table--expandable">
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: '32px' }}></th>
                      <th scope="col">Datum</th>
                      <th scope="col">Quelle</th>
                      <th scope="col" className="text-end">kWh</th>
                      <th scope="col" className="text-end">Anteil PV</th>
                      <th scope="col" className="text-end">€/kWh</th>
                      <th scope="col" className="text-end">Kosten</th>
                      <th scope="col" className="text-end">TM Added</th>
                      <th scope="col" className="text-end">TM Used</th>
                      <th scope="col">Ort</th>
                      <th scope="col">TM-Export</th>
                      <th scope="col" style={{ width: '50px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map(session => (
                      <SessionRow key={session.id} session={session} onEdit={() => setEditSession(session)} tmSum={tmSums.get(session.id)} exportState={exportStates.get(session.id)} onOpenExport={openTmExportDetail} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sessions-page__mobile-cards">
                {sessions.map(session => (
                  <SessionMobileCard key={session.id} session={session} />
                ))}
              </div>

              {pagination.total_pages > 1 && (
                <nav className="sessions-page__pagination" aria-label="Seiten-Navigation">
                  <button onClick={() => handlePageChange(pagination.page - 1)} disabled={!pagination.has_prev}
                    className="sessions-page__page-btn" aria-label="Vorherige Seite">
                    <ChevronLeft size={18} />
                  </button>
                  <div className="sessions-page__page-info">
                    Seite {pagination.page} von {pagination.total_pages}
                  </div>
                  <button onClick={() => handlePageChange(pagination.page + 1)} disabled={!pagination.has_next}
                    className="sessions-page__page-btn" aria-label="Nächste Seite">
                    <ChevronRight size={18} />
                  </button>
                </nav>
              )}
            </>
          )
        )}
      </div>

      {/* Edit Modal */}
      {editSession && <EditModal session={editSession} onClose={() => setEditSession(null)} onSaved={fetchSessions} />}

      {/* Match Dialog */}
      {matchTarget && (
        <div className="match-modal-overlay" onClick={() => setMatchTarget(null)}>
          <div className="match-modal" onClick={e => e.stopPropagation()}>
            <h3 className="match-modal__title"><Link2 size={16} /> TM-Charge zuordnen</h3>
            <p className="match-modal__sub">
              TM-Charge vom <strong>{matchTarget.date ? new Date(matchTarget.date).toLocaleDateString('de-DE') : '—'}</strong> ({matchTarget.location || 'kein Ort'})
            </p>
            <label className="match-modal__label" htmlFor="match-select">EVCC-Session wählen</label>
            <select id="match-select" className="match-modal__select" value={matchSelector} onChange={e => setMatchSelector(e.target.value)}>
              <option value="">— Session wählen —</option>
              {homeSessions.map(s => {
                const d = odoDelta(s.odometer_km);
                const odoHint = d == null ? '' : d <= 2 ? ` · Δ ${d.toFixed(1)} km ✓` : ` · Δ ${d.toFixed(0)} km`;
                return (
                <option key={s.id} value={s.id}>
                  {new Date(s.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {s.energy_kwh?.toFixed(1) ?? '?'} kWh{odoHint}
                </option>
                );
              })}
            </select>
            {matchMessage && <p className={`match-modal__message ${matchTarget === null ? 'match-modal__message--success' : ''}`}>{matchMessage}</p>}
            <div className="match-modal__actions">
              <button className="btn btn-secondary" onClick={() => setMatchTarget(null)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={confirmMatch} disabled={!matchSelector || matchSaving}>
                {matchSaving ? 'Zuordnen…' : 'Zuordnen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== Session Row with Expand ===== */
const EXPORT_BADGE_LABELS: Record<string, string> = {
  draft: 'Bereit zur Prüfung',
  blocked: 'Blockiert',
  approved: 'Freigegeben',
  exported: 'Exportiert',
  failed: 'Fehlgeschlagen',
  rolled_back: 'Zurückgerollt',
};

function SessionRow({ session, onEdit, tmSum, exportState, onOpenExport }: {
  session: Session;
  onEdit: () => void;
  tmSum?: { tm_sum_kwh: number | null; tm_used_kwh: number | null; tm_count: number };
  exportState?: NonNullable<SessionExportStatesResponse['data']>[number];
  onOpenExport: (sessionId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [matchData, setMatchData] = useState<any[] | null>(null);
  const [loadingMatch, setLoadingMatch] = useState(false);

  const isHome = session.source_type === 'home';

  const handleToggle = async () => {
    if (!isHome) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !matchData) {
      setLoadingMatch(true);
      try {
        const result = await api.getSessionMatches(session.id);
        setMatchData(result.matches || []);
      } catch { setMatchData([]); }
      finally { setLoadingMatch(false); }
    }
  };

  return (
    <>
      <tr className={`sessions-table__row ${expanded ? 'row-expanded' : ''}`}>
        <td className="sessions-table__expand" onClick={handleToggle} style={{ cursor: isHome ? 'pointer' : 'default' }}>
          {isHome && (
            <ChevronRightIcon size={16} className={`expand-icon ${expanded ? 'expand-icon--open' : ''}`} />
          )}
        </td>
        <td className="sessions-table__date">
          <time dateTime={session.date}>{new Date(session.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
        </td>
        <td>
          <span className={`source-badge source-badge--${session.source_type}`}>
            {session.source_type === 'home' ? 'EVCC' : session.source_type === 'external' ? 'TM' : 'Import'}
          </span>
        </td>
        <td className="text-end">{session.energy_kwh?.toFixed(1) ?? '—'}</td>
        <td className="text-end">{session.solar_percentage != null ? `${session.solar_percentage.toFixed(0)}%` : '—'}</td>
        <td className="text-end">{session.cost_per_kwh != null ? `${session.cost_per_kwh.toFixed(2)} €/kWh` : '—'}</td>
        <td className="text-end">{session.cost_eur != null ? `${session.cost_eur.toFixed(2)} €` : '—'}</td>
        {/* TM Added: bei EVCC die Summe der zugeordneten TM added; bei TM der charge_energy_added */}
        <td className="text-end">
          {isHome
            ? (tmSum?.tm_sum_kwh != null ? tmSum.tm_sum_kwh.toFixed(1) : (session.charge_energy_added != null ? session.charge_energy_added.toFixed(1) : '—'))
            : (session.charge_energy_added != null ? session.charge_energy_added.toFixed(1) : '—')}
        </td>
        {/* TM Used: bei EVCC die Summe der zugeordneten TM used_kwh; bei TM der charge_energy_used */}
        <td className="text-end" title={isHome && tmSum?.tm_used_kwh != null && tmSum.tm_count > 0 ? `${tmSum.tm_count} TM-Charges summiert (Added ${tmSum.tm_sum_kwh ?? '—'} / Used ${tmSum.tm_used_kwh} kWh)` : undefined}>
          {isHome
            ? (tmSum?.tm_used_kwh != null ? tmSum.tm_used_kwh.toFixed(1) : (session.charge_energy_used != null ? session.charge_energy_used.toFixed(1) : '—'))
            : (session.charge_energy_used != null ? session.charge_energy_used.toFixed(1) : '—')}
        </td>
        <td className="sessions-table__location">{session.location || '—'}</td>
        <td className="sessions-table__export">
          {isHome && exportState ? (() => {
            const es = exportState;
            const stateKey = es.export_state ?? '';
            return (
              <button
                type="button"
                className={`tmexp-badge tmexp-badge--${stateKey} sessions-table__export-link`}
                title={`TM-Kostenexport: ${EXPORT_BADGE_LABELS[stateKey] ?? stateKey} — Detail öffnen`}
                onClick={() => onOpenExport(session.id)}
              >
                {EXPORT_BADGE_LABELS[stateKey] ?? stateKey}
                {es.planned_export_eur != null && stateKey !== 'blocked'
                  ? ` · ${es.planned_export_eur.toFixed(2)} €`
                  : ''}
              </button>
            );
          })() : (
            <span className="sessions-table__export-none">—</span>
          )}
        </td>
        <td>
          <button className="btn-icon btn-icon--sm" onClick={onEdit} title="Bearbeiten">
            <Edit2 size={14} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="sessions-table__match-row">
          <td colSpan={12}>
            <div className="match-detail">
              <h4 className="match-detail__title">
                <ExternalLink size={14} /> TM-Charges zu dieser EVCC-Session
              </h4>
              {loadingMatch ? (
                <p className="match-detail__loading">Lädt Match-Daten…</p>
              ) : !matchData || matchData.length === 0 ? (
                <p className="match-detail__empty">Keine TM-Charges zugeordnet.</p>
              ) : (
                <table className="match-detail__table">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th className="text-end">kWh</th>
                      <th className="text-end">Kosten</th>
                      <th>Ort</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchData.map((m: MatchedCharge, i: number) => (
                      <tr key={i}>
                        <td>{m.date ? new Date(m.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td className="text-end">{m.energy_kwh?.toFixed(2) ?? '—'}</td>
                        <td className="text-end">{m.cost_eur != null ? `${m.cost_eur.toFixed(2)} €` : '—'}</td>
                        <td>{m.location || '—'}</td>
                        <td><span className={`match-quality match-quality--${m.containment || 'unknown'}`}>{m.containment || '—'}{m.accepted_as_candidate === false ? ' (abgelehnt)' : ''}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}