import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Calendar, X } from 'lucide-react';
import { useTimeRange, type RangeValue } from '../app/TimeRangeContext';
import { SessionsTable } from '../components/SessionsTable';
import { SessionMobileCard } from '../components/SessionMobileCard';
import { LoadingState, ErrorState, EmptyState } from '../components/StateViews';
import { api, type Session, type PaginatedSessionsResponse, type PaginationInfo } from '../lib/apiClient';
import './SessionsPage.css';

const PAGE_SIZE = 25;
const SOURCE_TYPE_OPTIONS = [
  { value: 'all', label: 'Alle' },
  { value: 'home', label: 'Zuhause (EVCC)' },
  { value: 'external', label: 'Extern (TeslaMate)' },
  { value: 'import', label: 'Import' },
] as const;

export function SessionsPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    page_size: PAGE_SIZE,
    total: 0,
    total_pages: 0,
    has_next: false,
    has_prev: false,
  });
  
  // Filter & Sort State
  const [search, setSearch] = useState('');
  const [sourceType, setSourceType] = useState<'all' | 'home' | 'external' | 'import'>('all');
  const [sortDesc, setSortDesc] = useState(true);
  
  // Use global time range context
  const { selectedRange, customFrom, customTo, showCustomPicker, getRangeLabel, getDaysFromRange, getFromDate, getToDate, setSelectedRange } = useTimeRange();

  const handleRangeChange = (value: RangeValue) => {
    setSelectedRange(value);
  };

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    // Determine API parameters based on selected range (from global context)
    let days: number | undefined = getDaysFromRange(selectedRange);
    let from_date: string | undefined = getFromDate();
    let to_date: string | undefined = getToDate();

    if (selectedRange === 'custom') {
      if (customFrom) from_date = customFrom;
      if (customTo) to_date = customTo;
    } else if (selectedRange === 'all') {
      days = 36500; // ~100 years
    }

    try {
      const response: PaginatedSessionsResponse = await api.getPaginatedSessions({
        page: pagination.page,
        page_size: PAGE_SIZE,
        source_type: sourceType !== 'all' ? sourceType : undefined,
        search: search || undefined,
        sort_desc: sortDesc,
        days,
        from_date,
        to_date,
      });
      
      if (!response.ok) {
        throw new Error('API returned error status');
      }
      
      setSessions(response.data);
      const totalPages = Math.ceil(response.pagination.total / PAGE_SIZE);
      setPagination({
        page: response.pagination.page,
        page_size: response.pagination.page_size,
        total: response.pagination.total,
        total_pages: totalPages,
        has_next: response.pagination.page < totalPages,
        has_prev: response.pagination.page > 1,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
      setError(`Fehler beim Laden der Sessions: ${message}`);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [pagination.page, sourceType, search, sortDesc, selectedRange, customFrom, customTo]);

  // Fetch on param changes
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPagination((p: PaginationInfo) => ({ ...p, page: 1 }));
  };

  const handleSourceTypeChange = (value: 'all' | 'home' | 'external' | 'import') => {
    setSourceType(value);
    setPagination((p: PaginationInfo) => ({ ...p, page: 1 }));
  };

  const handleSortToggle = () => {
    setSortDesc((d: boolean) => !d);
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.total_pages) {
      setPagination((p: PaginationInfo) => ({ ...p, page: newPage }));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleCustomRangeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customFrom && customTo) {
      setPagination(p => ({ ...p, page: 1 }));
      fetchSessions();
    }
  };

  const formatSourceType = (type: string): string => {
    switch (type) {
      case 'home': return 'Zuhause';
      case 'external': return 'Extern';
      case 'import': return 'Import';
      default: return type;
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  

  return (
    <div className="page-container">
      <div className="sessions-page">
        <header className="sessions-page__header">
          <div>
            <h1 className="sessions-page__title">Sessions</h1>
            <p className="sessions-page__subtitle">
              Alle Ladevorgänge durchsuchen, filtern und sortieren · <span className="sessions-page__status">{getRangeLabel(selectedRange)}</span>
            </p>
          </div>
        </header>

        {/* Filter Bar */}
        <div className="sessions-page__filter-bar">
          <div className="sessions-page__search">
            <label htmlFor="sessions-search" className="sr-only">Suchen</label>
            <div className="sessions-page__search-input">
              <Search className="sessions-page__search-icon" />
              <input
                id="sessions-search"
                type="search"
                placeholder="Ort, Notiz…"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="sessions-page__search-field"
              />
            </div>
          </div>
          
          <div className="sessions-page__filters">
            <div className="sessions-page__filter-group">
              <label htmlFor="source-type-filter" className="sr-only">Quelle filtern</label>
              <select
                id="source-type-filter"
                value={sourceType}
                onChange={(e) => handleSourceTypeChange(e.target.value as 'all' | 'home' | 'external' | 'import')}
                className="sessions-page__select"
              >
                {SOURCE_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            
            <button
              onClick={handleSortToggle}
              className="sessions-page__sort-btn"
              aria-pressed={sortDesc}
              aria-label={sortDesc ? 'Nach Datum aufsteigend sortieren' : 'Nach Datum absteigend sortieren'}
            >
              <span>Datum</span>
              {sortDesc ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <LoadingState message="Sessions werden geladen…" />
        ) : error ? (
          <ErrorState message={error} onRetry={fetchSessions} />
        ) : sessions.length === 0 ? (
          <EmptyState
            title="Keine Sessions gefunden"
            message={search || sourceType !== 'all' 
              ? 'Versuche die Filter zu ändern.' 
              : 'Es wurden noch keine Ladevorgänge importiert.'}
          />
        ) : (
          <>
            <div className="sessions-page__table-container">
              <SessionsTable sessions={sessions} />
            </div>
            
            <div className="sessions-page__mobile-cards">
              {sessions.map(session => (
                <SessionMobileCard key={session.id} session={session} />
              ))}
            </div>

            {/* Pagination */}
            {pagination.total_pages > 1 && (
              <nav className="sessions-page__pagination" aria-label="Seiten-Navigation">
                <button
                  onClick={() => handlePageChange(pagination.page - 1)}
                  disabled={!pagination.has_prev}
                  className="sessions-page__page-btn"
                  aria-label="Vorherige Seite"
                >
                  <ChevronLeft size={18} />
                </button>
                
                <div className="sessions-page__page-info">
                  <span>
                    Seite {pagination.page} von {pagination.total_pages}
                  </span>
                </div>
                
                <button
                  onClick={() => handlePageChange(pagination.page + 1)}
                  disabled={!pagination.has_next}
                  className="sessions-page__page-btn"
                  aria-label="Nächste Seite"
                >
                  <ChevronRight size={18} />
                </button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}