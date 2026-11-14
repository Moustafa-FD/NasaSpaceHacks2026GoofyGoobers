export const ENVIRONMENT_VARIABLES = ["T2M", "PRECTOTCORR", "RH2M", "WS2M"] as const;
export type EnvironmentVariable = typeof ENVIRONMENT_VARIABLES[number];
export type BoundingBox = [number, number, number, number];

export interface MeteorologyRequest {
  schemaVersion: "1.0";
  kind: "sync" | "series" | "grid";
  source?: "power-grid" | "power-point";
  variables?: EnvironmentVariable[];
  start?: string;
  end?: string;
  date?: string;
  point?: { latitude: number; longitude: number };
  bbox?: BoundingBox;
  maxCacheMiB?: number;
  refreshCatalog?: boolean;
}

export interface FacilitiesRequest { schemaVersion: "1.0"; kind: "facilities-sync"; bbox?: BoundingBox }
export type EmissionsRequest = { schemaVersion: "1.0"; kind: "emissions-sync"; source: "npri"; startYear?: number; endYear?: number; maxReports?: number } | { schemaVersion: "1.0"; kind: "emissions-sync"; source: "epa-nei"; year?: number; state?: string };
export interface AirQualityRequest { schemaVersion: "1.0"; kind: "air-quality"; point: { latitude: number; longitude: number }; start?: string; end?: string; variables?: Array<"pm2_5" | "pm10" | "nitrogen_dioxide" | "ozone" | "sulphur_dioxide"> }
export interface LandWaterRequest { schemaVersion: "1.0"; kind: "land-water"; point: { latitude: number; longitude: number }; start: string; end: string }
export interface ClimateRequest { schemaVersion: "1.0"; kind: "climate"; point: { latitude: number; longitude: number }; start: string; end: string; models?: Array<"EC_Earth3P_HR" | "MRI_AGCM3_2_S"> }
export interface AgricultureRequest { schemaVersion: "1.0"; kind: "agriculture"; point: { latitude: number; longitude: number }; baseline: { start: string; end: string }; future: { start: string; end: string }; models?: ClimateRequest["models"]; growingMonths: number[]; baseTemperatureC: number; heatThresholdC: number; dryDayThresholdMm: number }
export interface GroundEvidenceRequest { schemaVersion: "1.0"; kind: "ground-evidence"; records: unknown[] }
export interface WaterQualityRequest { schemaVersion: "1.0"; kind: "water-quality"; stationId: string; start: string; end: string; parameters?: Array<"00010" | "00095" | "00400" | "00300" | "63680"> }
export type EnvironmentRequest = MeteorologyRequest | FacilitiesRequest | EmissionsRequest | AirQualityRequest | LandWaterRequest | ClimateRequest | AgricultureRequest | GroundEvidenceRequest | WaterQualityRequest;

export interface EnvironmentRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
  request: EnvironmentRequest;
  details?: Record<string, unknown>;
  error?: { code: string; message: string };
  resultUrl?: string;
}

export const ENVIRONMENT_DOMAINS = [
  { id: "data-center-locations", status: "live_adapter", description: "Global OpenStreetMap source snapshot, prioritizing Canada and USA queries; incomplete volunteered coverage" },
  { id: "facility-emissions", status: "live_adapter", description: "Canadian NPRI sector-candidate reports; reported methods retained, not automatically attributed to every mapped data center" },
  { id: "meteorology", status: "live_adapter", description: "NASA POWER temperature, precipitation rate, humidity and wind; availability depends on acquired coverage" },
  { id: "air-pollution", status: "live_model_adapter", description: "Global CAMS PM2.5/PM10/NO2/O3/SO2 history via Open-Meteo; modeled concentrations, not facility emissions or ground monitors. OMI remains metadata only." },
  { id: "vegetation", status: "catalogued_auth_required", description: "MODIS NDVI metadata; AppEEARS extraction requires Earthdata Login" },
  { id: "land-surface-temperature", status: "catalogued_auth_required", description: "MODIS LST metadata; distinct from air temperature" },
  { id: "land-water", status: "live_model_adapter", description: "ERA5 daily rainfall, reference ET0 and soil moisture by depth; no inference of facility consumption or water chemistry" },
  { id: "water-quality", status: "live_ground_adapter", description: "USGS station temperature, conductance, pH, oxygen and turbidity where available; broader chemistry and facility-attribution models remain unsupported" },
  { id: "noise", status: "ground_import_only", description: "Imports source-referenced acoustic records; no ground noise dataset acquired or propagation/impact model implemented" },
  { id: "trend-analysis", status: "planned_worker", description: "Part 2: slope, seasonal treatment, significance and uncertainty" },
  { id: "future-environment", status: "live_climate_scenario_adapter", description: "Two HighResMIP climate simulations through 2050-01-01; local facility-impact models and projections to 2100 remain unavailable" },
  { id: "agriculture", status: "climate_exposure_screening", description: "Growing-season heat/frost/dry-day/GDD and climatic-balance comparisons; no crop yield forecast or facility attribution" }
] as const;

