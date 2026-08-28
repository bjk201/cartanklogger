import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRightLeft, BadgeCheck, Ban, CheckCircle2, ChevronDown,
  Clock, Download, Eye, RefreshCw, RotateCcw, Send, ShieldAlert, X,
} from 'lucide-react';
import './TmCostExportPage.css';

/* ------------------------------------------------------------------ */
/* Typen                                                              */
/* ------------------------------------------------------------------ */
interface ListItem {
  evcc_session_id: number;
  date: string | null;
  location: string | null;
  evcc_kwh: number | null;
  evcc_total_cost_eur: number | null;
  fragment_count: number;
  tm_used_kwh_total: number;
  loss_kwh: number | null;
  loss_pct: number | null;
  planned_export_eur: number;
  state: 'draft' | 'blocked' | 'approved' | 'exported' | 'failed' | 'rolled_back';
  block_reasons: string[];
}

interface ListResponse {
  data: ListItem[];
  counts: Record<string, number>;
}

interface Fragment {
  allocation_id: number;
  tm_charge_id: number;
  tm_charging_process_id: number;
  match_quality: string;
  tm_used_kwh: number;
  old_tm_cost_eur: number | null;
  new_planned_tm_cost_eur: number;
  cost_source: string;
  exclusion_reason: string | null;
  export_status: string;
}

interface DetailResponse {
  evcc_session: { id: number; date: string | null; location: string | null; kwh: number | null; total_cost_eur: number | null };
  state: string;
  block_reasons: string[];
  calculation_version: string;
  tm_fragment_count: number;
  tm_used_kwh_total: number;
  loss_kwh: number | null;
  loss_pct: number | null;
  effective_price_eur_per_kwh: number | null;
  match_qualities: string[];
  sum_equals_evcc: boolean;
  sum_planned_eur: number;
  tm_db_configured: boolean;
  fragments: Fragment[];
}

type DialogKind = 'approve' | 'execute' | 'rollback';

const STATE_LABELS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Bereit zur Prüfung', cls: 'draft' },
  blocked: { label: 'Blockiert', cls: 'blocked' },
  approved: { label: 'Freigegeben', cls: 'approved' },
  exported: { label: 'Exportiert', cls: 'exported' },
  failed: { label: 'Fehlgeschlagen', cls: 'failed' },
  rolled_back: { label: 'Zurückgerollt', cls: 'rolled_back' },
};

const REASON_LABELS: Record<string, string> = {
  no_evcc_cost: 'Keine EVCC-Kosten',
  no_accepted_match: 'Kein akzeptiertes Match',
  weak_or_rejected_match: 'Match-Qualität zu schwach',
  tm_used_zero: 'TM-used-Summe ist 0',
  missing_charging_process_id: 'TM charging_process-ID fehlt',
  tm_charge_already_allocated_elsewhere: 'TM-Charge bereits anderweitig zugeordnet',
};

