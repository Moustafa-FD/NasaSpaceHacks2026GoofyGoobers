import { createHash } from "node:crypto";

export const CLIMATE_MODELS = ["EC_Earth3P_HR", "MRI_AGCM3_2_S"] as const;
export type ClimateModel = typeof CLIMATE_MODELS[number];
export interface DailyPointQuery { latitude: number; longitude: number; start: string; end: string; models?: ClimateModel[] }
export interface DailyMetric { id: string; sourceVariable: string; units: string; series: Array<{ date: string; value: number | null }>; validDays: number; missingDays: number }
export interface LandClimateResult {
  schemaVersion: "1.0"; sourceId: string; sourceUrl: string; documentationUrl: string; retrievedAt: string;
  evidence: "model-derived" | "climate-scenario"; timeStandard: "UTC";
  requestedPoint: { latitude: number; longitude: number }; sourcePoint: { latitude: number; longitude: number };
  period: { start: string; end: string }; models: Array<{ model: string; metrics: DailyMetric[] }>;
  spatialResolution: string; scenario: string | null; license: Record<string, string>; warnings: string[];
  raw: unknown; rawSha256: string;
}
export function validDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function dayRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(start); at <= Date.parse(end); at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}
export function validateDailyPoint(query: DailyPointQuery, climate = false, now = new Date()): void {
  if (!Number.isFinite(query.latitude) || Math.abs(query.latitude) > 90 || !Number.isFinite(query.longitude) || Math.abs(query.longitude) > 180) throw new Error("A finite WGS84 point is required");
  if (!validDay(query.start) || !validDay(query.end) || query.start > query.end) throw new Error("Ordered real YYYY-MM-DD dates are required");
  const maximum = climate ? "2050-01-01" : new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 10);
  if (query.start < (climate ? "1950-01-01" : "1940-01-01") || query.end > maximum) throw new Error(`Dates must fit source coverage through ${maximum}`);
  if ((Date.parse(query.end) - Date.parse(query.start)) / 86_400_000 > (climate ? 3660 : 731)) throw new Error(climate ? "Climate requests are limited to ten years; split longer acquisitions" : "Land/water requests are limited to two years; split longer acquisitions");
  if (climate && query.models !== undefined && (!Array.isArray(query.models) || !query.models.length || query.models.length > 2 || new Set(query.models).size !== query.models.length || query.models.some(model => !CLIMATE_MODELS.includes(model)))) throw new Error("Choose one or two supported climate models");
}

