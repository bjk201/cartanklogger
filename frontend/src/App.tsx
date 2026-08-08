import React, { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './app/ThemeContext';
import { TimeRangeProvider } from './app/TimeRangeContext';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewPage } from './features/overview/OverviewPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatisticsPage } from './pages/StatisticsPage';
import { PricesPlaceholderPage } from './pages/PricesPlaceholderPage';
import ExtraCostsPage from './pages/ExtraCostsPage';
import { ImportReviewPlaceholderPage } from './pages/ImportReviewPlaceholderPage';
import { DataSourcesPage } from './pages/DataSourcesPage';
import MatchingPage from './pages/MatchingPage';
import VehiclePage from './pages/VehiclePage';
import './styles/global.css';
import './styles/layout.css';

function App() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  return (
    <ThemeProvider>
      <TimeRangeProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <div className="app-shell">
            <Sidebar isMobileOpen={mobileSidebarOpen} onMobileToggle={setMobileSidebarOpen} />
            <div className="app-main">
              <TopBar onMenuClick={() => setMobileSidebarOpen(true)} />
              <main className="app-content" role="main">
                <Routes>
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/sessions" element={<SessionsPage />} />
                  <Route path="/statistics" element={<StatisticsPage />} />
                  <Route path="/prices" element={<PricesPlaceholderPage />} />
                  <Route path="/extra-costs" element={<ExtraCostsPage />} />
                  <Route path="/import-review" element={<ImportReviewPlaceholderPage />} />
                  <Route path="/settings" element={<DataSourcesPage />} />
                  <Route path="/matching" element={<MatchingPage />} />
                  <Route path="/vehicle" element={<VehiclePage />} />
                </Routes>
              </main>
            </div>
          </div>
        </BrowserRouter>
      </TimeRangeProvider>
    </ThemeProvider>
  );
}

export default App;