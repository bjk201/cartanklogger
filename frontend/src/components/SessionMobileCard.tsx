import React from 'react';
import type { Session } from '../types/api';
import './SessionMobileCard.css';

interface SessionMobileCardProps {
  session: Session;
}

export function SessionMobileCard({ session }: SessionMobileCardProps) {
  return (
    <article className="session-card">
      <header className="session-card__header">
        <time className="session-card__date" dateTime={session.date}>
          {formatDate(session.date)}
        </time>
        <span className={`source-badge source-badge--${session.source_type}`}>
          {formatSourceType(session.source_type)}
        </span>
      </header>
      <div className="session-card__body">
        <div className="session-card__row">
          <span className="session-card__label">Ort</span>
          <span className="session-card__value">{session.location || '—'}</span>
        </div>
        <div className="session-card__row">
          <span className="session-card__label">Energie</span>
          <span className="session-card__value session-card__value--energy">
            {session.energy_kwh !== null ? `${session.energy_kwh.toFixed(1)} kWh` : '—'}
          </span>
        </div>
        <div className="session-card__row">
          <span className="session-card__label">Kosten</span>
          <span className="session-card__value session-card__value--cost">
            {session.cost_eur !== null ? `${session.cost_eur.toFixed(2)} €` : '—'}
          </span>
        </div>
        <div className="session-card__row">
          <span className="session-card__label">km-Stand</span>
          <span className="session-card__value">
            {session.odometer_km !== null ? session.odometer_km.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '—'}
          </span>
        </div>
        {session.note && (
          <div className="session-card__note">
            <span className="session-card__label">Notiz</span>
            <span className="session-card__value">{session.note}</span>
          </div>
        )}
      </div>
    </article>
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
    case 'home': return 'Zuhause';
    case 'external': return 'Extern';
    case 'import': return 'Import';
    default: return type;
  }
}