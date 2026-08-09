import React from 'react';
import type { Session } from '../types/api';
import './SessionsTable.css';

interface SessionsTableProps {
  sessions: Session[];
  loading?: boolean;
  emptyMessage?: string;
  compact?: boolean;
}

export function SessionsTable({ sessions, loading = false, emptyMessage = 'Keine Sessions gefunden', compact = false }: SessionsTableProps) {
  if (loading) {
    return (
      <div className="sessions-table__skeleton" role="status" aria-label="Lade Sessions">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="sessions-table__row skeleton">
            <div className="skeleton__cell" />
            <div className="skeleton__cell" />
            <div className="skeleton__cell" />
            <div className="skeleton__cell" />
            <div className="skeleton__cell" />
            <div className="skeleton__cell" />
          </div>
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="sessions-table__empty">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const tableClass = compact ? 'sessions-table sessions-table--compact' : 'sessions-table';

  return (
    <div className="sessions-table__wrapper">
      <table className={tableClass} role="table">
        <thead>
          <tr>
            <th scope="col">Datum</th>
            <th scope="col">Quelle</th>
            {compact ? (
              <>
                <th scope="col" className="text-end">kWh</th>
                <th scope="col" className="text-end">PV kWh</th>
                <th scope="col" className="text-end">€/kWh</th>
                <th scope="col" className="text-end">Kosten</th>
              </>
            ) : (
              <>
                <th scope="col">Ort</th>
                <th scope="col" className="text-end">kWh</th>
                <th scope="col" className="text-end">PV %</th>
                <th scope="col" className="text-end">PV kWh</th>
                <th scope="col" className="text-end">Kosten</th>
                <th scope="col" className="text-end">€/kWh</th>
                <th scope="col" className="text-end">km-Stand</th>
                <th scope="col">Notiz</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="sessions-table__row">
              <td className="sessions-table__date">
                <time dateTime={session.date || ''}>
                  {formatDate(session.date || '', compact)}
                </time>
              </td>
              <td>
                <span className={`source-badge source-badge--${session.source_type}`}>
                  {formatSourceType(session.source_type)}
                </span>
              </td>
              {compact ? (
                <>
                  <td className="text-end sessions-table__energy" data-label="kWh">
                    {session.energy_kwh !== null && session.energy_kwh !== undefined ? session.energy_kwh.toFixed(1) : '—'}
                  </td>
                  <td className="text-end sessions-table__pv-kwh" data-label="PV kWh">
                    {session.pv_kwh !== null && session.pv_kwh !== undefined ? session.pv_kwh.toFixed(2) : '—'}
                  </td>
                  <td className="text-end sessions-table__cost-per-kwh" data-label="€/kWh">
                    {session.cost_per_kwh !== null && session.cost_per_kwh !== undefined ? `${session.cost_per_kwh.toFixed(2)} €/kWh` : '—'}
                  </td>
                  <td className="text-end sessions-table__cost" data-label="Kosten">
                    {session.cost_eur !== null && session.cost_eur !== undefined ? `${session.cost_eur.toFixed(2)} €` : '—'}
                  </td>
                </>
              ) : (
                <>
                  <td className="sessions-table__location">
                    {session.location || '—'}
                  </td>
                  <td className="text-end sessions-table__energy">
                    {session.energy_kwh !== null && session.energy_kwh !== undefined ? session.energy_kwh.toFixed(1) : '—'}
                  </td>
                  <td className="text-end sessions-table__pv-pct">
                    {session.solar_percentage !== null && session.solar_percentage !== undefined ? `${session.solar_percentage.toFixed(1)} %` : '—'}
                  </td>
                  <td className="text-end sessions-table__pv-kwh">
                    {session.pv_kwh !== null && session.pv_kwh !== undefined ? session.pv_kwh.toFixed(2) : '—'}
                  </td>
                  <td className="text-end sessions-table__cost">
                    {session.cost_eur !== null && session.cost_eur !== undefined ? `${session.cost_eur.toFixed(2)} €` : '—'}
                  </td>
                  <td className="text-end sessions-table__cost-per-kwh">
                    {session.cost_per_kwh !== null && session.cost_per_kwh !== undefined ? `${session.cost_per_kwh.toFixed(2)} €/kWh` : '—'}
                  </td>
                  <td className="text-end sessions-table__odometer">
                    {session.odometer_km !== null && session.odometer_km !== undefined ? session.odometer_km.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '—'}
                  </td>
                  <td className="sessions-table__note">
                    {session.note ? (
                      <span className="note-truncate" title={session.note}>
                        {session.note}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(dateString: string, compact?: boolean): string {
  const date = new Date(dateString);
  const opts: Intl.DateTimeFormatOptions = compact
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  return date.toLocaleDateString('de-DE', opts);
}

function formatSourceType(type: string): string {
  switch (type) {
    case 'home':
      return 'Zuhause';
    case 'external':
      return 'Extern';
    case 'import':
      return 'Import';
    default:
      return type;
  }
}