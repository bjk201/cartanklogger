// === Core API Types (mapped to Backend models) ===

export interface Session {
  id: number;
  source_type: "home" | "external" | "import";
  source_id: string;
  date: string;
  location?: string;
  energy_kwh?: number;
  cost_eur?: number;
  odometer_km?: number;
  distance_km?: number;
  note?: string;
  solar_percentage?: number;
  pv_kwh?: number;
  cost_per_kwh?: number;
  cost_per_kwh_source?: "api" | "derived";
  charge_type?: "DC" | "AC" | "unknown";
  fast_charger_brand?: string;
  max_charge_power_kw?: number;
  // TM-specific charging details (external sessions)
  charge_energy_added?: number;
  charge_energy_used?: number;
  duration_min?: number;
}

export interface ErrorDetail {
  code: string;
  message: string;
}

export interface MetaInfo {
  count: number;
  limit: number;
}

export interface OverviewResponse {
  ok: boolean;
  data: Session[];
  meta: MetaInfo;
  errors: ErrorDetail[];
}

export interface OverviewSummaryResponse {
  ok: boolean;
  total_sessions: number;
  total_energy_kwh: number;
  total_cost_eur: number;
  avg_cost_per_kwh?: number;
  home_sessions: number;
  external_sessions: number;
  import_sessions: number;
  home_energy_kwh: number;
  external_energy_kwh: number;
  home_cost_eur: number;
  external_cost_eur: number;
  home_share_pct: number;
  pv_share_pct?: number;
  pv_kwh?: number;
  total_charged_kwh?: number;
  total_distance_km?: number;
  avg_distance_per_day_km?: number;
  days_with_data?: number;
  errors: ErrorDetail[];
}

export interface PaginatedSessionsResponse {
  ok: boolean;
  data: Session[];
  meta: MetaInfo;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
    has_next: boolean;
    has_prev: boolean;
  };
  errors: ErrorDetail[];
}

export interface PaginationInfo {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}

// === Statistics Types ===

export interface MonthlyPvPoint {
  month: string;          // 'YYYY-MM'
  label: string;          // 'Jun', 'Jul', …
  pv_pct: number | null;  // gewichteter PV-Anteil %
  energy_kwh: number;
  pv_kwh: number;
}

