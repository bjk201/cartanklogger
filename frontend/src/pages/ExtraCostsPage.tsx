import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/apiClient';
import type { ExtraCostRead, ExtraCostCreate, ExtraCostUpdate, VehicleRecordRead } from '../types/api';
import './ExtraCostsPage.css';

// ─── Category labels (German) ──────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
  VERSICHERUNG: 'Versicherung',
  ZUBEHOER: 'Zubehör',
  STEUER: 'Steuer',
  SONSTIGES: 'Sonstiges',
  REIFENKAUF: 'Reifenkauf',
};

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'VERSICHERUNG', label: 'Versicherung' },
  { value: 'ZUBEHOER', label: 'Zubehör' },
  { value: 'STEUER', label: 'Steuer' },
  { value: 'SONSTIGES', label: 'Sonstiges' },
  { value: 'REIFENKAUF', label: 'Reifenkauf' },
];

// ─── Helper ────────────────────────────────────────────────
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return dateStr.slice(0, 10);
}

function formatEuro(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ─── Modal ─────────────────────────────────────────────────
interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ title, onClose, children }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-container" onClick={e => e.stopPropagation()}>
      <div className="modal-header">
        <h3>{title}</h3>
        <button className="modal-close-btn" onClick={onClose} aria-label="Schließen">&times;</button>
      </div>
      <div className="modal-body">{children}</div>
    </div>
  </div>
);

const FormField: React.FC<{ label: string; required?: boolean; error?: string; children: React.ReactNode }> = ({
  label, required, error, children,
}) => (
  <div className="form-field">
    <label className="form-label">
      {label}{required && <span className="form-required">*</span>}
    </label>
    {children}
    {error && <span className="form-error">{error}</span>}
  </div>
);

// ─── Delete Confirm Modal ──────────────────────────────────
interface DeleteConfirmProps {
  record: ExtraCostRead;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}

const DeleteConfirmModal: React.FC<DeleteConfirmProps> = ({ record, onConfirm, onCancel, deleting }) => (
  <Modal title="Eintrag löschen" onClose={onCancel}>
    <div className="delete-confirm">
      <p>Soll der Eintrag <strong>"{record.description}"</strong> ({formatEuro(record.amount)}) wirklich gelöscht werden?</p>
      <div className="form-actions">
        <button className="btn-secondary" onClick={onCancel} disabled={deleting}>Abbrechen</button>
        <button className="btn-danger" onClick={onConfirm} disabled={deleting}>
          {deleting ? 'Wird gelöscht…' : 'Endgültig löschen'}
        </button>
      </div>
    </div>
  </Modal>
);

// ─── Edit / Create Modal ───────────────────────────────────
interface ExtraCostFormModalProps {
  onClose: () => void;
  onSaved: () => void;
  /** If set, we're editing an existing record */
  editRecord?: ExtraCostRead | null;
}

