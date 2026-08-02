import React from 'react';
import { useTheme } from '../app/ThemeContext';
import { Sun, Moon, Menu } from 'lucide-react';
import './TopBar.css';

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <button
          className="topbar__btn topbar__btn--icon topbar__menu-btn"
          onClick={onMenuClick}
          aria-label="Hauptmenü öffnen"
        >
          <Menu size={24} />
        </button>
        <h1 className="topbar__title">CarTankLogger 2.0</h1>
        <div className="topbar__status" role="status" aria-live="polite">
          <span className="status-indicator status-indicator--connected" aria-hidden="true" />
          <span className="status-text">Backend verbunden</span>
          <span className="status-detail" aria-label="Letzte Synchronisation">jetzt</span>
        </div>
      </div>
      <div className="topbar__right">
        <button
          className="topbar__btn topbar__btn--icon"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Dark Mode aktivieren' : 'Light Mode aktivieren'}
          title={theme === 'light' ? 'Dark Mode' : 'Light Mode'}
        >
          {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
        </button>
      </div>
    </header>
  );
}