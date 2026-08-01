import React from 'react';
import type { Session } from '../types/api';
import './SessionsTable.css';

interface SessionsTableProps {
  sessions: Session[];
  loading?: boolean;
  emptyMessage?: string;
}

export function SessionsTable({ sessions, loading = false, emptyMessage = 'Keine Sessions gefunden' }: SessionsTableProps) {
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

  return (
    <div className="sessions-table__wrapper">
      <table className="sessions-table" role="table">
        <thead>
          <tr>
            <th scope="col">Datum</th>
            <th scope="col">Quelle</th>
            <th scope="col">Ort</th>
            <th scope="col" className="text-end">kWh</th>
            <th scope="col" className="text-end">Kosten</th>
            <th scope="col" className="text-end">km-Stand</th>
            <th scope="col">Notiz</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className="sessions-table__row">
              <td className="sessions-table__date">
                <time dateTime={session.date}>
                  {formatDate(session.date)}
                </time>
              </td>
              <td>
                <span className={`source-badge source-badge--${session.source_type}`}>
                  {formatSourceType(session.source_type)}
                </span>
              </td>
              <td className="sessions-table__location">
                {session.location || '—'}
              </td>
              <td className="text-end sessions-table__energy">
                {session.energy_kwh !== null ? session.energy_kwh.toFixed(1) : '—'}
              </td>
              <td className="text-end sessions-table__cost">
                {session.cost_eur !== null ? `${session.cost_eur.toFixed(2)} €` : '—'}
              </td>
              <td className="text-end sessions-table__odometer">
                {session.odometer_km !== null ? session.odometer_km.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '—'}
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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