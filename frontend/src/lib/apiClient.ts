import type {
  OverviewResponse,
  OverviewSummaryResponse,
  Session,
  HealthResponse,
  PaginatedSessionsResponse,
  PaginationInfo,
  StatisticsResponse,
  StatisticsKPIs,
  SourceBreakdown,
  DataSourceStatusResponse,
  DataSourceConfigRead,
  DataSourceConfigWrite,
  DataSourceConfigTestRequest,
  DataSourceConfigTestResponse,
  MatchingDryRunResponse,
  MatchingOverrideCreate,
  MatchingOverrideRead,
  MatchingOverrideListResponse,
  MatchingOverrideSingleResponse,
  MatchingRawDataResponse,
  LiveMatchingDryRunResponse,
  LiveMatchingStatusResponse,
  VehicleInfoResponse,
  VehicleRecordRead,
  VehicleRecordCreate,
  VehicleRecordUpdate,
  VehicleRecordsResponse,
  VehicleSingleResponse,
  ExtraCostRead,
  ExtraCostCreate,
  ExtraCostUpdate,
  ExtraCostListResponse,
  ExtraCostSingleResponse,
  MetaInfo,
  ErrorDetail,
} from '../types/api';

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

  async getRecentSessions(limit: number = 100, days?: number, from_date?: string, to_date?: string): Promise<OverviewResponse> {
    const searchParams = new URLSearchParams();
    searchParams.set('limit', limit.toString());
    if (days) searchParams.set('days', days.toString());
    if (from_date) searchParams.set('from_date', from_date);
    if (to_date) searchParams.set('to_date', to_date);
    return fetchJson<OverviewResponse>(`/overview/recent-sessions?${searchParams.toString()}`);
  },

  async getSessions(params?: {
    page?: number;
    page_size?: number;
    source_type?: string;
    search?: string;
    sort_desc?: boolean;
    days?: number;
    from_date?: string;
    to_date?: string;
  }): Promise<OverviewResponse> {
    const searchParams = new URLSearchParams();
    if (params?.page !== undefined) searchParams.set('page', params.page.toString());
    if (params?.page_size !== undefined) searchParams.set('page_size', params.page_size.toString());
    if (params?.source_type) searchParams.set('source_type', params.source_type);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.sort_desc !== undefined) searchParams.set('sort_desc', params.sort_desc.toString());
    if (params?.days) searchParams.set('days', params.days.toString());
    if (params?.from_date) searchParams.set('from_date', params.from_date);
    if (params?.to_date) searchParams.set('to_date', params.to_date);
    const query = searchParams.toString();
    return fetchJson<OverviewResponse>(`/sessions${query ? `?${query}` : ''}`);
  },

  async getPaginatedSessions(params: {
    page: number;
    page_size: number;
    source_type?: string;
    search?: string;
    sort_desc?: boolean;
    days?: number;
    from_date?: string;
    to_date?: string;
  }): Promise<PaginatedSessionsResponse> {
    const searchParams = new URLSearchParams();
    searchParams.set('page', params.page.toString());
    searchParams.set('page_size', params.page_size.toString());
    if (params.source_type) searchParams.set('source_type', params.source_type);
    if (params.search) searchParams.set('search', params.search);
    if (params.sort_desc !== undefined) searchParams.set('sort_desc', params.sort_desc.toString());
    if (params.days) searchParams.set('days', params.days.toString());
    if (params.from_date) searchParams.set('from_date', params.from_date);
    if (params.to_date) searchParams.set('to_date', params.to_date);
    return fetchJson<PaginatedSessionsResponse>(`/sessions?${searchParams.toString()}`);
  },

  async getStatistics(days?: number, from_date?: string, to_date?: string): Promise<StatisticsResponse> {
    const searchParams = new URLSearchParams();
    if (days) searchParams.set('days', days.toString());
    if (from_date) searchParams.set('from_date', from_date);
    if (to_date) searchParams.set('to_date', to_date);
    const query = searchParams.toString();
    return fetchJson<StatisticsResponse>(`/statistics${query ? `?${query}` : ''}`);
  },

  async getOverviewSummary(days?: number, from_date?: string, to_date?: string): Promise<OverviewSummaryResponse> {
    const searchParams = new URLSearchParams();
    if (days) searchParams.set('days', days.toString());
    if (from_date) searchParams.set('from_date', from_date);
    if (to_date) searchParams.set('to_date', to_date);
    const query = searchParams.toString();
    return fetchJson<OverviewSummaryResponse>(`/overview/summary${query ? `?${query}` : ''}`);
  },

  async getDataSourceStatus(): Promise<DataSourceStatusResponse> {
    return fetchJson<DataSourceStatusResponse>(`/status`);
  },

  // Data Sources Settings
  async getDataSourceConfig(): Promise<DataSourceConfigRead> {
    return fetchJson<DataSourceConfigRead>(`/settings/data-sources`);
  },

  async saveDataSourceConfig(config: DataSourceConfigWrite): Promise<DataSourceConfigRead> {
    return fetchJson<DataSourceConfigRead>(`/settings/data-sources`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  async testDataSourceConnection(request: DataSourceConfigTestRequest): Promise<DataSourceConfigTestResponse> {
    return fetchJson<DataSourceConfigTestResponse>(`/settings/data-sources/test`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  // Matching
  async getMatchingDryRun(limit?: number, days?: number, from_date?: string, to_date?: string): Promise<MatchingDryRunResponse> {
    const searchParams = new URLSearchParams();
    if (limit) searchParams.set('limit', limit.toString());
    if (days) searchParams.set('days', days.toString());
    if (from_date) searchParams.set('from_date', from_date);
    if (to_date) searchParams.set('to_date', to_date);
    const query = searchParams.toString();
    return fetchJson<MatchingDryRunResponse>(`/matching/dry-run${query ? `?${query}` : ''}`);
  },

  async getMatchingRawData(limit?: number, days?: number, from_date?: string, to_date?: string): Promise<MatchingRawDataResponse> {
    const searchParams = new URLSearchParams();
    if (limit) searchParams.set('limit', limit.toString());
    if (days) searchParams.set('days', days.toString());
    if (from_date) searchParams.set('from_date', from_date);
    if (to_date) searchParams.set('to_date', to_date);
    const query = searchParams.toString();
    return fetchJson<MatchingRawDataResponse>(`/matching/raw-data${query ? `?${query}` : ''}`);
  },

  async getMatchingOverrides(): Promise<MatchingOverrideListResponse> {
    return fetchJson<MatchingOverrideListResponse>(`/matching/overrides`);
  },

  async createMatchingOverride(payload: MatchingOverrideCreate): Promise<MatchingOverrideSingleResponse> {
    return fetchJson<MatchingOverrideSingleResponse>(`/matching/overrides`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async deleteMatchingOverride(overrideId: number): Promise<MatchingOverrideSingleResponse> {
    return fetchJson<MatchingOverrideSingleResponse>(`/matching/overrides/${overrideId}`, {
      method: 'DELETE',
    });
  },

    // Live Matching
  async getMatchingLiveStatus(): Promise<LiveMatchingStatusResponse> {
    return fetchJson<LiveMatchingStatusResponse>('/matching/dry-run/status');
  },

  async getMatchingDryRunLive(limit?: number, days?: number, from_date?: string, to_date?: string): Promise<LiveMatchingDryRunResponse> {
    const searchParams = new URLSearchParams();
    if (limit) searchParams.set('limit', limit.toString());
    if (days) searchParams.set('days', days.toString());
    if (from_date) searchParams.set('from_date', from_date);
    if (to_date) searchParams.set('to_date', to_date);
    const query = searchParams.toString();
    return fetchJson<LiveMatchingDryRunResponse>(`/matching/dry-run/live${query ? `?${query}` : ''}`);
  },

  // Vehicle
  async getVehicleInfo(): Promise<VehicleInfoResponse> {
    return fetchJson<VehicleInfoResponse>('/vehicle/info');
  },
  async getVehicleRecords(): Promise<VehicleRecordsResponse> {
    return fetchJson<VehicleRecordsResponse>('/vehicle/records');
  },
  async createVehicleRecord(payload: VehicleRecordCreate): Promise<VehicleSingleResponse> {
    return fetchJson<VehicleSingleResponse>('/vehicle/records', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  async updateVehicleRecord(id: number, payload: VehicleRecordUpdate): Promise<VehicleSingleResponse> {
    return fetchJson<VehicleSingleResponse>(`/vehicle/records/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },
  async deleteVehicleRecord(id: number): Promise<VehicleSingleResponse> {
    return fetchJson<VehicleSingleResponse>(`/vehicle/records/${id}`, {
      method: 'DELETE',
    });
  },
  async replaceTire(id: number): Promise<VehicleSingleResponse> {
    return fetchJson<VehicleSingleResponse>(`/vehicle/records/${id}/replace-tire`, {
      method: 'PUT',
    });
  },

  // Extra Costs
  async getExtraCosts(): Promise<ExtraCostListResponse> {
    return fetchJson<ExtraCostListResponse>('/extra-costs');
  },
  async getExtraCost(id: number): Promise<ExtraCostSingleResponse> {
    return fetchJson<ExtraCostSingleResponse>(`/extra-costs/${id}`);
  },
  async createExtraCost(payload: ExtraCostCreate): Promise<ExtraCostSingleResponse> {
    return fetchJson<ExtraCostSingleResponse>('/extra-costs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  async updateExtraCost(id: number, payload: ExtraCostUpdate): Promise<ExtraCostSingleResponse> {
    return fetchJson<ExtraCostSingleResponse>(`/extra-costs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },
  async deleteExtraCost(id: number): Promise<ExtraCostSingleResponse> {
    return fetchJson<ExtraCostSingleResponse>(`/extra-costs/${id}`, {
      method: 'DELETE',
    });
  },
};

export { ApiError };
export type {
  OverviewResponse,
  OverviewSummaryResponse,
  Session,
  HealthResponse,
  PaginatedSessionsResponse,
  PaginationInfo,
  StatisticsResponse,
  StatisticsKPIs,
  SourceBreakdown,
  DataSourceStatusResponse,
  DataSourceConfigRead,
  DataSourceConfigWrite,
  DataSourceConfigTestRequest,
  DataSourceConfigTestResponse,
  MetaInfo,
  ErrorDetail,
} from '../types/api';