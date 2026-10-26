import React, { useState } from 'react';
import { useTheme, useDesignMode } from '../app/ThemeContext';
import { Sun, Moon, Menu, RefreshCw, Calendar, X, CheckCircle } from "lucide-react";
import './TopBar.css';

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const { theme, toggleTheme } = useTheme();
  const { designMode, toggleDesignMode } = useDesignMode();

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <button className="topbar__btn topbar__btn--icon topbar__menu-btn" onClick={onMenuClick} aria-label="Hauptmenü öffnen">
          <Menu size={24} />
        </button>
        <h1 className="topbar__title">CarTankLogger 2.0</h1>
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
        <button
          className="topbar__btn topbar__btn--icon"
          onClick={toggleDesignMode}
          aria-label={designMode === 'legacy' ? 'Modernes Design aktivieren' : 'Legacy Design aktivieren'}
          title={designMode === 'legacy' ? 'Modernes Design' : 'Legacy Design'}
        >
          {designMode === 'legacy' ? <RefreshCw size={20} /> : <CheckCircle size={20} />}
        </button>
      </div>
    </header>
  );
}
