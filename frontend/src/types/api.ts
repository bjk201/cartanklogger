// Session interface update - ensure source_type is properly typed
export interface Session {
  id: string;
  session_id: string;
  car_id: number;
  car_name: string;
  car_vin?: string;
  source_type: "home" | "external" | "import";
  start_time: string;
  end_time?: string;
  energy_charged_kwh?: number;
  cost_eur?: number;
  energy_used_kwh?: number;
  energy_returned_kwh?: number;
  location?: string;
  provider?: string;
  note?: string;
  external_session_id?: string;
  created_at: string;
  updated_at: string;
  // New fields for frontend enhanced display (from backend model)
  date?: string;
  energy_kwh?: number;
  solar_percentage?: number;
  pv_kwh?: number;
  odometer_km?: number;
  cost_per_kwh?: number;
}

export interface StatisticsKPIs {
  total_sessions: number;
  total_energy_charged_kwh: number;
  total_cost_eur: number;
  total_energy_used_kwh: number;
  total_energy_returned_kwh: number;
}

export interface SourceBreakdown {
  home?: number;
  external?: number;
  import_?: number;
  total?: number;
}

export interface StatisticsResponse {
  ok: boolean;
  kpis?: StatisticsKPIs;
  energy_by_source?: SourceBreakdown;
  cost_by_source?: SourceBreakdown;
  sessions_by_source?: SourceBreakdown;
  range_label?: string;
  evcc?: StatisticsKPIs;
  teslamate?: StatisticsKPIs;
  source_breakdown?: SourceBreakdown;
  errors?: { code: string; message: string }[];
}

export interface OverviewResponse {
  ok: boolean;
  recent_sessions: Session[];
  total_sessions: number;
  total_energy_charged_kwh: number;
  total_cost_eur: number;
  start_date: string;
  end_date: string;
  errors?: { code: string; message: string }[];
}


export interface OverviewSummaryResponse {
  ok: boolean;
  summary: OverviewResponse;
  errors?: { code: string; message: string }[];
  total_sessions?: number;
  total_energy_kwh?: number;
  total_cost_eur?: number;
  total_energy_used_kwh?: number;
  avg_cost_per_kwh?: number;
  total_distance_km?: number;
  avg_distance_per_day_km?: number;
  home_energy_kwh?: number;
  home_share_pct?: number;
  external_energy_kwh?: number;
  days_with_data?: number;
}

export interface DataSourceStatusSource {
  status: "connected" | "disconnected" | "error";
  last_sync?: string;
  last_error?: string;
  config?: {
    api_url?: string;
    token?: string;
    username?: string;
  };
  configured?: boolean;
  reachable?: boolean;
}

export interface HealthResponse {
  ok: boolean;
}

export interface PaginatedSessionsResponse {
  ok: boolean;
  sessions: Session[];
  total: number;
  page: number;
  page_size: number;
  errors?: { code: string; message: string }[];
}

export interface PaginationInfo {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface DataSourceStatusResponse {
  ok: boolean;
  sources: Record<string, DataSourceStatusSource>;
  evcc?: {
    configured: boolean;
    reachable: boolean;
    level?: string;
    status_code?: number;
    error?: string;
    data_error?: string;
  };
  teslamateapi?: {
    configured: boolean;
    reachable: boolean;
    level?: string;
    status_code?: number;
    error?: string;
    data_error?: string;
  };
  data_source?: string;
  message?: string;
  timestamp?: string;
  errors?: { code: string; message: string }[];
}

export interface ReachabilityStatus {
  configured: boolean;
  reachable: boolean;
  level?: string;
  status_code?: number;
  error?: string;
  data_error?: string;
  last_checked?: string;
}

export interface DataSourceConfigRead {
  evcc_base_url: string;
  evcc_api_token: string;
  teslamateapi_base_url: string;
  teslamateapi_token: string;
  evcc_configured: boolean;
  teslamateapi_configured: boolean;
  data_source: string;
}

export interface DataSourceConfigWrite {
  evcc_base_url: string;
  evcc_api_token?: string | null;
  teslamateapi_base_url: string;
  teslamateapi_token?: string | null;
}

export interface DataSourceConfigTestRequest {
  source: string;  // "evcc" | "teslamateapi"
  evcc_base_url?: string;
  evcc_api_token?: string;
  teslamateapi_base_url?: string;
  teslamateapi_token?: string;
}

export interface DataSourceConfigTestResponse {
  ok: boolean;
  source: string;
  status: ReachabilityStatus;
}

export interface MatchingDryRunResponse {
  ok: boolean;
  matches: any[];
  errors?: { code: string; message: string }[];
}

export interface MatchingOverrideCreate {
  teslamate_charge_id: number;
  evcc_session_id: string;
  override_type: "manual_assign" | "manual_skip" | "manual_score_adjust";
  reason: string;
}

export interface MatchingOverrideRead {
  id: number;
  teslamate_charge_id: number;
  evcc_session_id: string;
  override_type: "manual_assign" | "manual_skip" | "manual_score_adjust";
  reason: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface MatchingOverrideListResponse {
  ok: boolean;
  overrides: MatchingOverrideRead[];
  errors?: { code: string; message: string }[];
}

export interface MatchingOverrideSingleResponse {
  ok: boolean;
  data?: MatchingOverrideRead;
  errors?: { code: string; message: string }[];
}

export interface MatchingRawDataResponse {
  ok: boolean;
  evcc_sessions?: any[];
  teslamate_charges?: any[];
  errors?: { code: string; message: string }[];
}

export interface LiveMatchingDryRunResponse {
  ok: boolean;
  matches?: any[];
  errors?: { code: string; message: string }[];
}

export interface LiveMatchingStatusResponse {
  ok: boolean;
  sources?: Record<string, {
    status: "connected" | "disconnected" | "error";
    last_sync?: string;
    last_error?: string;
    config?: {
      api_url?: string;
      token?: string;
      username?: string;
    };
  }>;
  errors?: { code: string; message: string }[];
}

export interface VehicleInfoResponse {
  ok: boolean;
  data?: {
    car_id?: number;
    name?: string;
    vin?: string;
    model?: string;
    current_odometer_km?: number;
    source?: "teslamate" | "none";
  };
  errors?: { code: string; message: string }[];
}

export interface VehicleRecordRead {
  id: number;
  record_type: "service" | "tire";
  date: string;
  title: string;
  odometer_km?: number;
  cost_eur?: number;
  note?: string;
  shop?: string;
  tire_position?: string;
  tire_brand?: string;
  tire_season?: string;
}

export interface VehicleRecordsResponse {
  ok: boolean;
  services: VehicleRecordRead[];
  tires: VehicleRecordRead[];
  errors?: { code: string; message: string }[];
}

export interface VehicleSingleResponse {
  ok: boolean;
  data?: VehicleRecordRead;
  errors?: { code: string; message: string }[];
}

export interface VehicleRecordCreate {
  record_type: "service" | "tire";
  date: string;
  title: string;
  odometer_km?: number;
  cost_eur?: number;
  note?: string;
  shop?: string;
  tire_position?: string;
  tire_brand?: string;
  tire_season?: string;
}

export interface VehicleRecordUpdate {
  date?: string;
  title?: string;
  odometer_km?: number;
  cost_eur?: number;
  note?: string;
  shop?: string;
  tire_position?: string;
  tire_brand?: string;
  tire_season?: string;
}
