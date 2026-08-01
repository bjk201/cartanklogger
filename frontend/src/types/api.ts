export interface Session {
  id: string;
  date: string;
  source_type: 'home' | 'external' | 'import';
  location: string | null;
  energy_kwh: number | null;
  cost_eur: number | null;
  odometer_km: number | null;
  distance_km: number | null;
  note: string | null;
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