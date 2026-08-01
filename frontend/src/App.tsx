import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './app/ThemeContext';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { OverviewPage } from './features/overview/OverviewPage';
import './styles/global.css';

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Sidebar />
        <TopBar />
        <main className="overview-page" role="main">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/sessions" element={<Navigate to="/" replace />} />
            <Route path="/statistics" element={<Navigate to="/" replace />} />
            <Route path="/prices" element={<Navigate to="/" replace />} />
            <Route path="/extra-costs" element={<Navigate to="/" replace />} />
            <Route path="/import" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;