const VARIABLES: Array<[string, string]> = [["temperature_2m_mean", "°C"], ["temperature_2m_max", "°C"], ["temperature_2m_min", "°C"], ["precipitation_sum", "mm"], ["et0_fao_evapotranspiration", "mm"]];
async function boundedJson(url: URL, signal: AbortSignal, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { signal, redirect: "error", headers: { "Accept": "application/json" } });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    await response.body?.cancel();
    throw new Error(`Environmental source HTTP ${response.status}${retryAfter ? `; Retry-After: ${retryAfter}` : ""}${response.status === 429 ? "; provider quota exceeded, retry later rather than submitting repeated requests" : ""}`);
  }
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Source response exceeds 4 MiB"); }
  if (!response.body) throw new Error("Source returned an empty body");
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > limit) throw new Error("Source response exceeds 4 MiB"); parts.push(next.value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
function object(value: unknown): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Source response must be an object");
  return value as Record<string, any>;
}
export async function fetchLandClimate(query: DailyPointQuery, options: { climate?: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch; now?: Date } = {}): Promise<LandClimateResult> {
  const climate = options.climate ?? false;
  validateDailyPoint(query, climate, options.now);
  const models = climate ? query.models ?? [...CLIMATE_MODELS] : ["era5"];
  const fields = [...VARIABLES.map(([id, units]) => [climate && id === "et0_fao_evapotranspiration" ? `${id}_sum` : id, units]), ...(climate ? [["soil_moisture_0_to_10cm_mean", "m³/m³"]] : [["soil_moisture_0_to_7cm_mean", "m³/m³"], ["soil_moisture_7_to_28cm_mean", "m³/m³"], ["soil_moisture_28_to_100cm_mean", "m³/m³"]])];
  const url = new URL(climate ? "https://climate-api.open-meteo.com/v1/climate" : "https://archive-api.open-meteo.com/v1/archive");
  for (const [key, value] of Object.entries({ latitude: query.latitude, longitude: query.longitude, start_date: query.start, end_date: query.end, daily: fields.map(([id]) => id).join(","), models: models.join(","), timezone: "GMT", temperature_unit: "celsius", precipitation_unit: "mm", cell_selection: "nearest", ...(climate ? { disable_bias_correction: "false" } : {}) })) url.searchParams.set(key, String(value));
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]);
  signal.throwIfAborted();
  const raw = await boundedJson(url, signal, options.fetchImpl ?? fetch);
  const body = object(raw); const daily = object(body.daily); const units = object(body.daily_units);
  if (body.error || body.utc_offset_seconds !== 0 || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90 || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180) throw new Error("Invalid source coordinates/time standard or error response");
  const dates = dayRange(query.start, query.end);
  if (!Array.isArray(daily.time) || JSON.stringify(daily.time) !== JSON.stringify(dates)) throw new Error("Source dates must cover every requested UTC day in order");
  const normalized = models.map(model => ({ model, metrics: fields.map(([variable, expectedUnit]) => {
    const key = climate && models.length > 1 ? `${variable}_${model}` : variable;
    const values: unknown = daily[key];
    if (units[key] !== expectedUnit || !Array.isArray(values) || values.length !== dates.length || values.some(value => value !== null && (typeof value !== "number" || !Number.isFinite(value)))) throw new Error(`Invalid source values or units for ${key}`);
    return { id: variable === "et0_fao_evapotranspiration_sum" ? "et0_fao_evapotranspiration" : variable, sourceVariable: variable, units: expectedUnit,
      series: dates.map((date, index) => ({ date, value: values[index] as number | null })), validDays: values.filter(value => value !== null).length, missingDays: values.filter(value => value === null).length };
  }) }));
  return { schemaVersion: "1.0", sourceId: climate ? "open-meteo-highresmip" : "open-meteo-era5", sourceUrl: url.toString(), documentationUrl: `https://open-meteo.com/en/docs/${climate ? "climate-api" : "historical-weather-api"}`, retrievedAt: new Date().toISOString(), evidence: climate ? "climate-scenario" : "model-derived", timeStandard: "UTC", requestedPoint: { latitude: query.latitude, longitude: query.longitude }, sourcePoint: { latitude: body.latitude, longitude: body.longitude }, period: { start: query.start, end: query.end }, models: normalized,
    spatialResolution: climate ? "Statistically downscaled to approximately 10 km; native models approximately 20-29 km" : "ERA5 approximately 0.25 degrees (25 km)",
    scenario: climate ? "HighResMIP high-forcing simulations, described by the provider as close to RCP8.5; not a selectable SSP ensemble" : null,
    license: { data: "CC BY 4.0", attribution: climate ? "CMIP6 / HighResMIP model producers and Open-Meteo" : "Copernicus Climate Change Service / ECMWF ERA5 and Open-Meteo", access: "Public API is non-commercial only; provider rate limits apply", termsUrl: "https://open-meteo.com/en/terms" },
    warnings: ["Regional grid values do not measure an individual facility's environmental contribution.", "Precipitation minus reference evapotranspiration is a climatic balance, not measured irrigation demand, river supply or water quality.", "Soil moisture is model-derived volumetric water content, not a soil chemistry measurement.", ...(climate ? ["Daily climate-simulation dates are not weather forecasts for particular future days, nor measurements of past weather.", "Two model results provide a sensitivity range, not a probability distribution or confidence interval.", "Bias correction does not establish crop yield, local pollution, water-quality or noise predictive skill.", "This adapter stops at 2050-01-01; no extrapolation beyond the source horizon is performed."] : ["ERA5 has about five days of publication delay; remaining source nulls are preserved."])], raw, rawSha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex") };
}