export interface StatisticsKPIs {
  // Core totals
  total_sessions: number;
  total_energy_kwh: number;
  total_cost_eur: number;
  avg_cost_per_kwh: number;
  avg_cost_per_session?: number | null;
  avg_energy_per_session?: number | null;
  max_cost_session?: number | null;
  max_cost_session_id?: number | null;
  max_energy_session?: number | null;
  max_energy_session_id?: number | null;
  home_sessions: number;
  external_sessions: number;
  import_sessions: number;
  home_energy_kwh?: number | null;
  external_energy_kwh?: number | null;
  home_cost_eur?: number | null;
  external_cost_eur?: number | null;
  home_share_pct?: number | null;
  // DC/AC breakdown
  external_dc_sessions?: number;
  external_ac_sessions?: number;
  external_dc_energy_kwh?: number;
  external_ac_energy_kwh?: number;
  external_dc_cost_eur?: number;
  external_ac_cost_eur?: number;
  // Charging losses
  charging_losses_kwh?: number;
  charging_losses_pct?: number;
  external_charging_losses_kwh?: number;
  external_charging_losses_pct?: number;
  // TM totals over ALL charges (home + external)
  tm_total_energy_added_kwh?: number | null;
  tm_total_energy_used_kwh?: number | null;
  // EVCC/TM matching
  evcc_energy_matched_kwh?: number;
  tm_energy_matched_kwh?: number;
  // PV
  pv_share_pct?: number;
  pv_kwh?: number;
  total_charged_kwh?: number;
  // Monthly PV share (radar chart)
  monthly_pv?: MonthlyPvPoint[];
  // Charging loss costs (Verluste je Quelle × Ø-Arbeitspreis der Quelle)
  charging_loss_costs?: {
    home_loss_kwh: number | null;
    home_price_eur_per_kwh: number | null;
    home_cost_eur: number | null;
    external_loss_kwh: number | null;
    external_price_eur_per_kwh: number | null;
    external_cost_eur: number | null;
    total_cost_eur: number | null;
    grid_share_home: number;   // Netzanteil Zuhause (1 − PV-Anteil)
  };
  // Trip stats
  trip_count?: number;
  trip_total_energy_kwh?: number;
  trip_total_cost_eur?: number;
  trip_avg_distance_km?: number;
  // Daily series
  daily_dates?: string[];
  daily_km?: number[];
  daily_kwh?: number[];
  daily_charged_dates?: string[];
  daily_home_kwh?: number[];
  daily_external_kwh?: number[];
  daily_total_kwh?: number[];
  daily_cost_dates?: string[];
  daily_cost_eur?: number[];
  daily_cost_kwh?: number[];
  daily_odometer?: (number | null)[];
  total_energy_used_kwh?: number;
  total_energy_returned_kwh?: number;
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

// === Matching Types ===

export interface MatchedCharge {
  charge_id: number;
  source_id?: string;
  date: string;
  energy_kwh?: number;
  cost_eur?: number;
  location?: string;
  location_normalized?: string;
  location_original?: string;
  accepted_as_candidate?: boolean;
  reject_reason?: string | null;
  overlap_seconds?: number;
  containment?: string;
  match_source?: string;
  override_id?: number | null;
  override_reason?: string | null;
  replaced_auto_match?: boolean | null;
  skipped_due_to_other_override?: boolean;
  charge_energy_added?: number;
  charge_energy_used?: number;
  is_home_location?: boolean;
  override?: boolean;
  start_date?: string;
  cost_per_kwh?: number;
  cost_per_kwh_source?: string;
  odometer_km?: number;
  soc_start?: number;
  soc_end?: number;
  provider?: string;
  legacy_source?: string;
  legacy_table?: string;
  legacy_id?: string;
}

export interface SessionMatch {
  evcc_session_id: number;
  evcc_source_id?: string;
  evcc_start?: string;
  evcc_end?: string;
  evcc_energy_kwh?: number;
  evcc_cost_eur?: number;
  evcc_cost_per_kwh?: number | null;
  evcc_location?: string;
  matched_charge_count?: number;
  matched_charge_ids?: number[];
  matched_charges?: MatchedCharge[];
  matched_charge_energy_kwh_sum?: number | null;
  match_notes?: string;
  match_quality?: string;
  delta_kwh?: number | null;
  // Alternative shape from /api/sessions/{id}/matches (flat)
  charge_id?: number;
  source_id?: string;
  date?: string;
  energy_kwh?: number;
  cost_eur?: number;
  location?: string;
  accepted_as_candidate?: boolean;
  reject_reason?: string | null;
  overlap_seconds?: number;
  containment?: string;
  match_source?: string;
}

export interface SessionMatchesResponse {
  ok: boolean;
  session_id?: number;
  note?: string | null;
  matches?: SessionMatch[];
}

export interface SessionMatchActionResponse {
  ok: boolean;
  session_id?: number;
  charge_id?: number;
  action?: string;
  message?: string;
}

export interface UnmatchedChargeItem {
  charge_id: number;
  date: string;
  location?: string;
  energy_added?: number;
  energy_used?: number;
  cost?: number;
  odometer?: number;
}

export interface UnmatchedChargesResponse {
  ok: boolean;
  total_tm_charges?: number;
  home_charges?: number;
  unmatched_count?: number;
  charges?: UnmatchedChargeItem[];
}

export interface MatchingSummary {
  total_evcc_sessions_checked?: number;
  total_matched?: number;
  total_unmatched?: number;
  total_evcc_energy?: number;
  total_tm_energy?: number;
  total_delta_kwh?: number;
  quality_distribution?: {
    exact?: number;
    plausible?: number;
    weak?: number;
    unmatched?: number;
  };
  total_tm_charges?: number;
  accepted_candidates?: number;
  rejected_wrong_location?: number;
}

export interface MatchingDryRunResponse {
  ok: boolean;
  matches?: SessionMatch[];
  summary?: MatchingSummary;
  errors?: { code: string; message: string }[];
}

export interface LiveMatchingDryRunResponse {
  ok: boolean;
  matches?: SessionMatch[];
  summary?: MatchingSummary;
  errors?: { code: string; message: string }[];
  config_missing?: boolean;
  live_mode?: boolean;
  evcc_reachable?: boolean;
  teslamateapi_reachable?: boolean;
}

export interface MatchingRawDataResponse {
  ok: boolean;
  data?: any[];
  external_tm_charges?: number;
  teslamate_charges?: any[];
  home_tm_charges?: number;
  evcc_sessions?: any[];
  active_overrides_count?: number;
  total_evcc?: number;
  total_tm?: number;
  timestamp?: string;
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
    source?: string;
  };
  errors?: { code: string; message: string }[];
}

