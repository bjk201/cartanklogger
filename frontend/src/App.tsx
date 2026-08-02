import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './app/ThemeContext';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewPage } from './features/overview/OverviewPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatisticsPage } from './pages/StatisticsPage';
import { PricesPlaceholderPage } from './pages/PricesPlaceholderPage';
import { ExtraCostsPlaceholderPage } from './pages/ExtraCostsPlaceholderPage';
import { ImportReviewPlaceholderPage } from './pages/ImportReviewPlaceholderPage';
import { SettingsPlaceholderPage } from './pages/SettingsPlaceholderPage';
import './styles/global.css';
import './styles/layout.css';

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <div className="app-shell">
          <Sidebar />
          <div className="app-main">
            <TopBar />
            <main className="app-content" role="main">
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/statistics" element={<StatisticsPage />} />
                <Route path="/prices" element={<PricesPlaceholderPage />} />
                <Route path="/extra-costs" element={<ExtraCostsPlaceholderPage />} />
                <Route path="/import-review" element={<ImportReviewPlaceholderPage />} />
                <Route path="/settings" element={<SettingsPlaceholderPage />} />
              </Routes>
            </main>
          </div>
        </div>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;