export function validateEnvironmentRequest(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return ["Body must be an object"];
  const value = input as Record<string, unknown>;
  if (typeof value.kind !== "string") return ["kind must be a string"];
  if (["facilities-sync", "emissions-sync", "air-quality", "land-water", "climate", "agriculture", "ground-evidence", "water-quality"].includes(value.kind)) return validateExpandedRequest(value);
  const errors: string[] = [];
  const allowed = new Set(["schemaVersion", "kind", "source", "variables", "start", "end", "date", "point", "bbox", "maxCacheMiB", "refreshCatalog"]);
  if (Object.keys(value).some(key => !allowed.has(key))) errors.push("Unknown request field");
  if (value.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (!["sync", "series", "grid"].includes(String(value.kind))) errors.push("kind must be sync, series or grid");
  if (value.variables !== undefined && (!Array.isArray(value.variables) || value.variables.length < 1 || value.variables.length > 4 || new Set(value.variables).size !== value.variables.length || value.variables.some(item => !ENVIRONMENT_VARIABLES.includes(item as EnvironmentVariable)))) errors.push("variables must contain 1-4 unique supported meteorological IDs");
  if (value.maxCacheMiB !== undefined && (!Number.isInteger(value.maxCacheMiB) || Number(value.maxCacheMiB) < 64 || Number(value.maxCacheMiB) > 1024)) errors.push("maxCacheMiB must be an integer from 64 to 1024");
  if (value.refreshCatalog !== undefined && typeof value.refreshCatalog !== "boolean") errors.push("refreshCatalog must be boolean");
  const month = (item: unknown) => typeof item === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(item);
  const currentMonth = new Date().toISOString().slice(0, 7);
  for (const key of ["start", "end", "date"] as const) if (value[key] !== undefined && (!month(value[key]) || String(value[key]) < "1981-01" || String(value[key]) > currentMonth)) errors.push(`${key} must be a historical YYYY-MM from 1981-01 through ${currentMonth}`);
  if (value.point !== undefined) {
    const point = value.point as Record<string, unknown>;
    if (point === null || typeof point !== "object" || Array.isArray(point) || Object.keys(point).some(key => !["latitude", "longitude"].includes(key)) || typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 || typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) errors.push("point requires finite latitude [-90,90] and longitude [-180,180]");
  }
  if (value.bbox !== undefined) {
    const box = value.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(item => typeof item === "number" && Number.isFinite(item)) || box[0] < -180 || box[2] > 180 || box[1] < -90 || box[3] > 90 || box[0] >= box[2] || box[1] >= box[3]) errors.push("bbox must be [west,south,east,north], ordered within WGS84 bounds; dateline crossing is not supported");
  }
  if (value.kind === "sync") {
    if (["source", "start", "end", "date", "point", "bbox"].some(key => value[key] !== undefined)) errors.push("sync accepts only variables, maxCacheMiB and refreshCatalog");
  } else if (value.kind === "series") {
    if (typeof value.source !== "string" || !["power-grid", "power-point"].includes(value.source)) errors.push("series source must be power-grid or power-point");
    if (!month(value.start) || !month(value.end) || String(value.start) > String(value.end)) errors.push("series requires ordered start/end YYYY-MM");
    if (value.date !== undefined || value.refreshCatalog !== undefined || value.maxCacheMiB !== undefined) errors.push("series does not accept sync/grid-only fields");
    if (value.point !== undefined && value.bbox !== undefined) errors.push("Choose point or bbox, not both");
    if (value.source === "power-point" && (value.point === undefined || value.bbox !== undefined)) errors.push("power-point requires point and does not accept bbox");
    if (value.source === "power-grid" && value.point === undefined && value.bbox === undefined) errors.push("power-grid requires point or bbox (use [-180,-90,180,90] for a global area mean)");
  } else if (value.kind === "grid") {
    if (value.source !== "power-grid" || !month(value.date) || !Array.isArray(value.variables) || value.variables.length !== 1) errors.push("grid requires source power-grid, one variable and date YYYY-MM");
    if (["point", "bbox", "start", "end", "refreshCatalog", "maxCacheMiB"].some(key => value[key] !== undefined)) errors.push("grid returns a complete native global frame and does not accept spatial/sync/series fields");
  }
  return errors;
}

