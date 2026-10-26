import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type Theme = 'light' | 'dark';
type DesignMode = 'legacy' | 'new';

interface ThemeContextType {
  theme: Theme;
  designMode: DesignMode;
  toggleTheme: () => void;
  toggleDesignMode: () => void;
  setTheme: (theme: Theme) => void;
  setDesignMode: (mode: DesignMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  const [designMode, setDesignModeState] = useState<DesignMode>('legacy'); // Default: legacy
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedTheme = localStorage.getItem('theme');
    const savedDesignMode = localStorage.getItem('designMode');
    if (savedTheme && savedTheme === 'light' || savedTheme === 'dark') {
      setThemeState(savedTheme as Theme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
    if (savedDesignMode && (savedDesignMode === 'legacy' || savedDesignMode === 'new')) {
      setDesignModeState(savedDesignMode as DesignMode);
      document.documentElement.setAttribute('data-design-mode', savedDesignMode);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setThemeState('dark');
      setDesignModeState('legacy'); // Default für Dark Mode ist Legacy
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const setDesignMode = (newMode: DesignMode) => {
    setDesignModeState(newMode);
    localStorage.setItem('designMode', newMode);
    document.documentElement.setAttribute('data-design-mode', newMode);
  };

  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  };

  const toggleDesignMode = () => {
    setDesignMode(designMode === 'legacy' ? 'new' : 'legacy');
  };

  const value: any = {
    theme: mounted ? theme : 'light',
    designMode: mounted ? designMode : 'legacy',
    toggleTheme: mounted ? toggleTheme : () => {},
    setTheme: mounted ? setTheme : () => {},
    toggleDesignMode: mounted ? toggleDesignMode : () => {},
    setDesignMode: mounted ? setDesignMode : () => {},
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export function useDesignMode() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useDesignMode must be used within a ThemeProvider');
  }
  return context;
}
