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