const ExtraCostFormModal: React.FC<ExtraCostFormModalProps> = ({ onClose, onSaved, editRecord }) => {
  const isEdit = !!editRecord;

  const [date, setDate] = useState(editRecord ? formatDate(editRecord.date) : todayStr());
  const [category, setCategory] = useState<string>(editRecord?.category || 'VERSICHERUNG');
  const [title, setTitle] = useState(editRecord?.title || '');
  const [cost, setCost] = useState(editRecord?.cost_eur?.toString() || '');
  const [note, setNote] = useState(editRecord?.description || '');
  const [linkedTireId, setLinkedTireId] = useState<number | undefined>(editRecord?.linked_tire_id || undefined);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Active tires for REIFENKAUF dropdown
  const [activeTires, setActiveTires] = useState<VehicleRecordRead[]>([]);
  const [loadingTires, setLoadingTires] = useState(false);

  // Load active tires when category is REIFENKAUF
  useEffect(() => {
    if (category === 'REIFENKAUF') {
      setLoadingTires(true);
      api.getVehicleRecords()
        .then(res => {
          const tires = (res.tires || []).filter(t => t.is_active);
          setActiveTires(tires);
        })
        .catch(() => setActiveTires([]))
        .finally(() => setLoadingTires(false));
    } else {
      setActiveTires([]);
      // Clear linked_tire when switching away from REIFENKAUF
      if (!isEdit) setLinkedTireId(undefined);
    }
  }, [category, isEdit]);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!date.trim()) errs.date = 'Datum ist erforderlich';
    if (!title.trim()) errs.title = 'Titel ist erforderlich';
    if (!cost || Number(cost) <= 0) errs.cost = 'Betrag muss größer als 0 sein';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    setError(null);

    const payload: ExtraCostCreate = {
      date: new Date(date).toISOString(),
      description: title.trim(),
      category: category as string,
      amount: Number(cost),
      currency: 'EUR',
      linked_tire_id: (category ?? '') === 'REIFENKAUF' ? linkedTireId : undefined,
    };

    try {
      let res;
      if (isEdit && editRecord) {
        const updatePayload: ExtraCostUpdate = { ...payload };
        res = await api.updateExtraCost(editRecord.id, updatePayload);
      } else {
        res = await api.createExtraCost(payload);
      }
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
    <Modal title={isEdit ? 'Extra-Kosten bearbeiten' : 'Extra-Kosten erfassen'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="record-form">
        <FormField label="Datum" required error={fieldErrors.date}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </FormField>
        <FormField label="Kategorie" required>
          <select value={category} onChange={e => setCategory(e.target.value as string)}>
            {CATEGORY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Titel" required error={fieldErrors.title}>
          <input type="text" placeholder="z.B. KFZ-Versicherung 2026" value={title} onChange={e => setTitle(e.target.value)} />
        </FormField>
        <FormField label="Betrag (€)" required error={fieldErrors.cost}>
          <input type="number" min="0.01" step="0.01" placeholder="0.00" value={cost} onChange={e => setCost(e.target.value)} />
        </FormField>
        <FormField label="Notiz">
          <textarea placeholder="Optionale Notiz…" value={note} onChange={e => setNote(e.target.value)} rows={3} />
        </FormField>

        {category === 'REIFENKAUF' && (
          <FormField label="Reifen (optional)">
            {loadingTires ? (
              <span className="loading-tires">Lade aktive Reifen…</span>
            ) : activeTires.length > 0 ? (
              <select
                value={linkedTireId ?? ''}
                onChange={e => setLinkedTireId(e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">— Neuen Reifen anlegen —</option>
                {activeTires.map(tire => (
                  <option key={tire.id} value={tire.id}>
                    {tire.tire_brand} ({tire.tire_position}, {tire.tire_season})
                  </option>
                ))}
              </select>
            ) : (
              <span className="no-tires-hint">Keine aktiven Reifen vorhanden – es wird automatisch ein neuer Reifen-Eintrag angelegt.</span>
            )}
            <span className="field-hint">Wenn kein Reifen ausgewählt wird, wird automatisch ein neuer Reifen-Eintrag im Fahrzeug angelegt.</span>
          </FormField>
        )}

        {error && <div className="form-submit-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Abbrechen</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Wird gespeichert…' : (isEdit ? 'Änderungen speichern' : 'Extra-Kosten speichern')}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ─── Main Page ─────────────────────────────────────────────
export default function ExtraCostsPage() {
  const [records, setRecords] = useState<ExtraCostRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [showFormModal, setShowFormModal] = useState(false);
  const [editRecord, setEditRecord] = useState<ExtraCostRead | null>(null);
  const [deleteRecord, setDeleteRecord] = useState<ExtraCostRead | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getExtraCosts();
      setRecords(data.costs || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  async function handleDelete() {
    if (!deleteRecord) return;
    setDeleting(true);
    try {
      const res = await api.deleteExtraCost(deleteRecord.id);
      if (res.ok) {
        setDeleteRecord(null);
        fetchRecords();
      }
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  }

  function handleEdit(rec: ExtraCostRead) {
    setEditRecord(rec);
    setShowFormModal(true);
  }

  function getCategoryBadge(cat: string): string {
    return `badge badge--${cat.toLowerCase()}`;
  }

  // Total sum
  const totalCost = records.reduce((sum, r) => sum + (r.amount || 0), 0);

  return (
    <div className="extra-costs-page">
      <div className="page-header">
        <h2>Extra-Kosten</h2>
        <button className="btn-add" onClick={() => { setEditRecord(null); setShowFormModal(true); }}>
          + Neu
        </button>
      </div>

      {/* Summary row */}
      {!loading && records.length > 0 && (
        <div className="cost-summary">
          <span className="cost-summary-label">Gesamt:</span>
          <span className="cost-summary-value">{formatEuro(totalCost)}</span>
        </div>
      )}

      {loading ? (
        <div className="loading-state">Lädt Extra-Kosten…</div>
      ) : error ? (
        <div className="error-state">Fehler: {error}</div>
      ) : records.length === 0 ? (
        <div className="empty-state">
          <p>Keine Extra-Kosten erfasst.</p>
          <p className="empty-hint">Klicke auf "+ Neu", um Versicherung, Steuer, Zubehör oder Reifenkäufe zu erfassen.</p>
        </div>
      ) : (
        <div className="extra-costs-table">
          {/* Desktop header */}
          <div className="table-header ec-table-header">
            <div className="col col-date" data-label="Datum">Datum</div>
            <div className="col col-category" data-label="Kategorie">Kategorie</div>
            <div className="col col-title" data-label="Titel">Titel</div>
            <div className="col col-cost" data-label="Betrag">Betrag</div>
            <div className="col col-note" data-label="Notiz">Notiz</div>
            <div className="col col-actions" data-label="Aktionen">Aktionen</div>
          </div>

          <div className="table-body">
            {records.map(rec => (
              <div key={rec.id} className={`table-row ec-row ${(rec.category ?? '') === 'REIFENKAUF' ? 'ec-row--tire' : ''}`}>
                <div className="col col-date" data-label="Datum">{formatDate(rec.date ?? undefined)}</div>
                <div className="col col-category" data-label="Kategorie">
                  <span className={getCategoryBadge(rec.category ?? '')}>
                    {CATEGORY_LABELS[rec.category ?? 'SONSTIGES']}
                  </span>
                </div>
                <div className="col col-title" data-label="Titel">{rec.description}</div>
                <div className="col col-cost" data-label="Betrag">{formatEuro(rec.amount ?? undefined)}</div>
                <div className="col col-note" data-label="Notiz">{rec.description || '—'}</div>
                <div className="col col-actions" data-label="Aktionen">
                  <button className="btn-action" onClick={() => handleEdit(rec)} title="Bearbeiten">✏️</button>
                  <button className="btn-action btn-action--delete" onClick={() => setDeleteRecord(rec)} title="Löschen">🗑️</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Form Modal */}
      {showFormModal && (
        <ExtraCostFormModal
          onClose={() => { setShowFormModal(false); setEditRecord(null); }}
          onSaved={fetchRecords}
          editRecord={editRecord}
        />
      )}

      {/* Delete Modal */}
      {deleteRecord && (
        <DeleteConfirmModal
          record={deleteRecord}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRecord(null)}
          deleting={deleting}
        />
      )}
    </div>
  );
}