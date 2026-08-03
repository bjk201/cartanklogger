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
  timestamp?: string;
  evcc: ReachabilityStatus;
  teslamateapi: ReachabilityStatus;
}

export interface ReachabilityStatus {
  configured: boolean;
  reachable: boolean;
  level?: 'reachable' | 'data_fetch_error' | 'unreachable';
  status_code?: number;
  error?: string;
  data_error?: string;
  last_checked?: string;
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

// Matching Types
export interface MatchedCharge {
  charge_id: number;
  source_id: string;
  date: string;
  energy_kwh: number | null;
  cost_eur: number | null;
  location: string | null;
  location_original: string | null;
  location_normalized: string | null;
  accepted_as_candidate: boolean;
  reject_reason: string | null;
  overlap_seconds: number;
  containment: string;
  match_source: 'auto' | 'manual_override';
  override_id: number | null;
  override_reason: string | null;
  replaced_auto_match: string | null;
  skipped_due_to_other_override: boolean;
}

export interface EVCCSessionMatch {
  evcc_session_id: number;
  evcc_source_id: string;
  evcc_start: string;
  evcc_end: string;
  evcc_energy_kwh: number | null;
  evcc_cost_eur: number | null;
  evcc_cost_per_kwh: number | null;
  evcc_location: string | null;
  matched_charge_count: number;
  matched_charge_ids: number[];
  matched_charges: MatchedCharge[];
  matched_charge_energy_kwh_sum: number | null;
  delta_kwh: number | null;
  match_quality: 'exact' | 'plausible' | 'weak' | 'unmatched';
  match_notes: string;
}

export interface MatchingSummary {
  total_evcc_sessions_checked: number;
  total_matched: number;
  total_unmatched: number;
  total_evcc_energy: number;
  total_tm_energy: number;
  total_delta_kwh: number;
  quality_distribution: Record<string, number>;
  total_tm_charges: number;
  accepted_candidates: number;
  rejected_wrong_location: number;
}

export interface MatchingDryRunResponse {
  ok: boolean;
  matches: EVCCSessionMatch[];
  summary: MatchingSummary;
  timestamp: string;
  error?: string;
}

// Matching Override Types
export interface MatchingOverrideCreate {
  teslamate_charge_id: number;
  evcc_session_id: number | null;
  override_type: 'manual_assign' | 'manual_unassign' | 'reset_to_auto';
  reason: string | null;
}

export interface MatchingOverrideRead {
  id: number;
  teslamate_charge_id: number;
  evcc_session_id: number | null;
  override_type: string;
  reason: string | null;
  replaced_auto_match: string | null;
  created_at: string;
  created_by: string | null;
}

export interface MatchingOverrideListResponse {
  ok: boolean;
  overrides: MatchingOverrideRead[];
}

export interface MatchingOverrideSingleResponse {
  ok: boolean;
  override: MatchingOverrideRead;
}

// Matching Raw Data Types
export interface EVCCRawSession {
  evcc_session_id: number;
  source_id: string;
  created: string | null;
  finished: string | null;
  location: string | null;
  energy_kwh: number | null;
  cost_eur: number | null;
  cost_per_kwh: number | null;
  cost_per_kwh_source: string | null;
  odometer_km: number | null;
  distance_km: number | null;
  note: string | null;
  solar_percentage: number | null;
  pv_kwh: number | null;
  legacy_source: string | null;
  legacy_table: string | null;
  legacy_id: number | null;
  vehicle: string | null;
  soc_start: number | null;
  soc_end: number | null;
}

export interface TMRawCharge {
  charge_id: number;
  source_id: string;
  start_date: string | null;
  end_date: string | null;
  location_original: string | null;
  location_normalized: string | null;
  energy_kwh: number | null;
  cost_eur: number | null;
  cost_per_kwh: number | null;
  cost_per_kwh_source: string | null;
  odometer_km: number | null;
  distance_km: number | null;
  note: string | null;
  legacy_source: string | null;
  legacy_table: string | null;
  legacy_id: number | null;
  is_home_location: boolean;
  override: {
    override_id: number;
    evcc_session_id: number | null;
    override_type: string;
    reason: string | null;
    replaced_auto_match: string | null;
  } | null;
  provider: string | null;
  soc_start: number | null;
  soc_end: number | null;
}

export interface MatchingRawDataResponse {
  ok: boolean;
  evcc_sessions: EVCCRawSession[];
  teslamate_charges: TMRawCharge[];
  active_overrides_count: number;
  total_evcc: number;
  total_tm: number;
  home_tm_charges: number;
  external_tm_charges: number;
  timestamp: string;
}

// Live Matching Types
export interface LiveMatchedCharge {
  charge_id: number;
  source_id: string;
  date: string;
  energy_kwh: number | null;
  cost_eur: number | null;
  location: string | null;
  location_original: string | null;
  location_normalized: string | null;
  accepted_as_candidate: boolean;
  reject_reason: string | null;
  overlap_seconds: number;
  containment: string;
  match_source: 'auto' | 'manual_override';
  override_id: number | null;
  override_reason: string | null;
  replaced_auto_match: string | null;
  skipped_due_to_other_override: boolean;
}

export interface LiveEVCCSessionMatch {
  evcc_session_id: number;
  evcc_source_id: string;
  evcc_start: string;
  evcc_end: string;
  evcc_energy_kwh: number | null;
  evcc_cost_eur: number | null;
  evcc_cost_per_kwh: number | null;
  evcc_location: string | null;
  matched_charge_count: number;
  matched_charge_ids: number[];
  matched_charges: LiveMatchedCharge[];
  matched_charge_energy_kwh_sum: number | null;
  delta_kwh: number | null;
  match_quality: 'exact' | 'plausible' | 'weak' | 'unmatched';
  match_notes: string;
}

export interface LiveMatchingSummary {
  total_evcc_sessions_checked: number;
  total_matched: number;
  total_unmatched: number;
  total_evcc_energy: number;
  total_tm_energy: number;
  total_delta_kwh: number;
  quality_distribution: Record<string, number>;
  total_tm_charges: number;
  accepted_candidates: number;
  rejected_wrong_location: number;
  evcc_reachable: boolean;
  teslamateapi_reachable: boolean;
}

export interface LiveMatchingDryRunResponse {
  ok: boolean;
  matches: LiveEVCCSessionMatch[];
  summary: LiveMatchingSummary;
  timestamp: string;
  error?: string;
  live_mode: boolean;
  evcc_reachable?: boolean;
  teslamateapi_reachable?: boolean;
  config_missing?: boolean;
}

export interface LiveMatchingStatusResponse {
  ok: boolean;
  live_available: boolean;
  reason: string;
  evcc_configured: boolean;
  teslamateapi_configured: boolean;
  evcc_reachable?: boolean;
  teslamateapi_reachable?: boolean;
}