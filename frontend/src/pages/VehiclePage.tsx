import React, { useState, useEffect } from 'react';
import { api } from '../lib/apiClient';
import type { VehicleInfoResponse, VehicleRecordRead, VehicleRecordsResponse, VehicleRecordCreate, ExtraCostRead } from '../types/api';
import './VehiclePage.css';

// ─── Reusable Modal ─────────────────────────────────────────────
const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close-btn" onClick={onClose} aria-label="Schließen">&times;</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
};

// ─── Form field helpers ─────────────────────────────────────────
const FormField: React.FC<{ label: string; required?: boolean; error?: string; children: React.ReactNode }> = ({ label, required, error, children }) => (
  <div className="form-field">
    <label className="form-label">
      {label}{required && <span className="form-required">*</span>}
    </label>
    {children}
    {error && <span className="form-error">{error}</span>}
  </div>
);

// Helper: today as YYYY-MM-DD
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Service-Erfassungs-Modal ──────────────────────────────────
interface ServiceFormModalProps {
  onClose: () => void;
  onSaved: () => void;
}

const ServiceFormModal: React.FC<ServiceFormModalProps> = ({ onClose, onSaved }) => {
  const [date, setDate] = useState(todayStr());
  const [odometer, setOdometer] = useState('');
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState('');
  const [shop, setShop] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!date.trim()) errs.date = 'Datum ist erforderlich';
    if (!title.trim()) errs.title = 'Beschreibung ist erforderlich';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    setError(null);

    const payload: VehicleRecordCreate = {
      record_type: 'service',
      date: date,
      title: title.trim(),
      odometer_km: odometer ? Number(odometer) : undefined,
      cost_eur: cost ? Number(cost) : undefined,
      shop: shop.trim() || undefined,
      note: note.trim() || undefined,
    };

    try {
      const res = await api.createVehicleRecord(payload);
      if (res.ok) {
        onSaved();
        onClose();
      } else {
        setError(res.errors?.[0]?.message || 'Fehler beim Speichern');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Service eintragen" onClose={onClose}>
      <form onSubmit={handleSubmit} className="record-form">
        <FormField label="Datum" required error={fieldErrors.date}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </FormField>
        <FormField label="km-Stand">
          <input type="number" min="0" placeholder="z.B. 85000" value={odometer} onChange={e => setOdometer(e.target.value)} />
        </FormField>
        <FormField label="Beschreibung" required error={fieldErrors.title}>
          <input type="text" placeholder="z.B. Ölwechsel, Inspektion" value={title} onChange={e => setTitle(e.target.value)} />
        </FormField>
        <FormField label="Kosten (€)">
          <input type="number" min="0" step="0.01" placeholder="0.00" value={cost} onChange={e => setCost(e.target.value)} />
        </FormField>
        <FormField label="Werkstatt">
          <input type="text" placeholder="Name der Werkstatt" value={shop} onChange={e => setShop(e.target.value)} />
        </FormField>
        <FormField label="Notiz">
          <textarea placeholder="Optionale Notiz…" value={note} onChange={e => setNote(e.target.value)} rows={3} />
        </FormField>

        {error && <div className="form-submit-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Abbrechen</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Wird gespeichert…' : 'Service speichern'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ─── Reifen-Erfassungs-Modal (auch für Reifenwechsel) ──────────
interface TireFormModalProps {
  onClose: () => void;
  onSaved: () => void;
  /** Wenn gesetzt: Vorbefüllung für Reifenwechsel (Daten vom alten Reifen) */
  initialTire?: VehicleRecordRead | null;
  /** Modus "Wechseln": erzeugt neuen + deaktiviert alten */
  replaceMode?: boolean;
}

const TIRE_POSITIONS = ['VL', 'VR', 'HL', 'HR'];
const TIRE_SEASONS = ['Sommer', 'Winter', 'Ganzjahres'];

const TireFormModal: React.FC<TireFormModalProps> = ({ onClose, onSaved, initialTire, replaceMode }) => {
  const [date, setDate] = useState(todayStr());
  const [odometer, setOdometer] = useState('');
  const [brand, setBrand] = useState(initialTire?.tire_brand || '');
  const [position, setPosition] = useState(initialTire?.tire_position || 'VL');
  const [season, setSeason] = useState(initialTire?.tire_season || 'Sommer');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!date.trim()) errs.date = 'Datum ist erforderlich';
    if (!brand.trim()) errs.brand = 'Reifenmarke ist erforderlich';
    if (!TIRE_POSITIONS.includes(position)) errs.position = 'Bitte Position wählen';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    setError(null);

    const payload: VehicleRecordCreate = {
      record_type: 'tire',
      date,
      title: `${brand} ${position} (${season})`,
      odometer_km: odometer ? Number(odometer) : undefined,
      cost_eur: cost ? Number(cost) : undefined,
      note: note.trim() || undefined,
      tire_brand: brand.trim(),
      tire_position: position,
      tire_season: season,
    };

    try {
      if (replaceMode && initialTire) {
        // 1) Neuen Reifen anlegen
        const newRes = await api.createVehicleRecord(payload);
        if (!newRes.ok) {
          setError(newRes.errors?.[0]?.message || 'Fehler beim Erfassen des neuen Reifens');
          setSaving(false);
          return;
        }
        // 2) Alten Reifen als inaktiv markieren
        const replaceRes = await api.replaceTire(initialTire.id);
        if (!replaceRes.ok) {
          setError(replaceRes.errors?.[0]?.message || 'Fehler beim Deaktivieren des alten Reifens');
          setSaving(false);
          return;
        }
      } else {
        // Normale Erfassung
        const res = await api.createVehicleRecord(payload);
        if (!res.ok) {
          setError(res.errors?.[0]?.message || 'Fehler beim Speichern');
          setSaving(false);
          return;
        }
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
    <Modal title={replaceMode ? 'Reifen wechseln' : 'Reifen erfassen'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="record-form">
        {replaceMode && initialTire && (
          <div className="replace-info">
            Ersetzt: <strong>{initialTire.tire_brand}</strong> ({initialTire.tire_position}, {initialTire.tire_season})
          </div>
        )}

        <FormField label="Datum" required error={fieldErrors.date}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </FormField>
        <FormField label="km-Stand">
          <input type="number" min="0" placeholder="z.B. 85000" value={odometer} onChange={e => setOdometer(e.target.value)} />
        </FormField>
        <FormField label="Reifenmarke" required error={fieldErrors.brand}>
          <input type="text" placeholder="z.B. Michelin, Continental" value={brand} onChange={e => setBrand(e.target.value)} />
        </FormField>
        <FormField label="Position" required error={fieldErrors.position}>
          <div className="tire-position-select">
            {TIRE_POSITIONS.map(p => (
              <button
                key={p}
                type="button"
                className={`tire-position-btn ${position === p ? 'active' : ''}`}
                onClick={() => setPosition(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Saison">
          <select value={season} onChange={e => setSeason(e.target.value)}>
            {TIRE_SEASONS.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Kosten (€)">
          <input type="number" min="0" step="0.01" placeholder="0.00" value={cost} onChange={e => setCost(e.target.value)} />
        </FormField>
        <FormField label="Notiz">
          <textarea placeholder="Optionale Notiz…" value={note} onChange={e => setNote(e.target.value)} rows={3} />
        </FormField>

        {error && <div className="form-submit-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Abbrechen</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Wird gespeichert…' : (replaceMode ? 'Wechseln & speichern' : 'Reifen speichern')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ─── Tire Position Badge ────────────────────────────────────────
const TireBadge: React.FC<{ position: string }> = ({ position }) => (
  <span className={`tire-badge tire-badge--${position.toLowerCase()}`}>{position}</span>
);

// ─── Vehicle Info Card (unverändert) ────────────────────────────
const VehicleInfoCard: React.FC<{ info: VehicleInfoResponse | null; loading: boolean; error: string | null }> = ({ info, loading, error }) => {
  if (loading) return <div className="vehicle-info-card loading">Lädt Fahrzeuginfo…</div>;
  if (error) return <div className="vehicle-info-card error">Fehler: {error}</div>;
  if (!info?.ok) return <div className="vehicle-info-card empty">Keine Fahrzeugdaten verfügbar.</div>;

  const data = info.data;

  return (
    <div className="vehicle-info-card">
      <h3>Fahrzeug-Identität</h3>
      <div className="vehicle-info-grid">
        <div className="vehicle-info-row">
          <span className="label">Modell:</span>
          <span className="value">{data?.model || '—'}</span>
        </div>
        <div className="vehicle-info-row">
          <span className="label">VIN:</span>
          <span className="value">{data?.vin ? data.vin.slice(0, 8) + '****' : '—'}</span>
        </div>
        <div className="vehicle-info-row">
          <span className="label">Aktueller km-Stand:</span>
          <span className="value">{data?.current_odometer_km != null ? data.current_odometer_km.toLocaleString('de-DE') + ' km' : '—'}</span>
        </div>
        <div className="vehicle-info-row">
          <span className="label">Quelle:</span>
          <span className="value">{data?.source || '—'}</span>
        </div>
      </div>
    </div>
  );
};

// ─── Records Section (Service oder Reifen) ─────────────────────
interface VehicleRecordsSectionProps {
  records: VehicleRecordRead[] | null;
  loading: boolean;
  error: string | null;
  title: string;
  typeFilter: VehicleRecordRead['record_type'];
  /** Button zum Hinzufügen (wird oberhalb der Liste angezeigt) */
  addButtonLabel?: string;
  onAdd?: () => void;
  /** Wird für jeden Eintrag im Reifen-Modus gerendert */
  onReplaceTire?: (tire: VehicleRecordRead) => void;
  /** Extra costs linked to tires */
  extraCosts?: ExtraCostRead[];
}

const VehicleRecordsSection: React.FC<VehicleRecordsSectionProps> = ({
  records, loading, error, title, typeFilter,
  addButtonLabel, onAdd, onReplaceTire, extraCosts,
}) => {
  if (loading) return <div className="vehicle-records-section loading">Lädt {title}…</div>;
  if (error) return <div className="vehicle-records-section error">Fehler: {error}</div>;

  const filtered = records?.filter(r => r.record_type === typeFilter) || [];
  const isTire = typeFilter === 'tire';

  // Reifen sortieren: aktive zuerst
  const sorted = isTire
    ? [...filtered].sort((a, b) => {
        if (a.is_active && !b.is_active) return -1;
        if (!a.is_active && b.is_active) return 1;
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      })
    : [...filtered].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="vehicle-records-section">
      <div className="section-header">
        <h3>{title} <span className="record-count">({filtered.length})</span></h3>
        {addButtonLabel && onAdd && (
          <button className="btn-add" onClick={onAdd}>+ {addButtonLabel}</button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state">Keine Einträge vorhanden.</div>
      ) : (
        <div className="records-table">
          {isTire ? (
            <>
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
                {sorted.map(rec => {
                  const kmDriven = (rec.odometer_km != null && rec.start_odometer_km != null)
                    ? rec.odometer_km - rec.start_odometer_km
                    : null;
                  return (
                    <div key={rec.id} className={`table-row tire-row ${rec.is_active ? 'tire-active' : 'tire-replaced'}`}>
                      <div className="col col-pos">
                        {rec.tire_position ? <TireBadge position={rec.tire_position} /> : '—'}
                      </div>
                      <div className="col col-brand">
                        <span className="tire-brand-name">{rec.tire_brand || '—'}</span>
                      </div>
                      <div className="col col-season">
                        {rec.tire_season && (
                          <span className={`tire-season-label tire-season--${rec.tire_season.toLowerCase()}`}>
                            {rec.tire_season}
                          </span>
                        ) || '—'}
                      </div>
                      <div className="col col-km">
                        <div>{rec.odometer_km != null ? rec.odometer_km.toLocaleString('de-DE') + ' km' : '—'}</div>
                        {kmDriven != null && kmDriven > 0 && (
                          <div className="tire-km-driven">+{kmDriven.toLocaleString('de-DE')} km gefahren</div>
                        )}
                      </div>
                      <div className="col col-cost">
                        {rec.cost_eur != null ? rec.cost_eur.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' €' : '—'}
                      </div>
                      <div className="col col-status">
                        {rec.is_active ? (
                          <span className="status-active">● Aktiv</span>
                        ) : (
                          <span className="status-replaced">● Ersetzt</span>
                        )}
                      </div>
                      <div className="col col-actions">
                        {rec.is_active && onReplaceTire && (
                          <button className="btn-replace" onClick={() => onReplaceTire(rec)}>
                            Wechseln
                          </button>
                        )}
                      </div>
                      {extraCosts?.filter(ec => ec.linked_tire_id === rec.id).map(ec => (
                        <div key={`ec-${ec.id}`} className="tire-purchase-info" data-label="Gekauft">
                          🛒 Gekauft am: {new Date(ec.date).toLocaleDateString('de-DE')} ({ec.cost_eur.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €)
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="table-header service-table-header">
                <div className="col col-date">Datum</div>
                <div className="col col-km">km-Stand</div>
                <div className="col col-cost">Betrag (€)</div>
                <div className="col col-desc">Beschreibung</div>
                <div className="col col-shop">Werkstatt</div>
              </div>
              <div className="table-body">
                {sorted.map(rec => (
                  <div key={rec.id} className="table-row service-row">
                    <div className="col col-date">{rec.date}</div>
                    <div className="col col-km">{rec.odometer_km != null ? rec.odometer_km.toLocaleString('de-DE') : '—'}</div>
                    <div className="col col-cost">{rec.cost_eur != null ? rec.cost_eur.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' €' : '—'}</div>
                    <div className="col col-desc">{rec.title || '—'}</div>
                    <div className="col col-shop">{rec.shop || '—'}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Main VehiclePage ──────────────────────────────────────────
export default function VehiclePage() {
  // State for vehicle info
  const [vehicleInfo, setVehicleInfo] = useState<VehicleInfoResponse | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);

  // State for records (services + tires)
  const [records, setRecords] = useState<VehicleRecordRead[] | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [errorRecords, setErrorRecords] = useState<string | null>(null);

  // State for linked extra costs
  const [extraCosts, setExtraCosts] = useState<ExtraCostRead[]>([]);

  // Modal visibility
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showTireModal, setShowTireModal] = useState(false);
  const [showTireReplaceModal, setShowTireReplaceModal] = useState(false);
  const [tireToReplace, setTireToReplace] = useState<VehicleRecordRead | null>(null);

  async function fetchRecords() {
    setLoadingRecords(true);
    setErrorRecords(null);
    try {
      const [vehicleData, extraData] = await Promise.all([
        api.getVehicleRecords(),
        api.getExtraCosts().catch(() => ({ data: [] as ExtraCostRead[] })),
      ]);
      // Merge services + tires into a single list
      const allRecords: VehicleRecordRead[] = [
        ...(vehicleData.services || []),
        ...(vehicleData.tires || []),
      ];
      setRecords(allRecords);
      setExtraCosts(extraData.data || []);
    } catch (e) {
      setErrorRecords(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setLoadingRecords(false);
    }
  }

  useEffect(() => {
    const fetchVehicleInfo = async () => {
      try {
        const data = await api.getVehicleInfo();
        setVehicleInfo(data);
      } catch (e) {
        setErrorInfo(e instanceof Error ? e.message : 'Unbekannter Fehler');
      } finally {
        setLoadingInfo(false);
      }
    };

    fetchVehicleInfo();
    fetchRecords();
  }, []);

  function handleReplaceTire(tire: VehicleRecordRead) {
    setTireToReplace(tire);
    setShowTireReplaceModal(true);
  }

  return (
    <div className="vehicle-page">
      <h2>Fahrzeug & Service</h2>

      <div className="vehicle-page-grid">
        {/* Section: Vehicle Identity */}
        <VehicleInfoCard info={vehicleInfo} loading={loadingInfo} error={errorInfo} />

        {/* Section: Service & Maintenance */}
        <VehicleRecordsSection
          records={records}
          loading={loadingRecords}
          error={errorRecords}
          title="Service & Wartung"
          typeFilter="service"
          addButtonLabel="Service eintragen"
          onAdd={() => setShowServiceModal(true)}
        />

        {/* Section: Tires */}
        <VehicleRecordsSection
          records={records}
          loading={loadingRecords}
          error={errorRecords}
          title="Reifen"
          typeFilter="tire"
          addButtonLabel="Reifen erfassen"
          onAdd={() => setShowTireModal(true)}
          onReplaceTire={handleReplaceTire}
          extraCosts={extraCosts}
        />
      </div>

      {/* Modals */}
      {showServiceModal && (
        <ServiceFormModal
          onClose={() => setShowServiceModal(false)}
          onSaved={fetchRecords}
        />
      )}

      {showTireModal && (
        <TireFormModal
          onClose={() => setShowTireModal(false)}
          onSaved={fetchRecords}
        />
      )}

      {showTireReplaceModal && tireToReplace && (
        <TireFormModal
          onClose={() => { setShowTireReplaceModal(false); setTireToReplace(null); }}
          onSaved={fetchRecords}
          initialTire={tireToReplace}
          replaceMode={true}
        />
      )}
    </div>
  );
}