import React from 'react';
import { Link } from 'react-router-dom';
import './PlaceholderPage.css';

export function ExtraCostsPlaceholderPage() {
  return (
    <div className="page-container">
      <div className="placeholder-page">
        <h1>Extra-Kosten</h1>
        <p>Diese Seite wird im nächsten Schritt umgesetzt.</p>
        <Link to="/" className="placeholder-page__back">Zurück zur Übersicht</Link>
      </div>
    </div>
  );
}