function validateExpandedRequest(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const fields: Record<string, string[]> = {
    "facilities-sync": ["bbox"], "emissions-sync": value.source === "epa-nei" ? ["source", "year", "state"] : ["source", "startYear", "endYear", "maxReports"],
    "air-quality": ["point", "start", "end", "variables"], "land-water": ["point", "start", "end"],
    "climate": ["point", "start", "end", "models"], "agriculture": ["point", "baseline", "future", "models", "growingMonths", "baseTemperatureC", "heatThresholdC", "dryDayThresholdMm"], "ground-evidence": ["records"], "water-quality": ["stationId", "start", "end", "parameters"]
  };
  if (value.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (Object.keys(value).some(key => !["schemaVersion", "kind", ...fields[String(value.kind)]].includes(key))) errors.push("Unknown request field");
  const point = value.point as Record<string, unknown> | undefined;
  if (["air-quality", "land-water", "climate", "agriculture"].includes(String(value.kind)) && (!point || typeof point !== "object" || Array.isArray(point) || Object.keys(point).some(key => !["latitude", "longitude"].includes(key)) || typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 || typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180)) errors.push("A finite WGS84 point is required");
  const day = (item: unknown): item is string => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item) && Number.isFinite(Date.parse(item)) && new Date(item).toISOString().slice(0, 10) === item;
  const range = (start: unknown, end: unknown, lower: string, upper: string, maxDays: number) => day(start) && day(end) && start <= end && start >= lower && end <= upper && (Date.parse(end) - Date.parse(start)) / 86_400_000 <= maxDays;
  const today = new Date();
  if (value.kind === "facilities-sync" && value.bbox !== undefined) {
    const box = value.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(item => typeof item === "number" && Number.isFinite(item)) || box[0] < -180 || box[2] > 180 || box[1] < -90 || box[3] > 90 || box[0] >= box[2] || box[1] >= box[3]) errors.push("bbox requires ordered WGS84 bounds");
  }
  if (value.kind === "emissions-sync") {
    if (typeof value.source !== "string" || !["npri", "epa-nei"].includes(value.source)) errors.push("emissions-sync source must be npri or epa-nei");
    if (value.source === "epa-nei") {
      if (value.year !== undefined && (typeof value.year !== "number" || ![2008, 2011, 2014, 2017, 2020, 2023].includes(value.year))) errors.push("EPA NEI supports inventory years 2008,2011,2014,2017,2020,2023");
      if (value.state !== undefined && (typeof value.state !== "string" || !"AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(" ").includes(value.state.toUpperCase()))) errors.push("state must be a supported US postal code");
    }
    for (const key of ["startYear", "endYear"]) if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 1993 || Number(value[key]) > today.getUTCFullYear())) errors.push(`${key} must be a historical NPRI year`);
    if (value.startYear !== undefined && value.endYear !== undefined && Number(value.startYear) > Number(value.endYear)) errors.push("Order startYear before endYear");
    if (value.maxReports !== undefined && (!Number.isInteger(value.maxReports) || Number(value.maxReports) < 1 || Number(value.maxReports) > 100)) errors.push("maxReports must be 1-100");
  }
  if (value.kind === "air-quality") {
    if ((value.start !== undefined || value.end !== undefined) && !range(value.start, value.end, "2022-08-01", new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10), 30)) errors.push("Air quality requires paired dates, up to 31 historical days from 2022-08-01 through yesterday");
    const variables = ["pm2_5", "pm10", "nitrogen_dioxide", "ozone", "sulphur_dioxide"];
    if (value.variables !== undefined && (!Array.isArray(value.variables) || !value.variables.length || value.variables.length > 5 || new Set(value.variables).size !== value.variables.length || value.variables.some(id => typeof id !== "string" || !variables.includes(id)))) errors.push("Unsupported or duplicate air-quality variables");
  }
  if (value.kind === "land-water" && !range(value.start, value.end, "1940-01-01", new Date(today.getTime() - 5 * 86_400_000).toISOString().slice(0, 10), 731)) errors.push("Land/water requires ordered historical dates from 1940, ending at least five days ago, at most two years per request");
  if (["climate", "agriculture"].includes(String(value.kind))) {
    if (value.models !== undefined && (!Array.isArray(value.models) || !value.models.length || value.models.length > 2 || new Set(value.models).size !== value.models.length || value.models.some(id => typeof id !== "string" || !["EC_Earth3P_HR", "MRI_AGCM3_2_S"].includes(id)))) errors.push("Choose one or two supported climate models");
    if (value.kind === "climate" && !range(value.start, value.end, "1950-01-01", "2050-01-01", 3660)) errors.push("Climate dates must fit 1950-01-01..2050-01-01, at most ten years per request");
    if (value.kind === "agriculture") {
      const periods: Record<string, any> = {};
      for (const key of ["baseline", "future"]) {
        const period = value[key] as Record<string, unknown>;
        if (!period || typeof period !== "object" || Array.isArray(period) || Object.keys(period).some(name => !["start", "end"].includes(name)) || !range(period.start, period.end, "1950-01-01", "2049-12-31", 3660) || !String(period.start).endsWith("-01-01") || !String(period.end).endsWith("-12-31")) errors.push(`${key} requires complete calendar years within 1950-2049, at most ten years`);
        else periods[key] = period;
      }
      if (periods.baseline && periods.future && (periods.baseline.end >= periods.future.start || periods.future.start <= today.toISOString().slice(0, 10))) errors.push("future must follow baseline and start after today");
      const months = value.growingMonths;
      if (!Array.isArray(months) || !months.length || months.length > 12 || new Set(months).size !== months.length || months.some(month => !Number.isInteger(month) || month < 1 || month > 12)) errors.push("growingMonths requires unique calendar months 1-12");
      if (typeof value.baseTemperatureC !== "number" || !Number.isFinite(value.baseTemperatureC) || value.baseTemperatureC < -10 || value.baseTemperatureC > 40 || typeof value.heatThresholdC !== "number" || !Number.isFinite(value.heatThresholdC) || value.heatThresholdC <= value.baseTemperatureC || value.heatThresholdC > 60 || typeof value.dryDayThresholdMm !== "number" || !Number.isFinite(value.dryDayThresholdMm) || value.dryDayThresholdMm < 0 || value.dryDayThresholdMm > 20) errors.push("Explicit finite agricultural screening thresholds are required");
    }
  }
  if (value.kind === "ground-evidence" && (!Array.isArray(value.records) || !value.records.length || value.records.length > 100)) errors.push("ground-evidence requires 1-100 records; records receive additional evidence validation");
  if (value.kind === "water-quality") {
    if (typeof value.stationId !== "string" || !/^USGS-\d{8,15}$/.test(value.stationId)) errors.push("stationId must be USGS- followed by 8-15 digits");
    if (!range(value.start, value.end, "1900-01-01", today.toISOString().slice(0, 10), 30)) errors.push("Water quality requires ordered historical dates, at most 31 inclusive days");
    if (value.parameters !== undefined && (!Array.isArray(value.parameters) || !value.parameters.length || value.parameters.length > 5 || new Set(value.parameters).size !== value.parameters.length || value.parameters.some(id => typeof id !== "string" || !["00010", "00095", "00400", "00300", "63680"].includes(id)))) errors.push("Unsupported or duplicate USGS water-quality parameters");
  }
  return errors;
}
