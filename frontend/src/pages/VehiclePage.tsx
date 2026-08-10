import React, { useState, useEffect } from 'react';
import { api } from '../lib/apiClient';
import type { VehicleRecordRead, VehicleRecordCreate, VehicleRecordUpdate } from '../types/api';
import './VehiclePage.css';

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const isTireSet = mode === 'new-tireset';
  const isService = mode === 'new-service' || (mode === 'edit' && record?.record_type === 'service');

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
        // Reifensatz: 4 Reifen anlegen (VL, VR, HL, HR)
        for (const pos of ['VL', 'VR', 'HL', 'HR']) {
          const payload: VehicleRecordCreate = {
            record_type: 'tire',
            date,
            title: `${tireBrand.trim()} Satz (${pos}, ${tireSeason})`,
            odometer_km: odometer ? Number(odometer) : undefined,
            cost_eur: cost ? Number(cost) : undefined,
            note: note.trim() || undefined,
            tire_brand: tireBrand.trim(),
            tire_position: pos,
            tire_season: tireSeason,
          };
          const res = await api.createVehicleRecord(payload);
          if (!res.ok) { setError(res.errors?.[0]?.message || 'Fehler'); setSaving(false); return; }
        }
      } else {
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
             mode === 'new-tireset' ? 'Reifensatz wechseln' :
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
                <p className="form-hint">Es werden 4 Reifen (VL, VR, HL, HR) angelegt.</p>
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

  const handleDelete = async (record: VehicleRecordRead) => {
    const label = record.record_type === 'service' ? record.title : `${record.tire_brand} ${record.tire_position}`;
    if (!window.confirm(`"${label}" wirklich löschen?`)) return;
    try {
      await api.deleteVehicleRecord(record.id);
      fetchRecords();
    } catch (e) {
      alert('Fehler beim Löschen: ' + (e instanceof Error ? e.message : 'Unbekannt'));
    }
  };

  const services = (records || []).filter(r => r.record_type === 'service');
  const tires = (records || []).filter(r => r.record_type === 'tire');

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

      {/* Reifen */}
      <section className="overview-page__section">
        <div className="overview-page__section-header">
          <h2 className="overview-page__section-title">Reifen</h2>
          <button className="btn-add" onClick={() => setModalMode('new-tireset')}>+ Reifensatz wechseln</button>
        </div>
        {loading ? (
          <p className="vehicle-page__loading">Lädt…</p>
        ) : tires.length === 0 ? (
          <p className="vehicle-page__empty">Keine Reifen erfasst.</p>
        ) : (
          <div className="vehicle-records-section">
            <div className="table-header tire-table-header">
              <div className="col col-pos">Position</div>
              <div className="col col-brand">Marke</div>
              <div className="col col-season">Saison</div>
              <div className="col col-km">km-Stand</div>
              <div className="col col-cost">Kosten</div>
              <div className="col col-status">Status</div>
              <div className="col col-actions">Aktion</div>
            </div>
            <div className="table-body">
              {tires.sort((a, b) => {
                if (a.is_active && !b.is_active) return -1;
                if (!a.is_active && b.is_active) return 1;
                return 0;
              }).map(rec => {
                const kmDriven = (rec.odometer_km != null && rec.start_odometer_km != null)
                  ? rec.odometer_km - rec.start_odometer_km : null;
                return (
                  <div key={rec.id} className={`table-row tire-row ${rec.is_active ? 'tire-active' : 'tire-replaced'}`}>
                    <div className="col col-pos">
                      {rec.tire_position ? (
                        <span className={`tire-badge tire-badge--${rec.tire_position.toLowerCase()}`}>{rec.tire_position}</span>
                      ) : '—'}
                    </div>
                    <div className="col col-brand">{rec.tire_brand || '—'}</div>
                    <div className="col col-season">
                      {rec.tire_season && (
                        <span className={`tire-season-label tire-season--${rec.tire_season.toLowerCase()}`}>{rec.tire_season}</span>
                      ) || '—'}
                    </div>
                    <div className="col col-km">
                      <div>{rec.odometer_km != null ? rec.odometer_km.toLocaleString('de-DE') + ' km' : '—'}</div>
                      {kmDriven != null && kmDriven > 0 && <div className="tire-km-driven">+{kmDriven.toLocaleString('de-DE')} km</div>}
                    </div>
                    <div className="col col-cost">{rec.cost_eur != null ? rec.cost_eur.toFixed(2) + ' €' : '—'}</div>
                    <div className="col col-status">
                      {rec.is_active ? <span className="status-active">● Aktiv</span> : <span className="status-replaced">● Ersetzt</span>}
                    </div>
                    <div className="col col-actions">
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
    </div>
  );
}