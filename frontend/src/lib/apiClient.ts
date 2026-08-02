import type { OverviewResponse, Session, HealthResponse, PaginatedSessionsResponse, StatisticsResponse, OverviewSummaryResponse } from '../types/api';

const API_BASE = '/api';

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    throw new ApiError(response.status, `API Error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  async health(): Promise<HealthResponse> {
    return fetchJson<HealthResponse>('/health');
  },

  async getRecentSessions(limit: number = 10): Promise<OverviewResponse> {
    return fetchJson<OverviewResponse>(`/overview/recent-sessions?limit=${limit}`);
  },

  async getSessions(params?: { 
    limit?: number; 
    from?: string; 
    to?: string;
    page?: number;
    page_size?: number;
    source_type?: string;
    search?: string;
    sort_desc?: boolean;
  }): Promise<OverviewResponse> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.from) searchParams.set('from', params.from);
    if (params?.to) searchParams.set('to', params.to);
    const query = searchParams.toString();
    return fetchJson<OverviewResponse>(`/overview/recent-sessions${query ? `?${query}` : ''}`);
  },

  async getPaginatedSessions(params: {
    page: number;
    page_size: number;
    source_type?: string;
    search?: string;
    sort_desc?: boolean;
  }): Promise<PaginatedSessionsResponse> {
    const searchParams = new URLSearchParams();
    searchParams.set('page', params.page.toString());
    searchParams.set('page_size', params.page_size.toString());
    if (params.source_type) searchParams.set('source_type', params.source_type);
    if (params.search) searchParams.set('search', params.search);
    if (params.sort_desc !== undefined) searchParams.set('sort_desc', params.sort_desc.toString());
    return fetchJson<PaginatedSessionsResponse>(`/sessions?${searchParams.toString()}`);
  },

  async getStatistics(range: string = '30d'): Promise<StatisticsResponse> {
    return fetchJson<StatisticsResponse>(`/statistics?range=${range}`);
  },

  async getOverviewSummary(): Promise<OverviewSummaryResponse> {
    return fetchJson<OverviewSummaryResponse>(`/overview/summary`);
  },
};

export { ApiError };
export type { OverviewResponse, Session, HealthResponse, PaginatedSessionsResponse, PaginationInfo, StatisticsResponse, StatisticsKPIs, SourceBreakdown, OverviewSummaryResponse } from '../types/api';