import React from 'react';
import { RefreshCw, AlertCircle, Info, PackageSearch } from 'lucide-react';
import './StateViews.css';

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message = 'Daten werden geladen…' }: LoadingStateProps) {
  return (
    <div className="state-view state-view--loading" role="status" aria-live="polite">
      <div className="state-view__spinner" aria-hidden="true" />
      <p className="state-view__message">{message}</p>
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = 'Erneut versuchen' }: ErrorStateProps) {
  return (
    <div className="state-view state-view--error" role="alert">
      <div className="state-view__icon" aria-hidden="true">
        <AlertCircle size={48} />
      </div>
      <h2 className="state-view__title">Fehler beim Laden</h2>
      <p className="state-view__message">{message}</p>
      {onRetry && (
        <button className="state-view__retry" onClick={onRetry} type="button">
          <RefreshCw size={16} aria-hidden="true" />
          {retryLabel}
        </button>
      )}
    </div>
  );
}

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  title: string;
  message: string;
  icon?: React.ElementType;
  action?: EmptyStateAction;
}

export function EmptyState({ title, message, icon: Icon = PackageSearch, action }: EmptyStateProps) {
  return (
    <div className="state-view state-view--empty">
      <div className="state-view__icon" aria-hidden="true">
        <Icon size={48} />
      </div>
      <h2 className="state-view__title">{title}</h2>
      <p className="state-view__message">{message}</p>
      {action && (
        <button className="state-view__action" onClick={action.onClick} type="button">
          {action.label}
        </button>
      )}
    </div>
  );
}

interface PartialErrorProps {
  message: string;
  onDismiss?: () => void;
}

export function PartialError({ message, onDismiss }: PartialErrorProps) {
  return (
    <div className="partial-error" role="alert">
      <Info size={18} aria-hidden="true" />
      <span>{message}</span>
      {onDismiss && (
        <button className="partial-error__dismiss" onClick={onDismiss} aria-label="Schließen">
          ×
        </button>
      )}
    </div>
  );
}