function fmtEur(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' €';
}
function fmtKwh(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' kWh';
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Seite                                                              */
/* ------------------------------------------------------------------ */
export function TmCostExportPage() {
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ kind: DialogKind; item: ListItem } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkedConfirmed, setCheckedConfirmed] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      setList(await req<ListResponse>('/api/tm-cost-export?' + params.toString()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadList(); }, [loadList]);

  // Allokationen NEU BERECHNEN (POST /refresh): holt EVCC+TM live, matched,
  // schreibt session_cost_allocations. Schreibt NIE in TeslaMate.
  const recompute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await req<{ ok: boolean }>('/api/tm-cost-export/refresh', { method: 'POST' });
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [loadList]);

  const openDialog = (kind: DialogKind, item: ListItem) => {
    setCheckedConfirmed(false);
    setActionError(null);
    setDialog({ kind, item });
  };

  const runApproveExecuteRollback = async () => {
    if (!dialog || !checkedConfirmed) return;
    const id = dialog.item.evcc_session_id;
    setBusy(true);
    setActionError(null);
    try {
      if (dialog.kind === 'approve') {
        await req(`/api/tm-cost-export/${id}/approve`, { method: 'POST', body: '{}' });
        // Nach Approve direkt ins Exportieren springen? Nein: bewusst zwei Schritte.
        closeAndReload();
      } else if (dialog.kind === 'execute') {
        const res = await req<{ status?: string; error?: string; exported?: number }>(`/api/tm-cost-export/${id}/execute`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
        if (res?.status === 'exported') {
          closeAndReload();
        } else {
          setActionError(res?.error || `Export nicht durchgefuehrt (Status: ${res?.status ?? 'unbekannt'})`);
        }
      } else {
        const res = await req<{ status?: string; error?: string; rolled_back?: number }>(`/api/tm-cost-export/${id}/rollback`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
        if (res?.status === 'rolled_back') {
          closeAndReload();
        } else {
          setActionError(res?.error || `Rollback nicht durchgefuehrt (Status: ${res?.status ?? 'unbekannt'})`);
        }
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const closeAndReload = () => {
    setDialog(null);
    loadList();
  };

  const counts = list?.counts ?? {};

  return (
    <div className="tmexp-page">
      {/* Kopfbereich */}
      <header className="tmexp-header">
        <div>
          <h1 className="tmexp-title">
            <ArrowRightLeft size={22} aria-hidden /> TM-Kostenexport
          </h1>
          <p className="tmexp-hint">
            <ShieldAlert size={15} aria-hidden />
            EVCC-Kosten werden nur nach Prüfung und expliziter Freigabe in TeslaMate geschrieben.
          </p>
        </div>
        <div className="tmexp-header__actions">
          <button
            className="tmexp-btn"
            onClick={recompute}
            disabled={loading}
            title="Matched EVCC-Sessions mit TeslaMate-Chargen neu und schreibt die Allokationen (kein TeslaMate-Write!)"
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} aria-hidden /> Berechnen
          </button>
          <button className="tmexp-btn" onClick={loadList} disabled={loading}>
            <Eye size={15} aria-hidden /> Neu laden
          </button>
        </div>
      </header>

      {/* Status-KPIs */}
      <section className="tmexp-kpis" aria-label="Status-Übersicht">
        {['draft', 'blocked', 'approved', 'exported', 'failed'].map((k) => (
          <article key={k} className={`tmexp-kpi tmexp-kpi--${k}`}>
            <span className="tmexp-kpi__value">{counts[k] ?? 0}</span>
            <span className="tmexp-kpi__label">{STATE_LABELS[k]?.label ?? k}</span>
          </article>
        ))}
      </section>

      {/* Filter */}
      <div className="tmexp-toolbar">
        <label htmlFor="tmexp-status">Status</label>
        <select
          id="tmexp-status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">Alle</option>
          {Object.entries(STATE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="tmexp-alert tmexp-alert--error"><Ban size={16} aria-hidden /> {error}</div>
      )}

      {/* Tabelle */}
      <section className="tmexp-table-card">
        {loading && !list ? (
          <p className="tmexp-empty">Lade…</p>
        ) : !list || list.data.length === 0 ? (
          <p className="tmexp-empty">Keine EVCC-Sessions gefunden.</p>
        ) : (
          <div className="tmexp-table-wrap">
            <table className="tmexp-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>EVCC Datum/Zeit</th>
                  <th>EVCC kWh</th>
                  <th>EVCC Kosten</th>
                  <th>TM Fragmente</th>
                  <th>TM-used kWh</th>
                  <th>Ladeverlust</th>
                  <th>Exportbetrag</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((item) => {
                  const st = STATE_LABELS[item.state] ?? { label: item.state, cls: 'draft' };
                  return (
                    <tr key={item.evcc_session_id}>
                      <td><span className={`tmexp-badge tmexp-badge--${st.cls}`}>{st.label}</span></td>
                      <td>{fmtDate(item.date)}</td>
                      <td>{fmtKwh(item.evcc_kwh)}</td>
                      <td>{fmtEur(item.evcc_total_cost_eur)}</td>
                      <td>{item.fragment_count}</td>
                      <td>{fmtKwh(item.tm_used_kwh_total, 2)}</td>
                      <td>
                        {item.loss_kwh !== null ? `${fmtKwh(item.loss_kwh)} (${item.loss_pct} %)` : '—'}
                      </td>
                      <td>{item.state === 'blocked' ? '—' : fmtEur(item.planned_export_eur)}</td>
                      <td className="tmexp-actions">
                        <button className="tmexp-btn tmexp-btn--sm" onClick={() => setDetailId(item.evcc_session_id)}>
                          <Eye size={13} aria-hidden /> Prüfen
                        </button>
                        {item.state === 'draft' && !item.block_reasons.length && item.fragment_count > 0 && (
                          <button className="tmexp-btn tmexp-btn--sm tmexp-btn--primary" onClick={() => openDialog('approve', item)}>
                            <BadgeCheck size={13} aria-hidden /> Freigeben
                          </button>
                        )}
                        {item.state === 'approved' && (
                          <button className="tmexp-btn tmexp-btn--sm tmexp-btn--danger" onClick={() => openDialog('execute', item)}>
                            <Send size={13} aria-hidden /> Exportieren
                          </button>
                        )}
                        {item.state === 'exported' && (
                          <button className="tmexp-btn tmexp-btn--sm tmexp-btn--warn" onClick={() => openDialog('rollback', item)}>
                            <RotateCcw size={13} aria-hidden /> Rollback
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detailId !== null && (
        <DetailModal id={detailId} onClose={() => { setDetailId(null); loadList(); }} onAction={(kind, item) => { setDetailId(null); openDialog(kind, item); }} list={list} />
      )}

      {dialog && (
        <ConfirmDialog
          dialog={dialog}
          checked={checkedConfirmed}
          setChecked={setCheckedConfirmed}
          busy={busy}
          error={actionError}
          onCancel={() => setDialog(null)}
          onConfirm={runApproveExecuteRollback}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detailansicht                                                      */
/* ------------------------------------------------------------------ */
function DetailModal({ id, onClose, onAction, list }: {
  id: number;
  onClose: () => void;
  onAction: (kind: DialogKind, item: ListItem) => void;
  list: ListResponse | null;
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openTmTable, setOpenTmTable] = useState(true);
  const [assigningId, setAssigningId] = useState<number | null>(null);
  const [assignMsg, setAssignMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reloadDetail = useCallback(async () => {
    try {
      setDetail(await req<DetailResponse>(`/api/tm-cost-export/${id}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    reloadDetail();
  }, [reloadDetail]);

  // Manuelle Bestätigung einer weak-Zuordnung:
  // 1) Override anlegen (POST /api/sessions/{id}/match)
  // 2) Allokationen neu berechnen (nur CTL — niemals TeslaMate)
  // 3) Detail neu laden
  const confirmFragment = async (tmChargeId: number) => {
    setAssigningId(tmChargeId);
    setAssignMsg(null);
    try {
      await req(`/api/sessions/${id}/match`, {
        method: 'POST',
        body: JSON.stringify({ tm_charge_id: tmChargeId }),
      });
      await req('/api/tm-cost-export/refresh', { method: 'POST' });
      await reloadDetail();
      setAssignMsg({ ok: true, text: `TM-Charge ${tmChargeId} als manual_override bestätigt — Session ist jetzt exportfähig (nach Freigabe).` });
    } catch (e) {
      setAssignMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setAssigningId(null);
    }
  };

  const itemForActions = useMemo(
    () => list?.data.find((i) => i.evcc_session_id === id),
    [list, id],
  );

  const st = detail ? (STATE_LABELS[detail.state] ?? { label: detail.state, cls: 'draft' }) : null;

  return (
    <div className="tmexp-modal-backdrop" onClick={onClose} role="presentation">
      <div className="tmexp-modal" role="dialog" aria-modal="true" aria-label="Session-Detail" onClick={(e) => e.stopPropagation()}>
        <header className="tmexp-modal__header">
          <h2>EVCC Session #{id}</h2>
          {st && <span className={`tmexp-badge tmexp-badge--${st.cls}`}>{st.label}</span>}
          <button className="tmexp-iconbtn" onClick={onClose} aria-label="Schließen"><X size={18} /></button>
        </header>

        {err && <div className="tmexp-alert tmexp-alert--error">{err}</div>}
        {!detail && !err && <p className="tmexp-empty">Lade…</p>}

        {detail && (
          <>
            {/* Blockierungsgründe */}
            {detail.block_reasons.length > 0 && (
              <div className="tmexp-alert tmexp-alert--warn">
                <Ban size={15} aria-hidden />
                <span>
                  <strong>Blockiert:</strong>&nbsp;
                  {detail.block_reasons.map((r) => REASON_LABELS[r] ?? r).join(' · ')}
                  {detail.block_reasons.includes('weak_or_rejected_match') && (
                    <>
                      {' '}— Du kannst fragliche Zuordnungen unten <strong>manuell bestätigen</strong> („Bestätigen“-Button je Zeile).
                      Bestätigte Ladungen werden als <em>manual_override</em> geführt und sind dann exportfähig.
                    </>
                  )}
                </span>
              </div>
            )}

            {assignMsg && (
              <div className={`tmexp-alert ${assignMsg.ok ? 'tmexp-alert--ok' : 'tmexp-alert--error'}`}>
                {assignMsg.ok ? <CheckCircle2 size={15} aria-hidden /> : <Ban size={15} aria-hidden />}
                {assignMsg.text}
              </div>
            )}

            <section className="tmexp-facts">
              <div><dt>Zeitraum</dt><dd>{fmtDate(detail.evcc_session.date)}</dd></div>
              <div><dt>EVCC Wallbox-kWh</dt><dd>{fmtKwh(detail.evcc_session.kwh)}</dd></div>
              <div><dt>EVCC Gesamtkosten</dt><dd>{fmtEur(detail.evcc_session.total_cost_eur)}</dd></div>
              <div><dt>TM-Fragmente</dt><dd>{detail.tm_fragment_count}</dd></div>
              <div><dt>TM-used-Summe</dt><dd>{fmtKwh(detail.tm_used_kwh_total, 2)}</dd></div>
              <div><dt>Ladeverlust</dt><dd>{detail.loss_kwh !== null ? `${fmtKwh(detail.loss_kwh)} (${detail.loss_pct} %)` : '—'}</dd></div>
              <div><dt>Effektiver Preis</dt><dd>{detail.effective_price_eur_per_kwh ? detail.effective_price_eur_per_kwh.toLocaleString('de-DE', { maximumFractionDigits: 6 }) + ' €/kWh' : '—'}</dd></div>
              <div><dt>Match-Qualität</dt><dd>{detail.match_qualities.join(', ') || '—'}</dd></div>
            </section>

            {/* TM-Tabelle */}
            <button className="tmexp-collapse" onClick={() => setOpenTmTable(!openTmTable)}>
              <ChevronDown size={14} className={openTmTable ? '' : 'rot'} aria-hidden />
              TM-Ladungen ({detail.fragments.length})
            </button>
            {openTmTable && (
              <div className="tmexp-table-wrap tmexp-table-wrap--modal">
                <table className="tmexp-table">
                  <thead>
                    <tr>
                      <th>TM Charge-ID</th>
                      <th>charging_process-ID</th>
                      <th>TM-used kWh</th>
                      <th>Alter TM-Wert</th>
                      <th>Neuer geplanter Wert</th>
                      <th>Kostenquelle</th>
                      <th>Match</th>
                      <th>Aktion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.fragments.map((f) => {
                      // Bestätigen für ALLE nicht-manuellen Fragmente:
                      // weak, blocked und auch superseded (durch eine frühere
                      // Bestätigung derselben Session ersetzte Auto-Zeilen).
                      // Jede Bestätigung erzeugt einen manual_assign-Override;
                      // die Override-Injektion gruppiert ALLE Overrides der
                      // Session neu. Nach Export: keine Bestätigung mehr.
                      const canConfirm =
                        f.match_quality !== 'manual_override' &&
                        detail.state !== 'exported';
                      const wasSuperseded = f.exclusion_reason?.includes('superseded');
                      return (
                      <tr key={f.allocation_id}>
                        <td>{f.tm_charge_id}</td>
                        <td>{f.tm_charging_process_id}</td>
                        <td>{fmtKwh(f.tm_used_kwh, 2)}</td>
                        <td>{fmtEur(f.old_tm_cost_eur)}</td>
                        <td className="tmexp-strong">{fmtEur(f.new_planned_tm_cost_eur)}</td>
                        <td>{f.cost_source}</td>
                        <td><span className={`tmexp-matchq tmexp-matchq--${f.match_quality}`}>{f.match_quality}</span></td>
                        <td>
                          {canConfirm && (
                            <button
                              className="tmexp-btn tmexp-btn--sm"
                              disabled={assigningId !== null}
                              onClick={() => confirmFragment(f.tm_charge_id)}
                              title={wasSuperseded
                                ? 'Diese Zuordnung erneut bestätigen (Override) — alle bestätigten Zuordnungen dieser Session werden zusammen neu allokiert'
                                : 'Diese Zuordnung manuell bestätigen (Override) — alle bestätigten Zuordnungen dieser Session werden zusammen neu allokiert'}
                            >
                              <BadgeCheck size={13} aria-hidden />
                              {assigningId === f.tm_charge_id ? '…' : 'Bestätigen'}
                            </button>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}><strong>Summe</strong></td>
                      <td><strong>{fmtKwh(detail.tm_used_kwh_total, 2)}</strong></td>
                      <td />
                      <td className={detail.sum_equals_evcc ? 'tmexp-ok' : 'tmexp-mismatch'}>
                        <strong>{fmtEur(detail.sum_planned_eur)}</strong>
                      </td>
                      <td colSpan={3} className={detail.sum_equals_evcc ? 'tmexp-ok' : 'tmexp-mismatch'}>
                        {detail.sum_equals_evcc ? '= EVCC-Gesamtkosten ✓' : '⚠ weicht von EVCC-Gesamtkosten ab!'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <footer className="tmexp-modal__footer">
              {!detail.tm_db_configured && (
                <span className="tmexp-dbhint"><Clock size={13} aria-hidden /> TeslaMate-DB nicht konfiguriert (TESLAMATE_DB_* ) — Prüfung ohne Live-Alterwerte.</span>
              )}
              {itemForActions && detail.state === 'draft' && !detail.block_reasons.length && (
                <button className="tmexp-btn tmexp-btn--primary" onClick={() => onAction('approve', itemForActions)}>
                  <BadgeCheck size={14} aria-hidden /> Freigeben…
                </button>
              )}
              {itemForActions && detail.state === 'approved' && (
                <button className="tmexp-btn tmexp-btn--danger" onClick={() => onAction('execute', itemForActions)}>
                  <Download size={14} aria-hidden /> Exportieren…
                </button>
              )}
              {itemForActions && detail.state === 'exported' && (
                <button className="tmexp-btn tmexp-btn--warn" onClick={() => onAction('rollback', itemForActions)}>
                  <RotateCcw size={14} aria-hidden /> Rollback…
                </button>
              )}
              <button className="tmexp-btn" onClick={onClose}>Schließen</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bestätigungs-Dialoge                                               */
/* ------------------------------------------------------------------ */
function ConfirmDialog({ dialog, checked, setChecked, busy, error, onCancel, onConfirm }: {
  dialog: { kind: DialogKind; item: ListItem };
  checked: boolean;
  setChecked: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { kind, item } = dialog;

  const texts: Record<DialogKind, { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean }> = {
    approve: {
      title: 'Freigabe bestätigen',
      confirmLabel: 'Ich habe die Zuordnung und die Kosten geprüft.',
      body: (
        <>
          <dl className="tmexp-summary">
            <div><dt>EVCC Session</dt><dd>#{item.evcc_session_id} · {fmtDate(item.date)}</dd></div>
            <div><dt>EVCC Energie</dt><dd>{fmtKwh(item.evcc_kwh)}</dd></div>
            <div><dt>EVCC Gesamtkosten</dt><dd>{fmtEur(item.evcc_total_cost_eur)}</dd></div>
            <div><dt>TM-Fragmente</dt><dd>{item.fragment_count}</dd></div>
            <div><dt>Geplanter Exportbetrag</dt><dd><strong>{fmtEur(item.planned_export_eur)}</strong></dd></div>
          </dl>
          <p>Nach der Freigabe kann per „Exportieren“ der tatsächliche Writeback erfolgen. Es wird noch <strong>nichts</strong> in TeslaMate geschrieben.</p>
        </>
      ),
    },
    execute: {
      title: 'Export nach TeslaMate',
      danger: true,
      confirmLabel: 'Ich will diese Werte jetzt in TeslaMate schreiben.',
      body: (
        <>
          <div className="tmexp-alert tmexp-alert--warn"><AlertTriangle size={15} aria-hidden /> Dies schreibt Kosten in TeslaMate. Die bisherigen Werte werden gesichert und können über Rollback wiederhergestellt werden.</div>
          <dl className="tmexp-summary">
            <div><dt>EVCC Session</dt><dd>#{item.evcc_session_id} · {fmtDate(item.date)}</dd></div>
            <div><dt>Anzahl Ladungen</dt><dd>{item.fragment_count}</dd></div>
            <div><dt>Gesamter neuer TM-Betrag</dt><dd><strong>{fmtEur(item.planned_export_eur)}</strong></dd></div>
          </dl>
        </>
      ),
    },
    rollback: {
      title: 'Rollback des Exports',
      danger: true,
      confirmLabel: 'Ich will die Original-TM-Kosten wiederherstellen.',
      body: (
        <>
          <div className="tmexp-alert tmexp-alert--info">Die bei Export gesicherten Originalwerte (previous_tm_cost_eur) werden exakt zurückgeschrieben.</div>
          <dl className="tmexp-summary">
            <div><dt>EVCC Session</dt><dd>#{item.evcc_session_id} · {fmtDate(item.date)}</dd></div>
            <div><dt>Zurückgesetzter Betrag</dt><dd><strong>{fmtEur(item.planned_export_eur)}</strong></dd></div>
          </dl>
          Alte und neue Werte je Ladung stehen in der Detailansicht.
        </>
      ),
    },
  };

  const t = texts[kind];

  return (
    <div className="tmexp-modal-backdrop" onClick={onCancel} role="presentation">
      <div className="tmexp-modal tmexp-modal--confirm" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="tmexp-modal__header">
          <h2>{t.title}</h2>
          <button className="tmexp-iconbtn" onClick={onCancel} aria-label="Abbrechen"><X size={18} /></button>
        </header>

        <div className="tmexp-modal__body">{t.body}</div>

        {error && <div className="tmexp-alert tmexp-alert--error"><Ban size={15} aria-hidden /> {error}</div>}

        <label className="tmexp-confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={busy} />
          <span>{t.confirmLabel}</span>
        </label>

        <footer className="tmexp-modal__footer">
          <button className="tmexp-btn" onClick={onCancel} disabled={busy}>Abbrechen</button>
          <button
            className={`tmexp-btn ${t.danger ? 'tmexp-btn--danger' : 'tmexp-btn--primary'}`}
            onClick={onConfirm}
            disabled={!checked || busy}
          >
            {kind === 'execute' && <><Send size={14} aria-hidden /> Jetzt exportieren</>}
            {kind === 'approve' && <><CheckCircle2 size={14} aria-hidden /> Freigeben</>}
            {kind === 'rollback' && <><RotateCcw size={14} aria-hidden /> Zurücksetzen</>}
          </button>
        </footer>
      </div>
    </div>
  );
}
