import type { OverviewResponse, Session, HealthResponse } from '../types/api';

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

  async getSessions(params?: { limit?: number; from?: string; to?: string }): Promise<OverviewResponse> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.from) searchParams.set('from', params.from);
    if (params?.to) searchParams.set('to', params.to);
    const query = searchParams.toString();
    return fetchJson<OverviewResponse>(`/overview/recent-sessions${query ? `?${query}` : ''}`);
  },
};

export { ApiError };
export type { OverviewResponse, Session, HealthResponse } from '../types/api';