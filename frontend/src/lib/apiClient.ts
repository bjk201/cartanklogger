// API Client for CarTankLogger 2.0
// Re-exports all types from types/api.ts and provides API functions

import type {
  Session,
  PaginationInfo,
  OverviewResponse,
  OverviewSummaryResponse,
  PaginatedSessionsResponse,
  StatisticsKPIs,
  SourceBreakdown,
  StatisticsResponse,
  MatchedCharge,
  SessionMatch,
  SessionMatchesResponse,
  SessionMatchActionResponse,
  UnmatchedChargeItem,
  UnmatchedChargesResponse,
  MatchingSummary,
  MatchingDryRunResponse,
  LiveMatchingDryRunResponse,
  MatchingRawDataResponse,
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
  MatchingOverrideCreate,
  MatchingOverrideRead,
  MatchingOverrideListResponse,
  MatchingOverrideSingleResponse,
  MatchingOverrideUpdate,
  DataSourceConfigRead,
  DataSourceConfigWrite,
  DataSourceConfigTestRequest,
  DataSourceConfigTestResponse,
  HealthResponse,
  DataSourceStatusResponse,
  LiveMatchingStatusResponse,
  ExtraCostCategory,
  MonthlyPvPoint,
} from '../types/api';

// Re-export all types for consumers
export type {
  Session,
  PaginationInfo,
  OverviewResponse,
  OverviewSummaryResponse,
  PaginatedSessionsResponse,
  StatisticsKPIs,
  MonthlyPvPoint,
  SourceBreakdown,
  StatisticsResponse,
  MatchedCharge,
  SessionMatch,
  SessionMatchesResponse,
  SessionMatchActionResponse,
  UnmatchedChargeItem,
  UnmatchedChargesResponse,
  MatchingSummary,
  MatchingDryRunResponse,
  LiveMatchingDryRunResponse,
  MatchingRawDataResponse,
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
  MatchingOverrideCreate,
  MatchingOverrideRead,
  MatchingOverrideListResponse,
  MatchingOverrideSingleResponse,
  MatchingOverrideUpdate,
  DataSourceConfigRead,
  DataSourceConfigWrite,
  DataSourceConfigTestRequest,
  DataSourceConfigTestResponse,
  HealthResponse,
  DataSourceStatusResponse,
  LiveMatchingStatusResponse,
  ExtraCostCategory,
};

