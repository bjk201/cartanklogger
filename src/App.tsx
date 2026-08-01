import React, { createContext, useContext, useState, useEffect from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Sun, Moon, Menu, X, Home, BarChart2, Calendar, FileText, Settings, Copy, ExternalLink } from 'lucide-react';
import { ThemeProvider } from './contexts/ThemeContext';
import Overview from './pages/Overview';
import Statistics from './pages/Statistics';
import Monatsvergleich from './pages/Monatsvergleich';
import ExtraCosts from './pages/ExtraCosts';
import ImportData from './pages/ImportData';
import Admin from './pages/Admin';
import APIClient from '../services/api';

const Navigation: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setTheme('dark');
      document.documentElement.classList.add('dark');
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const navItems = [
    { path: '/', label: 'Übersicht', icon: Home },
    { path: '/statistik', label: 'Statistik', icon: BarChart2 },
    { path: '/monatsvergleich', label: 'Monatsvergleich', icon: Calendar },
    { path: '/extra', label: 'Extra', icon: FileText },
    { path: '/importdaten', label: 'Import', icon: ExternalLink },
    { path: '/admin', label: 'Admin', icon: Settings },
  ];

  if (!mounted) return null;

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center justify-between h-16 px-4 md:px-6">
        {/* Logo/Brand */}
        <a href="/" className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-gray-100">
          <CarIcon />
          <span className="text-primary">Logger</span>
        </a>

        {/* Mobile Menu Toggle */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex items-center gap-2">
          {navItems.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                  isActive
                    ? 'bg-primary text-white'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Right Side Controls */}
        <div className="flex items-center gap-2">
          {/* Date Range Selector */}
          <DateRangeSelector />
          
          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
            aria-label="Toggle theme"
          >
            {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
            <span className="ml-1 text-sm hidden sm:inline">
              {theme === 'light' ? 'Dark' : 'Light'}
            </span>
          </button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <nav className="md:hidden bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 p-4">
          {navItems.map(({ path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 text-base font-medium rounded-lg transition-colors ${
                  isActive
                    ? 'bg-primary text-white'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`
              }
            >
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </nav>
      )}
    </header>
  );
};

const CarIcon: React.FC = () => (
  <div className="flex items-center justify-center w-8 h-8 bg-primary rounded-lg text-white font-bold">
    C
  </div>
);

const DateRangeSelector: React.FC = () => {
  const [days, setDays] = useState(30);
  const [showCustomRange, setShowCustomRange] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const applyRange = () => {
    if (customFrom && customTo) {
      // Apply custom range logic
      console.log('Custom range:', customFrom, 'to', customTo);
    }
  };

  return (
    <div className="hidden sm:flex items-center gap-2 text-sm">
      <span className="text-gray-600 dark:text-gray-400">Letzte</span>
      <div className="flex gap-1">
        {[7, 30, 90, 365].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              days === d
                ? 'bg-primary text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {d === 90 ? '90 Tage' : `${d} Tage`}
          </button>
        ))}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Navigation />
        <main className="pt-16 md:pt-16 min-h-screen bg-gray-50 dark:bg-gray-900">
          <Routes>
            <Route path="/" element={<Navigate to="/" replace />} />
            <Route path="/" element={<Overview />} />
            <Route path="/statistik" element={<Statistics />} />
            <Route path="/monatsvergleich" element={<Monatsvergleich />} />
            <Route path="/extra" element={<ExtraCosts />} />
            <Route path="/importdaten" element={<ImportData />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        </main>
      </BrowserRouter>
    </ThemeProvider>
  );
};

export default App;