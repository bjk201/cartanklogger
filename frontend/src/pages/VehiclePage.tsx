import React, { useState, useEffect } from 'react';
import { api } from '../lib/apiClient';
import type { VehicleRecordRead, VehicleRecordCreate, VehicleRecordUpdate } from '../types/api';
import './VehiclePage.css';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ===== Gefahrene km je Satz aus der Montage-Historie =====
   - Geschlossene Montagen: km_off − km_on
   - Offene Montage (aktiv): aktueller TM-Drives-Stand − km_on
     → die km des montierten Satzes wachsen automatisch mit jedem
     TM-Drive („täglich angepasst"), ohne dass ein Eintrag geändert wird. */
interface TireKmInfo {
  km: number | null;
  detail: string;
  mountCount: number;
  open: boolean;
}

function computeTireKm(
  rec: VehicleRecordRead,
  currentOdometer: number | null,
): TireKmInfo {
  const mounts = rec.mounts || [];

  if (mounts.length === 0) {
    // Legacy ohne Mount-Historie: alte Statische Bilanz verwenden
    if (rec.odometer_km != null && rec.start_odometer_km != null) {
      return {
        km: Math.max(0, Math.round(rec.odometer_km - rec.start_odometer_km)),
        detail: `${Math.round(rec.start_odometer_km).toLocaleString('de-DE')} → ${Math.round(rec.odometer_km).toLocaleString('de-DE')}`,
        mountCount: 0,
        open: rec.is_active === true,
      };
    }
    return { km: null, detail: '', mountCount: 0, open: rec.is_active === true };
  }

  let total = 0;
  let hasAny = false;
  let open = false;
  for (const m of mounts) {
    const on = m.km_on;
    const off = m.demounted_at == null ? (currentOdometer ?? m.km_off) : m.km_off;
    if (m.demounted_at == null) open = true;
    if (on != null && off != null) {
      total += Math.max(0, off - on);
      hasAny = true;
    }
  }
  // Detail: letzte Montage-Periode
  const last = mounts[mounts.length - 1];
  const lastOn = last.km_on != null ? Math.round(last.km_on).toLocaleString('de-DE') : '—';
  let lastOff: string;
  if (last.demounted_at == null) {
    lastOff = currentOdometer != null
      ? `${Math.round(currentOdometer).toLocaleString('de-DE')} (live)`
      : '…';
  } else {
    lastOff = last.km_off != null ? Math.round(last.km_off).toLocaleString('de-DE') : '…';
  }
  return {
    km: hasAny ? Math.round(total) : null,
    detail: `${lastOn} → ${lastOff}`,
    mountCount: mounts.length,
    open,
  };
}

/* ===== Edit-Modal (Service + Reifen) ===== */
interface EditModalProps {
  record: VehicleRecordRead | null;
  onClose: () => void;
  onSaved: () => void;
  mode: 'edit' | 'new-service' | 'new-tireset';
}

function EditModal({ record, onClose, onSaved, mode }: EditModalProps) {
  const [date, setDate] = useState(record?.date?.slice(0, 10) || todayStr());
  const [title, setTitle] = useState(record?.title || '');
  const [odometer, setOdometer] = useState(record?.odometer_km?.toString() || '');
  const [cost, setCost] = useState(record?.cost_eur?.toString() || '');
  const [shop, setShop] = useState(record?.shop || '');
  const [note, setNote] = useState(record?.note || '');
  const [tireBrand, setTireBrand] = useState(record?.tire_brand || '');
  const [tireSeason, setTireSeason] = useState(record?.tire_season || 'Sommer');
  const [tireTitle, setTireTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const isTireSet = mode === 'new-tireset';
  const isService = mode === 'new-service' || (mode === 'edit' && record?.record_type === 'service');
  const isAccessory = mode === 'edit' || mode === 'new-service';

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!date.trim()) errs.date = 'Datum erforderlich';
    if (!isTireSet && !title.trim()) errs.title = 'Beschreibung erforderlich';
    if (isTireSet && !tireBrand.trim()) errs.brand = 'Reifenmarke erforderlich';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    setError(null);

    try {
      if (mode === 'edit' && record) {
        const payload: VehicleRecordUpdate = {
          date,
          title: title.trim(),
          odometer_km: odometer ? Number(odometer) : undefined,
          cost_eur: cost ? Number(cost) : undefined,
          shop: shop.trim() || undefined,
          note: note.trim() || undefined,
        };
        const res = await api.updateVehicleRecord(record.id, payload);
        if (!res.ok) { setError(res.errors?.[0]?.message || 'Fehler'); setSaving(false); return; }
      } else if (isTireSet) {
        // Reifensatz: EIN Eintrag für den ganzen Satz (kein 4-fach-Loop).
        // Titel = Marke + Saison (Beschreibung Feld für Frei-Text).
        const payload: VehicleRecordCreate = {
          record_type: 'tire',
          date,
          title: tireTitle.trim() || `${tireBrand.trim()} ${tireSeason}`,
          odometer_km: odometer ? Number(odometer) : undefined,
          cost_eur: cost ? Number(cost) : undefined,
          note: note.trim() || undefined,
          tire_brand: tireBrand.trim(),
          tire_season: tireSeason,
        };
        const res = await api.createVehicleRecord(payload);
        if (!res.ok) { setError(res.errors?.[0]?.message || 'Fehler'); setSaving(false); return; }
      } else if (isAccessory) {
        // Neuer Service-Eintrag
        const payload: VehicleRecordCreate = {
          record_type: 'service',
          date,
          title: title.trim(),
          odometer_km: odometer ? Number(odometer) : undefined,
          cost_eur: cost ? Number(cost) : undefined,
          shop: shop.trim() || undefined,
          note: note.trim() || undefined,
        };
        const res = await api.createVehicleRecord(payload);
        if (!res.ok) { setError(res.errors?.[0]?.message || 'Fehler'); setSaving(false); return; }
      }

      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            {mode === 'edit' ? 'Eintrag bearbeiten' :
             mode === 'new-tireset' ? 'Neuer Reifensatz' :
             'Service eintragen'}
          </h3>
          <button className="modal-close-btn" onClick={onClose} aria-label="Schließen">&times;</button>
        </div>
        <div className="modal-body">
          <form onSubmit={handleSubmit} className="record-form">
            <div className="form-field">
              <label className="form-label">Datum *</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
              {fieldErrors.date && <span className="form-error">{fieldErrors.date}</span>}
            </div>

            {isTireSet ? (
              <>
                <div className="form-field">
                  <label className="form-label">Reifenmarke *</label>
                  <input type="text" placeholder="z.B. Michelin, Continental" value={tireBrand} onChange={e => setTireBrand(e.target.value)} />
                  {fieldErrors.brand && <span className="form-error">{fieldErrors.brand}</span>}
                </div>
                <div className="form-field">
                  <label className="form-label">Saison</label>
                  <select value={tireSeason} onChange={e => setTireSeason(e.target.value)}>
                    <option value="Sommer">Sommer</option>
                    <option value="Winter">Winter</option>
                    <option value="Ganzjahres">Ganzjahres</option>
                  </select>
                </div>
                <div className="form-field">
                  <label className="form-label">Beschreibung (optional)</label>
                  <input type="text" placeholder="z.B. Michelin Primacy 4, 19 Zoll" value={tireTitle} onChange={e => setTireTitle(e.target.value)} />
                </div>
                <p className="form-hint">Ein Satz = ein Eintrag. Der Satz gilt als montiert (solange kein anderer montiert ist) — abmontierte Sätze kommen ins Lager und können mehrfach wieder montiert werden. Archivieren ist eine separate Aktion.</p>
              </>
            ) : (
              <div className="form-field">
                <label className="form-label">Beschreibung *</label>
                <input type="text" placeholder="z.B. Ölwechsel, Inspektion, sonstiges" value={title} onChange={e => setTitle(e.target.value)} />
                {fieldErrors.title && <span className="form-error">{fieldErrors.title}</span>}
              </div>
            )}

            <div className="form-row">
              <div className="form-field">
                <label className="form-label">km-Stand</label>
                <input type="number" min="0" placeholder="z.B. 85000" value={odometer} onChange={e => setOdometer(e.target.value)} />
              </div>
              <div className="form-field">
                <label className="form-label">Kosten (€)</label>
                <input type="number" min="0" step="0.01" placeholder="0.00" value={cost} onChange={e => setCost(e.target.value)} />
              </div>
            </div>

            {!isTireSet && (
              <div className="form-field">
                <label className="form-label">Werkstatt</label>
                <input type="text" placeholder="Name der Werkstatt" value={shop} onChange={e => setShop(e.target.value)} />
              </div>
            )}

            <div className="form-field">
              <label className="form-label">Notiz</label>
              <textarea placeholder="Optionale Notiz…" value={note} onChange={e => setNote(e.target.value)} rows={2} />
            </div>

            {error && <div className="form-submit-error">{error}</div>}

            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Abbrechen</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Wird gespeichert…' : (mode === 'edit' ? 'Speichern' : (isTireSet ? 'Reifensatz anlegen' : 'Service speichern'))}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ===== Hauptseite ===== */
export default function VehiclePage() {
  const [records, setRecords] = useState<VehicleRecordRead[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<'new-service' | 'new-tireset' | null>(null);
  const [editRecord, setEditRecord] = useState<VehicleRecordRead | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<VehicleRecordRead | null>(null);
  const [demountTarget, setDemountTarget] = useState<VehicleRecordRead | null>(null);
  const [mountTarget, setMountTarget] = useState<VehicleRecordRead | null>(null);
  const [currentOdometer, setCurrentOdometer] = useState<number | null>(null);

  async function fetchRecords() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getVehicleRecords();
      const all: VehicleRecordRead[] = [
        ...(data.services || []),
        ...(data.tires || []),
      ];
      setRecords(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchRecords(); }, []);

  // Aktuellen km-Stand aus /vehicle/info holen (TM-Drives, sonst max. Record)
  useEffect(() => {
    api.getVehicleInfo()
      .then((res: any) => {
        const odo = res?.data?.current_odometer_km;
        if (typeof odo === 'number') setCurrentOdometer(odo);
      })
      .catch(() => { /* Info bleibt dann null */ });
  }, []);

  const handleDelete = async (record: VehicleRecordRead) => {
    const label = record.record_type === 'service' ? record.title : `${record.tire_brand || 'Reifensatz'}`;
    if (!window.confirm(`"${label}" wirklich löschen?`)) return;
    try {
      await api.deleteVehicleRecord(record.id);
      fetchRecords();
    } catch (e) {
      alert('Fehler beim Löschen: ' + (e instanceof Error ? e.message : 'Unbekannt'));
    }
  };

  // KM-Stand automatisch ableiten für Einträge ohne km (Zubehör etc.)
  const handleSyncOdometer = async (record: VehicleRecordRead) => {
    try {
      await api.syncRecordOdometer(record.id);
      fetchRecords();
    } catch (e) {
      alert('KM-Ableitung fehlgeschlagen: ' + (e instanceof Error ? e.message : 'Unbekannt'));
    }
  };

  // Archivieren = SEPARATE Aktion (bewusst, mit Rückfrage)
  const handleArchive = async (rec: VehicleRecordRead) => {
    const label = rec.tire_brand || rec.title || 'Reifensatz';
    if (!window.confirm(`"${label}" archivieren?\n\nArchivierte Sätze behalten ihre km-Bilanz, können aber nicht wieder montiert werden (Rückgängig möglich).`)) return;
    try {
      await api.archiveTireSet(rec.id);
      fetchRecords();
    } catch (e) {
      alert('Archivieren fehlgeschlagen: ' + (e instanceof Error ? e.message : 'Unbekannt'));
    }
  };

  const handleUnarchive = async (rec: VehicleRecordRead) => {
    try {
      await api.unarchiveTireSet(rec.id);
      fetchRecords();
    } catch (e) {
      alert('Reaktivieren fehlgeschlagen: ' + (e instanceof Error ? e.message : 'Unbekannt'));
    }
  };

  const services = (records || []).filter(r => r.record_type === 'service');
  const tires = (records || []).filter(r => r.record_type === 'tire');

  const openReplaceDialog = (rec: VehicleRecordRead) => {
    // Vorbefüllung: aktueller TM-Stand, sonst letzter Stand des alten Satzes
    if (currentOdometer == null && rec.odometer_km != null) {
      setCurrentOdometer(rec.odometer_km);
    }
    setReplaceTarget(rec);
  };

  return (
    <div className="page-container">
      <header className="page__header">
        <h1 className="page__title">Fahrzeug</h1>
      </header>

      {/* Service & Wartung */}
      <section className="overview-page__section">
        <div className="overview-page__section-header">
          <h2 className="overview-page__section-title">Service & Wartung</h2>
          <button className="btn-add" onClick={() => setModalMode('new-service')}>+ Eintragen</button>
        </div>
        {loading ? (
          <p className="vehicle-page__loading">Lädt…</p>
        ) : error ? (
          <p className="vehicle-page__error">{error}</p>
        ) : services.length === 0 ? (
          <p className="vehicle-page__empty">Keine Einträge vorhanden.</p>
        ) : (
          <div className="vehicle-records-section">
            <div className="table-header service-table-header">
              <div className="col col-date">Datum</div>
              <div className="col col-desc">Beschreibung</div>
              <div className="col col-km">km-Stand</div>
              <div className="col col-shop">Werkstatt</div>
              <div className="col col-cost">Kosten</div>
              <div className="col col-actions">Aktion</div>
            </div>
            <div className="table-body">
              {services.map(rec => (
                <div key={rec.id} className="table-row service-row">
                  <div className="col col-date">{rec.date?.slice(0, 10) || '—'}</div>
                  <div className="col col-desc">{rec.title || '—'}</div>
                  <div className="col col-km">{rec.odometer_km != null ? rec.odometer_km.toLocaleString('de-DE') : '—'}</div>
                  <div className="col col-shop">{rec.shop || '—'}</div>
                  <div className="col col-cost">{rec.cost_eur != null ? rec.cost_eur.toFixed(2) + ' €' : '—'}</div>
                  <div className="col col-actions">
                    <button className="btn-icon" onClick={() => setEditRecord(rec)} title="Bearbeiten">✎</button>
                    <button className="btn-icon btn-icon--danger" onClick={() => handleDelete(rec)} title="Löschen">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Reifen: EIN Satz = EIN Eintrag — Montiert / Im Lager / Archiviert */}
      <section className="overview-page__section">
        <div className="overview-page__section-header">
          <h2 className="overview-page__section-title">Reifen</h2>
          <button className="btn-add" onClick={() => setModalMode('new-tireset')}>+ Neuer Reifensatz</button>
        </div>
        {loading ? (
          <p className="vehicle-page__loading">Lädt…</p>
        ) : tires.length === 0 ? (
          <p className="vehicle-page__empty">Keine Reifensätze erfasst.</p>
        ) : (
          <div className="vehicle-records-section">
            <div className="table-header tire-table-header">
              <div className="col col-brand">Reifensatz</div>
              <div className="col col-season">Saison</div>
              <div className="col col-km">Gefahren (km)</div>
              <div className="col col-cost">Kosten</div>
              <div className="col col-status">Status</div>
              <div className="col col-actions">Aktion</div>
            </div>
            <div className="table-body">
              {tires.sort((a, b) => {
                // montiert → Lager → Archiv
                const rank = (r: VehicleRecordRead) => (r.is_active ? 0 : (r.is_archived ? 2 : 1));
                if (rank(a) !== rank(b)) return rank(a) - rank(b);
                const da = a.date || '';
                const db_ = b.date || '';
                return db_.localeCompare(da);
              }).map(rec => {
                // Gefahrene km je Satz aus der Montage-Historie:
                // - Geschlossene Montagen: km_off − km_on (Summe)
                // - Aktuell montiert: aktueller Tacho (TM-Drives, täglich aktuell) − km_on
                const km = computeTireKm(rec, currentOdometer);
                return (
                  <div key={rec.id} className={`table-row tire-row ${rec.is_active ? 'tire-active' : ''} ${rec.is_archived ? 'tire-archived' : ''}`}>
                    <div className="col col-brand" data-label="Reifensatz">
                      <div className="tire-set-title">{rec.tire_brand || rec.title || '—'}</div>
                      {rec.title && rec.tire_brand && rec.title !== rec.tire_brand && (
                        <div className="tire-set-subtitle">{rec.title}</div>
                      )}
                      {km.mountCount > 1 && (
                        <div className="tire-mount-count">{km.mountCount} Montagen</div>
                      )}
                    </div>
                    <div className="col col-season" data-label="Saison">
                      {rec.tire_season && (
                        <span className={`tire-season-label tire-season--${rec.tire_season.toLowerCase()}`}>{rec.tire_season}</span>
                      ) || '—'}
                    </div>
                    <div className="col col-km" data-label="Gefahren">
                      {km.km != null
                        ? <><strong>{km.km.toLocaleString('de-DE')}</strong> km</>
                        : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                      <div className="tire-km-detail">{km.detail}</div>
                    </div>
                    <div className="col col-cost" data-label="Kosten">{rec.cost_eur != null ? rec.cost_eur.toFixed(2) + ' €' : '—'}</div>
                    <div className="col col-status" data-label="Status">
                      {rec.is_active
                        ? <span className="status-active">● Montiert</span>
                        : rec.is_archived
                          ? <span className="status-archived">● Archiviert</span>
                          : <span className="status-storage">● Im Lager</span>}
                    </div>
                    <div className="col col-actions" data-label="Aktion">
                      {rec.is_active && (
                        <>
                          <button className="btn-icon" title="Anderen Satz montieren (dieser kommt ins Lager, NICHT ins Archiv)" onClick={() => setReplaceTarget(rec)}>⇄</button>
                          <button className="btn-icon" title="Abmontieren — Satz kommt ins Lager (kann wieder montiert werden)" onClick={() => setDemountTarget(rec)}>⤓</button>
                        </>
                      )}
                      {!rec.is_active && !rec.is_archived && (
                        <button className="btn-icon" title="Diesen Satz wieder montieren" onClick={() => setMountTarget(rec)}>⤒</button>
                      )}
                      {rec.is_archived ? (
                        <button className="btn-icon" title="Archivierung aufheben — Satz ist wieder im Lager" onClick={() => handleUnarchive(rec)}>↩</button>
                      ) : (
                        <button className="btn-icon" title="Archivieren (separater Endzustand)" onClick={() => handleArchive(rec)} disabled={rec.is_active}>⌫</button>
                      )}
                      <button className="btn-icon" onClick={() => setEditRecord(rec)} title="Bearbeiten">✎</button>
                      <button className="btn-icon btn-icon--danger" onClick={() => handleDelete(rec)} title="Löschen">✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Modals */}
      {modalMode && (
        <EditModal mode={modalMode} record={null} onClose={() => setModalMode(null)} onSaved={fetchRecords} />
      )}
      {editRecord && (
        <EditModal mode="edit" record={editRecord} onClose={() => setEditRecord(null)} onSaved={fetchRecords} />
      )}
      {replaceTarget && (
        <ReplaceTireModal
          oldRecord={replaceTarget}
          currentOdometer={currentOdometer}
          onClose={() => setReplaceTarget(null)}
          onSaved={fetchRecords}
        />
      )}
      {demountTarget && (
        <MountActionModal
          mode="demount"
          target={demountTarget}
          currentOdometer={currentOdometer}
          onClose={() => setDemountTarget(null)}
          onSaved={fetchRecords}
        />
      )}
      {mountTarget && (
        <MountActionModal
          mode="mount"
          target={mountTarget}
          currentOdometer={currentOdometer}
          onClose={() => setMountTarget(null)}
          onSaved={fetchRecords}
        />
      )}
    </div>
  );
}

/* ===== Mount-Action-Modal: montieren / abmontieren ===== */
interface MountActionModalProps {
  mode: 'mount' | 'demount';
  target: VehicleRecordRead;
  currentOdometer: number | null;
  onClose: () => void;
  onSaved: () => void;
}

function MountActionModal({ mode, target, currentOdometer, onClose, onSaved }: MountActionModalProps) {
  const [date, setDate] = useState(todayStr());
  const [odometer, setOdometer] = useState(
    mode === 'mount' && currentOdometer != null ? String(Math.round(currentOdometer)) : '',
  );
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kmAuto = odometer === '';
  const label = target.tire_brand || target.title || 'Reifensatz';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = {
        date: `${date}T12:00:00`,
        odometer_km: odometer ? Number(odometer) : null,  // leer → Backend leitet ab
        note: note.trim() || null,
      };
      const res = mode === 'demount'
        ? await api.demountTireSet(target.id, data)
        : await api.mountTireSet(target.id, data);
      if (!res.ok) { setError(res.errors?.[0]?.message || 'Fehler'); setSaving(false); return; }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'demount' ? 'Reifensatz abmontieren' : 'Reifensatz montieren'}</h3>
          <button className="modal-close-btn" onClick={onClose} aria-label="Schließen">&times;</button>
        </div>
        <div className="modal-body">
          <p className="form-hint">
            {mode === 'demount'
              ? <>Demontiert <strong>{label}</strong> — der Satz kommt ins <strong>Lager</strong> (nicht ins Archiv) und kann jederzeit wieder montiert werden.</>
              : <>Montiert <strong>{label}</strong> wieder am Fahrzeug. Die gefahrenen km werden über alle Montagen summiert.</>}
          </p>
          <form onSubmit={handleSubmit} className="record-form">
            <div className="form-field">
              <label className="form-label">Datum *</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
            </div>
            <div className="form-field">
              <label className="form-label">km-Stand {mode === 'demount' ? 'bei Demontage' : 'bei Montage'}</label>
              <input
                type="number"
                min="0"
                placeholder={currentOdometer != null ? `z.B. ${Math.round(currentOdometer)}` : 'leer = automatisch'}
                value={odometer}
                onChange={e => setOdometer(e.target.value)}
              />
              {kmAuto && (
                <span className="form-hint">
                  {currentOdometer != null
                    ? `Leer gelassen → aktueller Stand ${Math.round(currentOdometer).toLocaleString('de-DE')} km wird eingetragen.`
                    : 'Leer gelassen → Stand wird automatisch abgeleitet.'}
                </span>
              )}
            </div>
            <div className="form-field">
              <label className="form-label">Notiz</label>
              <textarea placeholder="Optionale Notiz…" value={note} onChange={e => setNote(e.target.value)} rows={2} />
            </div>
            {error && <div className="form-submit-error">{error}</div>}
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Abbrechen</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Wird gespeichert…' : (mode === 'demount' ? 'Abmontieren' : 'Montieren')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ===== Replace-Modal: montierten Satz tauschen ===== */
interface ReplaceModalProps {
  oldRecord: VehicleRecordRead;
  currentOdometer: number | null;
  onClose: () => void;
  onSaved: () => void;
}

function ReplaceTireModal({ oldRecord, currentOdometer, onClose, onSaved }: ReplaceModalProps) {
  const [date, setDate] = useState(todayStr());
  const [brand, setBrand] = useState(oldRecord.tire_brand || '');
  const [season, setSeason] = useState(oldRecord.tire_season || 'Sommer');
  const [desc, setDesc] = useState('');
  const [odometer, setOdometer] = useState(currentOdometer != null ? String(Math.round(currentOdometer)) : '');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kmAuto = odometer === '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.replaceTireSet(oldRecord.id, {
        date: `${date}T12:00:00`,
        odometer_km: odometer ? Number(odometer) : null,  // leer → Backend leitet ab
        title: desc.trim() || `${brand.trim()} ${season}`,
        tire_brand: brand.trim() || null,
        tire_season: season,
        cost_eur: cost ? Number(cost) : null,
        note: note.trim() || null,
      });
      if (!res.ok) { setError(res.errors?.[0]?.message || 'Fehler'); setSaving(false); return; }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reifensatz wechseln</h3>
          <button className="modal-close-btn" onClick={onClose} aria-label="Schließen">&times;</button>
        </div>
        <div className="modal-body">
          <p className="form-hint">
            Legt einen neuen Satz an und montiert ihn. <strong>{oldRecord.tire_brand || 'Der aktuelle Satz'}</strong> kommt
            ins <strong>Lager</strong> (nicht ins Archiv!) und kann jederzeit wieder montiert werden.
          </p>
          <form onSubmit={handleSubmit} className="record-form">
            <div className="form-row">
              <div className="form-field">
                <label className="form-label">Datum *</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
              </div>
              <div className="form-field">
                <label className="form-label">Saison</label>
                <select value={season} onChange={e => setSeason(e.target.value)}>
                  <option value="Sommer">Sommer</option>
                  <option value="Winter">Winter</option>
                  <option value="Ganzjahres">Ganzjahres</option>
                </select>
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Reifenmarke *</label>
              <input type="text" placeholder="z.B. Michelin Primacy 4" value={brand} onChange={e => setBrand(e.target.value)} required />
            </div>
            <div className="form-field">
              <label className="form-label">Beschreibung (optional)</label>
              <input type="text" placeholder="z.B. 19 Zoll, 255/45 R19" value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
            <div className="form-row">
              <div className="form-field">
                <label className="form-label">km-Stand beim Wechsel</label>
                <input type="number" min="0" placeholder={currentOdometer != null ? `z.B. ${Math.round(currentOdometer)}` : 'leer = automatisch'} value={odometer} onChange={e => setOdometer(e.target.value)} />
                {kmAuto && <span className="form-hint">{currentOdometer != null ? `Leer gelassen → aktueller Stand ${Math.round(currentOdometer).toLocaleString('de-DE')} km wird eingetragen.` : 'Leer gelassen → Stand wird automatisch abgeleitet.'}</span>}
              </div>
              <div className="form-field">
                <label className="form-label">Kosten neuer Satz (€)</label>
                <input type="number" min="0" step="0.01" placeholder="0.00" value={cost} onChange={e => setCost(e.target.value)} />
              </div>
            </div>
            <div className="form-field">
              <label className="form-label">Notiz</label>
              <textarea placeholder="Optionale Notiz…" value={note} onChange={e => setNote(e.target.value)} rows={2} />
            </div>
            {error && <div className="form-submit-error">{error}</div>}
            <div className="form-actions">
              <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Abbrechen</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Wird gewechselt…' : 'Satz wechseln'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

