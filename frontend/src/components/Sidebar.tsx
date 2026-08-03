import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, NavLink } from 'react-router-dom';
import { Home, BarChart2, Calendar, FileText, Settings, ExternalLink, GitMerge, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTheme } from '../app/ThemeContext';
import './Sidebar.css';

interface NavItem {
  path: string;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Overview', icon: Home },
  { path: '/sessions', label: 'Sessions', icon: FileText },
  { path: '/statistics', label: 'Statistik', icon: BarChart2 },
  { path: '/matching', label: 'Matching', icon: GitMerge },
  { path: '/prices', label: 'Preise', icon: Calendar },
  { path: '/extra-costs', label: 'Extra-Kosten', icon: FileText },
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

  useEffect(() => {
    onMobileToggle(false);
  }, [location.pathname, onMobileToggle]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  if (isMobileOpen) {
    return (
      <>
        <div className="sidebar-overlay" onClick={() => onMobileToggle(false)} aria-hidden="true" />
        <aside className="sidebar sidebar--mobile" role="navigation" aria-label="Hauptnavigation">
          <div className="sidebar__header">
            <a href="/" className="sidebar__brand" onClick={(e) => { e.preventDefault(); navigate('/'); onMobileToggle(false); }}>
              <span className="sidebar__brand-icon" aria-hidden="true">CTL</span>
              <span className="sidebar__brand-text">CarTankLogger 2.0</span>
            </a>
          </div>
          <nav className="sidebar__nav">
            <ul className="sidebar__list" role="list">
              {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
                <li key={path}>
                  <NavLink
                    to={path}
                    className={({ isActive }) => `sidebar__item ${isActive ? 'sidebar__item--active' : ''}`}
                    onClick={() => onMobileToggle(false)}
                    aria-current={isActive(path) ? 'page' : undefined}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <span className="sidebar__label">{label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      </>
    );
  }

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`} role="navigation" aria-label="Hauptnavigation">
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
            v2.0.0
          </div>
        )}
      </div>
    </aside>
  );
}