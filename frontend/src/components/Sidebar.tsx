import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, NavLink } from 'react-router-dom';
import { Home, BarChart2, FileText, Settings, ExternalLink, Car, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTheme } from '../app/ThemeContext';
import { api, type DataSourceStatusResponse } from '../lib/apiClient';
import './Sidebar.css';

interface NavItem {
  path: string;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Overview', icon: Home },
  { path: '/statistics', label: 'Statistik', icon: BarChart2 },
  { path: '/vehicle', label: 'Fahrzeug', icon: Car },
  { path: '/sessions', label: 'Sessions', icon: FileText },
  { path: '/import-review', label: 'Import/Review', icon: ExternalLink },
  { path: '/settings', label: 'Einstellungen', icon: Settings },
];

interface SidebarProps {
  isMobileOpen: boolean;
  onMobileToggle: (open: boolean) => void;
}

export function Sidebar({ isMobileOpen, onMobileToggle }: SidebarProps) {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [dataSourceStatus, setDataSourceStatus] = useState<DataSourceStatusResponse | null>(null);

  useEffect(() => {
    onMobileToggle(false);
  }, [location.pathname, onMobileToggle]);

  useEffect(() => {
    api.getDataSourceStatus()
      .then(setDataSourceStatus)
      .catch(() => {});
  }, []);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const formatStatusText = (status: { configured?: boolean; reachable?: boolean; level?: string; source?: string } | undefined): { text: string; className: string } => {
    if (!status) return { text: 'Unbekannt', className: 'sidebar__status--unknown' };
    if (!status.configured) return { text: 'Nicht konfiguriert', className: 'sidebar__status--warn' };
    if (status.reachable) {
      if (status.level === 'healthy') return { text: 'Erreichbar', className: 'sidebar__status--ok' };
      if (status.level === 'degraded') return { text: 'Erreichbar, Datenabruf fehlgeschlagen', className: 'sidebar__status--warn' };
      if (status.level === 'down') return { text: 'Nicht erreichbar', className: 'sidebar__status--error' };
      return { text: 'Erreichbar', className: 'sidebar__status--ok' };
    }
    return { text: 'Nicht erreichbar', className: 'sidebar__status--error' };
  };

  const sidebarContent = (
    <>
      <div className="sidebar__header">
        <a href="/" className="sidebar__brand" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          <span className="sidebar__brand-icon" aria-hidden="true">CTL</span>
          {!collapsed && <span className="sidebar__brand-text">CarTankLogger 2.0</span>}
        </a>
        <button
          className="sidebar__toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Sidebar erweitern' : 'Sidebar einklappen'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>
      <nav className="sidebar__nav">
        <ul className="sidebar__list" role="list">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <li key={path}>
              <NavLink
                to={path}
                className={({ isActive }) => `sidebar__item ${isActive ? 'sidebar__item--active' : ''}`}
                onClick={() => navigate(path)}
                aria-current={isActive(path) ? 'page' : undefined}
              >
                <Icon size={20} aria-hidden="true" />
                {!collapsed && <span className="sidebar__label">{label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar__footer">
        {!collapsed && (
          <div className="sidebar__version">
            <div className="sidebar__version-info">
              <span className="sidebar__version-label">Version</span>
              <span className="sidebar__version-value">v2.0.0</span>
            </div>
            <div className="sidebar__version-info">
              <span className="sidebar__version-label">Modus</span>
              <span className={`sidebar__status sidebar__status--${dataSourceStatus?.data_source === 'live' ? 'ok' : 'warn'}`}>
                {dataSourceStatus?.data_source === 'live' ? 'Live' : 'Demo'}
              </span>
            </div>
            <div className="sidebar__source-status">
              <span className="sidebar__version-label">EVCC</span>
              <span className={`sidebar__status ${formatStatusText(dataSourceStatus?.evcc).className}`}>
                {formatStatusText(dataSourceStatus?.evcc).text}
              </span>
            </div>
            <div className="sidebar__source-status">
              <span className="sidebar__version-label">TeslaMate</span>
              <span className={`sidebar__status ${formatStatusText(dataSourceStatus?.teslamateapi).className}`}>
                {formatStatusText(dataSourceStatus?.teslamateapi).text}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );

  if (isMobileOpen) {
    return (
      <>
        <div className="sidebar-overlay" onClick={() => onMobileToggle(false)} aria-hidden="true" />
        <aside className="sidebar sidebar--mobile" role="navigation" aria-label="Hauptnavigation">
          {sidebarContent}
        </aside>
      </>
    );
  }

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`} role="navigation" aria-label="Hauptnavigation">
      {sidebarContent}
    </aside>
  );
}