// ===== API Functions =====

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    // Backend-Detailmeldung bevorzugen (z. B. Lösch-Schutz-Begründung)
    let detail: string | null = null;
    try {
      const body = await res.json();
      if (body?.detail) {
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* kein JSON-Body — Statustext fällt zurück */
    }
    throw new Error(detail || `HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

// --- Health ---
export function health(): Promise<HealthResponse> {
  return request('/health');
}

// --- Overview ---
export function getOverviewData(): Promise<OverviewResponse> {
  return request('/overview/recent-sessions');
}

export function getRecentSessions(
  limit: number = 100,
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<OverviewResponse> {
  const p = new URLSearchParams();
  p.set('limit', String(limit));
  if (days !== undefined) p.set('days', String(days));
  if (from_date) p.set('from_date', from_date);
  if (to_date) p.set('to_date', to_date);
  return request(`/overview/recent-sessions?${p.toString()}`);
}

export function getOverviewSummary(
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<OverviewSummaryResponse> {
  const p = new URLSearchParams();
  if (days !== undefined) p.set('days', String(days));
  if (from_date) p.set('from_date', from_date);
  if (to_date) p.set('to_date', to_date);
  const qs = p.toString();
  return request(`/overview/summary${qs ? `?${qs}` : ''}`);
}

// --- Statistics ---
export function getStatisticsData(): Promise<StatisticsResponse> {
  return request('/statistics');
}

export function getStatistics(
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<StatisticsResponse> {
  const params = new URLSearchParams();
  if (days !== undefined) params.set('days', String(days));
  if (from_date) params.set('from_date', from_date);
  if (to_date) params.set('to_date', to_date);
  const qs = params.toString();
  return request(`/statistics${qs ? `?${qs}` : ''}`);
}

// --- Data Source ---
export function getDataSourceStatus(): Promise<DataSourceStatusResponse> {
  return request('/status');
}

export function getDataSourceConfig(): Promise<DataSourceConfigRead> {
  return request('/settings/data-sources');
}

export function saveDataSourceConfig(payload: DataSourceConfigWrite): Promise<DataSourceConfigRead> {
  return request('/settings/data-sources', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function testDataSourceConnection(payload: DataSourceConfigTestRequest): Promise<DataSourceConfigTestResponse> {
  return request('/settings/data-sources/test', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function saveConfig(payload: any): Promise<any> {
  return request('/settings/data-sources', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Sessions ---
export interface GetSessionsParams {
  page?: number;
  page_size?: number;
  source_type?: string;
  search?: string;
  sort_desc?: boolean;
  days?: number;
  from_date?: string;
  to_date?: string;
}

export function getPaginatedSessions(params: GetSessionsParams = {}): Promise<PaginatedSessionsResponse> {
  const p = new URLSearchParams();
  if (params.page !== undefined) p.set('page', String(params.page));
  if (params.page_size !== undefined) p.set('page_size', String(params.page_size));
  if (params.source_type) p.set('source_type', params.source_type);
  if (params.search) p.set('search', params.search);
  if (params.sort_desc !== undefined) p.set('sort_desc', String(params.sort_desc));
  if (params.days !== undefined) p.set('days', String(params.days));
  if (params.from_date) p.set('from_date', params.from_date);
  if (params.to_date) p.set('to_date', params.to_date);
  const qs = p.toString();
  return request(`/sessions${qs ? `?${qs}` : ''}`);
}

export function getSessions(params: GetSessionsParams = {}): Promise<PaginatedSessionsResponse> {
  return getPaginatedSessions(params);
}

// --- Session Matches ---
export function getSessionMatches(sessionId: number): Promise<SessionMatchesResponse> {
  return request(`/sessions/${sessionId}/matches`);
}

export function createSessionMatch(
  sessionId: number,
  tmChargeId: number
): Promise<SessionMatchActionResponse> {
  return request(`/sessions/${sessionId}/match`, {
    method: 'POST',
    body: JSON.stringify({ tm_charge_id: tmChargeId }),
  });
}

// --- Matching ---
export function getMatchingRawData(
  limit?: number,
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<MatchingRawDataResponse> {
  const p = new URLSearchParams();
  if (limit !== undefined) p.set('limit', String(limit));
  if (days !== undefined) p.set('days', String(days));
  if (from_date) p.set('from_date', from_date);
  if (to_date) p.set('to_date', to_date);
  return request(`/matching/raw-data?${p.toString()}`);
}

export function getUnmatchedCharges(days: number = 36500): Promise<UnmatchedChargesResponse> {
  return request(`/matching/unmatched?days=${days}`);
}

export interface SessionTmSumsResponse {
  ok: boolean;
  data?: {
    session_id: number;
    source_id: string;
    tm_sum_kwh: number | null;
    tm_used_kwh: number | null;
    tm_count: number;
    evcc_energy_kwh: number | null;
  }[];
}

export function getSessionTmSums(
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<SessionTmSumsResponse> {
  const p = new URLSearchParams();
  if (days !== undefined) p.set('days', String(days));
  if (from_date) p.set('from_date', from_date);
  if (to_date) p.set('to_date', to_date);
  const qs = p.toString();
  return request(`/sessions/tm-sums${qs ? `?${qs}` : ''}`);
}

export function syncDataSources(): Promise<any> {
  return request('/settings/data-sources/sync', { method: 'POST' });
}

// --- Session Edit/Delete ---
export interface SessionUpdate {
  date?: string;
  energy_kwh?: number | null;
  cost_eur?: number | null;
  cost_per_kwh?: number | null;
  location?: string | null;
  odometer_km?: number | null;
  distance_km?: number | null;
  note?: string | null;
}

export function updateSession(id: number, data: SessionUpdate): Promise<any> {
  return request(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteSession(id: number): Promise<any> {
  return request(`/sessions/${id}`, { method: 'DELETE' });
}

// --- Vehicle Records ---
export function getVehicleRecords(): Promise<VehicleRecordsResponse> {
  return request('/vehicle/records');
}

export function createVehicleRecord(data: VehicleRecordCreate): Promise<VehicleSingleResponse> {
  return request('/vehicle/records', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateVehicleRecord(id: number, data: VehicleRecordUpdate): Promise<VehicleSingleResponse> {
  return request(`/vehicle/records/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteVehicleRecord(id: number): Promise<any> {
  return request(`/vehicle/records/${id}`, { method: 'DELETE' });
}

// Reifensatz-Wechsel: alter Satz wird archiviert, neuer Satz angelegt.
// odometer_km leer lassen → Backend leitet den KM-Stand automatisch ab.
export interface TireSetReplace {
  date: string;
  odometer_km?: number | null;
  title: string;
  note?: string | null;
  shop?: string | null;
  tire_brand?: string | null;
  tire_season?: string | null;
  cost_eur?: number | null;
}

export function replaceTireSet(oldRecordId: number, data: TireSetReplace): Promise<any> {
  return request(`/vehicle/records/${oldRecordId}/replace-tire`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// KM-Stand automatisch ableiten für Eintrag ohne km (Zubehör etc.)
export function syncRecordOdometer(id: number): Promise<any> {
  return request(`/vehicle/records/${id}/sync-odometer`, { method: 'POST' });
}

// --- Extra Costs ---
export function getExtraCosts(): Promise<ExtraCostListResponse> {
  return request('/extra-costs');
}

export function createExtraCost(data: ExtraCostCreate): Promise<ExtraCostSingleResponse> {
  return request('/extra-costs', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateExtraCost(id: number, data: ExtraCostUpdate): Promise<ExtraCostSingleResponse> {
  return request(`/extra-costs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteExtraCost(id: number): Promise<any> {
  return request(`/extra-costs/${id}`, { method: 'DELETE' });
}

// --- Matching Overrides ---
export function getMatchingOverrides(): Promise<MatchingOverrideListResponse> {
  return request('/matching/overrides');
}

export function createMatchingOverride(data: MatchingOverrideCreate): Promise<MatchingOverrideSingleResponse> {
  return request('/matching/overrides', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateMatchingOverride(id: number, data: MatchingOverrideUpdate): Promise<MatchingOverrideSingleResponse> {
  return request(`/matching/overrides/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteMatchingOverride(id: number): Promise<any> {
  return request(`/matching/overrides/${id}`, { method: 'DELETE' });
}

// --- Live Matching ---
export function getMatchingDryRun(
  limit: number = 200,
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<MatchingDryRunResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (days !== undefined) params.set('days', String(days));
  if (from_date) params.set('from_date', from_date);
  if (to_date) params.set('to_date', to_date);
  return request(`/matching/dry-run?${params.toString()}`);
}

export function getMatchingDryRunLive(
  limit: number = 200,
  days?: number,
  from_date?: string,
  to_date?: string
): Promise<LiveMatchingDryRunResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (days !== undefined) params.set('days', String(days));
  if (from_date) params.set('from_date', from_date);
  if (to_date) params.set('to_date', to_date);
  return request(`/matching/dry-run/live?${params.toString()}`);
}

export function getMatchingLiveStatus(): Promise<LiveMatchingStatusResponse> {
  return request('/matching/dry-run/status');
}

export function getLiveMatchingStatus(): Promise<LiveMatchingStatusResponse> {
  return request('/matching/dry-run/status');
}

// --- Vehicle Info ---
export function getVehicleInfo(): Promise<VehicleInfoResponse> {
  return request('/vehicle/info');
}

// ===== API Object (convenience wrapper) =====
export const api = {
  health,
  getOverviewData,
  getRecentSessions,
  getOverviewSummary,
  getStatisticsData,
  getStatistics,
  getDataSourceStatus,
  getDataSourceConfig,
  saveDataSourceConfig,
  testDataSourceConnection,
  saveConfig,
  getPaginatedSessions,
  getSessions,
  getSessionMatches,
  createSessionMatch,
  getMatchingRawData,
  getUnmatchedCharges,
  getSessionTmSums,
  syncDataSources,
  getVehicleRecords,
  createVehicleRecord,
  updateVehicleRecord,
  deleteVehicleRecord,
  replaceTireSet,
  syncRecordOdometer,
  getExtraCosts,
  createExtraCost,
  updateExtraCost,
  deleteExtraCost,
  getMatchingOverrides,
  createMatchingOverride,
  updateMatchingOverride,
  deleteMatchingOverride,
  getLiveMatchingStatus,
  getMatchingDryRun,
  getMatchingDryRunLive,
  getMatchingLiveStatus,
  getVehicleInfo,
};