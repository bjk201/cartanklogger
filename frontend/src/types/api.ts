export interface Session {
  id: number;
  source_type: 'home' | 'external' | 'import';
  source_id: string;
  date: string;
  location: string | null;
  energy_kwh: number | null;
  cost_eur: number | null;
  odometer_km: number | null;
  distance_km: number | null;
  note: string | null;
  // PV / Solar data (from EVCC home_sessions)
  solar_percentage: number | null;
  pv_kwh: number | null;
  // Cost per kWh
  // EVCC: directly from pricePerKWh API field (source='api')
  // TeslaMate: derived from cost / charge_energy_added (source='derived')
  cost_per_kwh: number | null;
  cost_per_kwh_source: 'api' | 'derived' | null;
}

export interface MetaInfo {
  count: number;
  limit: number;
}

export interface ErrorDetail {
  code: string;
  message: string;
  field?: string;
}

export interface OverviewResponse {
  ok: boolean;
  data: Session[];
  meta: MetaInfo;
  errors: ErrorDetail[];
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  database: string;
  data_source: 'demo' | 'live';
  data_source_description: string;
}

export interface DataSourceStatusResponse {
  ok: boolean;
  data_source: 'demo' | 'live';
  data_source_description: string;
  message: string;
  evcc: ReachabilityStatus;
  teslamateapi: ReachabilityStatus;
}

export interface ReachabilityStatus {
  configured: boolean;
  reachable: boolean;
  status_code?: number;
  error?: string;
}

export interface KPIData {
  totalSessions: number;
  totalEnergy: number;
  totalCost: number;
  homeShare: number;
}

export interface PaginationInfo {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface PaginatedSessionsResponse {
  ok: boolean;
  data: Session[];
  meta: MetaInfo;
  pagination: PaginationInfo;
  errors: ErrorDetail[];
}

// Statistics Types
export interface SourceBreakdown {
  home: number;
  external: number;
  import: number;
  total: number;
}

export interface StatisticsKPIs {
  total_energy_kwh: number;
  total_cost_eur: number;
  avg_cost_per_kwh: number | null;
  total_sessions: number;
  home_sessions: number;
  external_sessions: number;
  import_sessions: number;
  avg_energy_per_session: number | null;
  avg_cost_per_session: number | null;
  max_energy_session: number | null;
  max_cost_session: number | null;
  max_energy_session_id: number | null;
  max_cost_session_id: number | null;
}

export interface StatisticsResponse {
  ok: boolean;
  kpis: StatisticsKPIs;
  energy_by_source: SourceBreakdown;
  cost_by_source: SourceBreakdown;
  sessions_by_source: SourceBreakdown;
  range_days: number;
  range_label: string;
  errors: ErrorDetail[];
}

// Overview Summary Types
export interface OverviewSummaryResponse {
  ok: boolean;
  total_sessions: number;
  total_energy_kwh: number;
  total_cost_eur: number;
  avg_cost_per_kwh: number | null;
  home_sessions: number;
  external_sessions: number;
  import_sessions: number;
  home_energy_kwh: number;
  external_energy_kwh: number;
  home_cost_eur: number;
  external_cost_eur: number;
  home_share_pct: number;
  errors: ErrorDetail[];
}

// Data Sources Settings Types
export interface DataSourceConfigRead {
  evcc_host: string;
  evcc_port: number;
  evcc_password: string;
  evcc_api_token: string;
  evcc_use_tls: boolean;
  teslamateapi_base_url: string;
  teslamateapi_token: string;
  evcc_configured: boolean;
  teslamateapi_configured: boolean;
  data_source: 'demo' | 'live';
}

export interface DataSourceConfigWrite {
  host: string;
  port: number;
  password?: string | null;
  api_token?: string | null;
  use_tls: boolean;
  base_url: string;
  token?: string | null;
}

export interface DataSourceConfigTestRequest {
  source: 'evcc' | 'teslamateapi';
  host?: string;
  port?: number;
  password?: string;
  api_token?: string;
  use_tls?: boolean;
  base_url?: string;
  token?: string;
}

export interface DataSourceConfigTestResponse {
  ok: boolean;
  source: 'evcc' | 'teslamateapi';
  status: ReachabilityStatus;
}