export interface VehicleRecordRead {
  id: number;
  vin?: string;
  make?: string;
  model?: string;
  year?: number;
  battery_capacity_kwh?: number;
  efficiency_wh_per_km?: number;
  co2_factor?: number;
  created_at?: string;
  updated_at?: string;
  // Extended properties for VehiclePage
  tire_position?: string;
  tire_brand?: string;
  tire_season?: string;
  is_active?: boolean;          // Satz aktuell montiert?
  is_archived?: boolean;        // Satz archiviert (separater Endzustand)
  start_odometer_km?: number;
  odometer_km?: number;
  cost_eur?: number;
  date?: string;
  title?: string;
  shop?: string;
  note?: string;
  record_type?: 'service' | 'tire';
  mounts?: TireMountRead[];     // Montage-Historie (nur Reifensätze)
}

export interface TireMountRead {
  id: number;
  tire_record_id: number;
  mounted_at: string;
  demounted_at?: string | null;  // NULL = aktuell montiert
  km_on?: number | null;
  km_off?: number | null;
  note?: string | null;
}

export interface VehicleRecordCreate {
  vin?: string;
  make?: string;
  model?: string;
  year?: number;
  battery_capacity_kwh?: number;
  efficiency_wh_per_km?: number;
  co2_factor?: number;
  record_type?: 'service' | 'tire';
  date?: string;
  title?: string;
  shop?: string;
  note?: string;
  tire_brand?: string;
  tire_position?: string;
  tire_season?: string;
  odometer_km?: number;
  cost_eur?: number;
}

export interface VehicleRecordUpdate {
  vin?: string;
  make?: string;
  model?: string;
  year?: number;
  battery_capacity_kwh?: number;
  efficiency_wh_per_km?: number;
  co2_factor?: number;
  date?: string;
  title?: string;
  shop?: string;
  note?: string;
  odometer_km?: number;
  cost_eur?: number;
}

export interface VehicleRecordsResponse {
  ok: boolean;
  records?: VehicleRecordRead[];
  services?: VehicleRecordRead[];
  tires?: VehicleRecordRead[];
  meta?: {
    count: number;
    limit: number;
  };
  errors?: { code: string; message: string }[];
}

export interface VehicleSingleResponse {
  ok: boolean;
  record?: VehicleRecordRead;
  errors?: { code: string; message: string }[];
}

export interface ExtraCostRead {
  id: number;
  session_id?: number;
  date?: string;
  provider?: string;
  amount?: number;
  currency?: string;
  description?: string;
  category?: string;
  title?: string;
  cost_eur?: number;
  note?: string;
  linked_tire_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ExtraCostCreate {
  session_id?: number;
  date?: string;
  provider?: string;
  amount?: number;
  currency?: string;
  description?: string;
  category?: string;
  title?: string;
  cost_eur?: number;
  note?: string;
  linked_tire_id?: number;
}

export interface ExtraCostUpdate {
  session_id?: number;
  date?: string;
  provider?: string;
  amount?: number;
  currency?: string;
  description?: string;
  category?: string;
}

export interface ExtraCostListResponse {
  ok: boolean;
  costs?: ExtraCostRead[];
  meta?: {
    count: number;
    limit: number;
  };
  errors?: { code: string; message: string }[];
}

export interface ExtraCostSingleResponse {
  ok: boolean;
  cost?: ExtraCostRead;
  errors?: { code: string; message: string }[];
}

export interface MatchingOverrideCreate {
  teslamate_charge_id: number;
  evcc_session_id: number;
  override_type: "manual_assign" | "manual_skip" | "manual_score_adjust";
  reason?: string;
  override_reason?: string;
  score_adjust?: number;
}

export interface MatchingOverrideRead {
  id: number;
  teslamate_charge_id: number;
  evcc_session_id: string;
  override_type: string;
  override_reason?: string;
  score_adjust?: number;
  created_at: string;
  updated_at: string;
}

export interface MatchingOverrideListResponse {
  ok: boolean;
  overrides?: MatchingOverrideRead[];
  meta?: {
    count: number;
    limit: number;
  };
  errors?: { code: string; message: string }[];
}

export interface MatchingOverrideSingleResponse {
  ok: boolean;
  override?: MatchingOverrideRead;
  errors?: { code: string; message: string }[];
}

export interface MatchingOverrideUpdate {
  override_type?: string;
  override_reason?: string;
  score_adjust?: number;
}

export interface DataSourceConfigRead {
  evcc_base_url?: string;
  evcc_api_token?: string;
  teslamateapi_base_url?: string;
  teslamateapi_token?: string;
  evcc_configured?: boolean;
  teslamateapi_configured?: boolean;
  data_source?: string;
}

export interface DataSourceConfigWrite {
  evcc_base_url?: string;
  evcc_api_token?: string;
  teslamateapi_base_url?: string;
  teslamateapi_token?: string;
}

export interface DataSourceConfigTestRequest {
  source: string;
  evcc_base_url?: string;
  evcc_api_token?: string;
  teslamateapi_base_url?: string;
  teslamateapi_token?: string;
}

export interface DataSourceConfigTestResponse {
  ok: boolean;
  source: string;
  status?: {
    configured?: boolean;
    reachable?: boolean;
    level?: string;
    status_code?: number;
    error?: string;
    data_error?: string;
    last_checked?: string;
  };
  errors?: { code: string; message: string }[];
}

export interface HealthResponse {
  ok: boolean;
  service?: string;
  version?: string;
  database?: string;
  data_source?: string;
  data_source_description?: string;
  evcc_configured?: boolean;
  teslamateapi_configured?: boolean;
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
  evcc?: {
    reachable?: boolean;
    error?: string;
    timestamp?: string;
    configured?: boolean;
    level?: "healthy" | "degraded" | "down";
    status_code?: number;
    source?: string;
    data_error?: string;
    last_checked?: string;
  };
  teslamateapi?: {
    reachable?: boolean;
    error?: string;
    timestamp?: string;
    configured?: boolean;
    level?: "healthy" | "degraded" | "down";
    status_code?: number;
    source?: string;
    data_error?: string;
    last_checked?: string;
  };
  errors?: { code: string; message: string }[];
  data_source?: string;
  timestamp?: string;
}

export interface LiveMatchingStatusResponse {
  ok: boolean;
  live_available?: boolean;
  reason?: string;
  evcc_configured?: boolean;
  teslamateapi_configured?: boolean;
  evcc_reachable?: boolean;
  teslamateapi_reachable?: boolean;
  matches?: SessionMatch[];
  summary?: MatchingSummary;
  errors?: { code: string; message: string }[];
  config_missing?: boolean;
  live_mode?: boolean;
}

export interface ExtraCostCategory {
  id?: number;
  name: string;
  description?: string;
}