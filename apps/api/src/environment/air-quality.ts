/** Public non-commercial Open-Meteo access to CAMS global model estimates. */
export const AIR_QUALITY_VARIABLES = ["pm2_5", "pm10", "nitrogen_dioxide", "ozone", "sulphur_dioxide"] as const;
export type AirQualityVariable = typeof AIR_QUALITY_VARIABLES[number];

export interface AirQualityQuery {
  latitude: number;
  longitude: number;
  /** Inclusive UTC calendar dates; omit both for the last seven completed days. */
  start?: string;
  end?: string;
  variables?: string[];
}

export interface AirQualityResult {
  sourceId: "open-meteo-cams";
  sourceUrl: string;
  documentationUrl: string;
  retrievedAt: string;
  evidence: "model-derived";
  timeStandard: "UTC";
  period: { start: string; end: string; inclusive: true; interval: "hourly"; requestedHours: number };
  location: { latitude: number; longitude: number; sourcePoint: { latitude: number; longitude: number } };
  model: {
    id: "cams_global";
    name: string;
    nativeSpatialResolution: { latitudeDegrees: number; longitudeDegrees: number; approximateKilometres: number };
    documentedSourceCadence: string;
    outputCadence: "hourly";
    documentedArchiveStart: "2022-08";
    version: "not_returned";
  };
  license: {
    data: "CC BY 4.0";
    dataUrl: string;
    service: "free-non-commercial";
    termsUrl: string;
    attribution: Array<{ name: string; url: string }>;
    rateLimits: { perMinute: number; perHour: number; perDay: number };
  };
  variables: Array<{
    id: AirQualityVariable;
    label: string;
    unit: string;
    validSampleCount: number;
    missingSampleCount: number;
    firstValidDate: string | null;
    lastValidDate: string | null;
    series: Array<{ date: string; value: number | null; quality: "valid" | "missing" }>;
  }>;
  raw: Record<string, unknown>;
  warnings: string[];
}

export interface AirQualityOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Clock injection for deterministic date validation, not a forecast horizon. */
  now?: Date;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const DOCUMENTATION = "https://open-meteo.com/en/docs/air-quality-api";
const LABELS: Record<AirQualityVariable, string> = {
  pm2_5: "Particulate matter PM2.5",
  pm10: "Particulate matter PM10",
  nitrogen_dioxide: "Nitrogen dioxide NO2",
  ozone: "Ozone O3",
  sulphur_dioxide: "Sulphur dioxide SO2"
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function calendarDay(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Air-quality dates must use YYYY-MM-DD");
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error("Air-quality date is not a valid calendar day");
  return timestamp;
}

function coordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** Keep a bounded point request from accepting an unexpectedly large response. */
async function boundedJson(response: Response): Promise<unknown> {
  const maximum = 2 * 1024 * 1024;
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maximum) throw new Error("Air-quality response exceeds 2 MiB");
  if (!response.body) throw new Error("Air-quality response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("Air-quality response exceeds 2 MiB");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(text); }
  catch { throw new Error("Air-quality response is not valid JSON"); }
}

/**
 * Historical hourly point estimates only: 1-31 complete UTC days, globally.
 * Open-Meteo documents its CAMS global archive from August 2022; numeric
 * availability varies by date/cell. This is not a sensor or emissions feed.
 * Documentation: https://open-meteo.com/en/docs/air-quality-api
 * Free-service terms: https://open-meteo.com/en/terms
 */
export async function fetchAirQuality(query: AirQualityQuery, options: AirQualityOptions = {}): Promise<AirQualityResult> {
  options.signal?.throwIfAborted();
  if (!query || !coordinate(query.latitude, 90) || !coordinate(query.longitude, 180)) throw new Error("Air-quality coordinates must be finite latitude/longitude within WGS84 bounds");
  const requested = query.variables ?? [...AIR_QUALITY_VARIABLES];
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > AIR_QUALITY_VARIABLES.length || new Set(requested).size !== requested.length || requested.some(id => !AIR_QUALITY_VARIABLES.includes(id as AirQualityVariable))) {
    throw new Error(`Air quality requires 1-5 unique variables from ${AIR_QUALITY_VARIABLES.join(", ")}`);
  }
  const variables = [...requested] as AirQualityVariable[];
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Air-quality validation clock is invalid");
  const today = calendarDay(now.toISOString().slice(0, 10));
  if ((query.start === undefined) !== (query.end === undefined)) throw new Error("Air-quality start and end must be supplied together");
  const end = query.end === undefined ? today - DAY : calendarDay(query.end);
  const start = query.start === undefined ? end - 6 * DAY : calendarDay(query.start);
  const days = (end - start) / DAY + 1;
  if (start < calendarDay("2022-08-01") || end < start || end >= today || days > 31) throw new Error("Air-quality period must contain 1-31 ordered complete UTC days from 2022-08-01 through yesterday; forecasts are not requested");
  const startDate = new Date(start).toISOString().slice(0, 10);
  const endDate = new Date(end).toISOString().slice(0, 10);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Air-quality timeout must be an integer from 1 to 60000 ms");

  const url = new URL(ENDPOINT);
  for (const [key, value] of Object.entries({ latitude: String(query.latitude), longitude: String(query.longitude), hourly: variables.join(","), domains: "cams_global", timezone: "GMT", timeformat: "iso8601", cell_selection: "nearest", start_date: startDate, end_date: endDate })) url.searchParams.set(key, value);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await (options.fetchImpl ?? fetch)(url, { signal, redirect: "error", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Open-Meteo air quality returned HTTP ${response.status}`);
  const raw = object(await boundedJson(response));
  if (raw?.error === true) throw new Error(`Open-Meteo air quality error: ${typeof raw.reason === "string" ? raw.reason.slice(0, 500) : "unspecified provider error"}`);
  const hourly = object(raw?.hourly);
  const units = object(raw?.hourly_units);
  const times = hourly?.time;
  const hours = days * 24;
  if (!raw || !hourly || !units || !Array.isArray(times) || times.length !== hours || raw.utc_offset_seconds !== 0 || !coordinate(raw.latitude, 90) || !coordinate(raw.longitude, 180)) throw new Error("Open-Meteo air quality returned invalid coordinates, UTC metadata or hourly time coverage");
  for (let index = 0; index < hours; index++) {
    const expected = new Date(start + index * HOUR).toISOString().slice(0, 16);
    if (times[index] !== expected) throw new Error("Open-Meteo air quality returned unordered, duplicated or unexpected hourly timestamps");
  }
  const warnings = [
    "CAMS global values are model-derived near-surface concentration estimates, not ground-sensor measurements or individual-facility emission measurements; nearby pollution alone does not attribute a data-center effect.",
    "Open-Meteo serves hourly output from a global model documented at 0.4 degrees (about 45 km) and 3-hourly source cadence; hourly output does not establish independent hourly measurements or street/building-scale accuracy.",
    "This adapter requests only completed historical UTC days, not future forecasts. Archived operational forecasts are not a homogeneous long-term reanalysis; model upgrades may affect trend comparisons.",
    "The source documents global history from August 2022, but actual numeric availability varies; missing/non-finite samples remain null, not zero.",
    "Reported source coordinates may echo the request and do not independently establish the exact native model cell center.",
    "The quality label 'valid' means finite numeric output only; uncertainty is not quantified and no additional scientific quality-control or trend/causal validation is claimed.",
    "The public Open-Meteo service is for non-commercial use and is rate-limited; underlying API data require CC BY 4.0 attribution to Open-Meteo and CAMS. Commercial service use requires a suitable agreement."
  ];
  const normalized: AirQualityResult["variables"] = variables.map(id => {
    const values = hourly[id];
    const unit = units[id];
    if (!Array.isArray(values) || values.length !== hours || typeof unit !== "string" || !unit.trim() || unit.length > 128) throw new Error(`Open-Meteo air quality lacks aligned values or units for ${id}`);
    const series = times.map((time, index) => {
      const value = values[index];
      const valid = typeof value === "number" && Number.isFinite(value);
      return { date: `${time}:00Z`, value: valid ? value : null, quality: valid ? "valid" as const : "missing" as const };
    });
    const finite = series.filter(sample => sample.quality === "valid");
    if (!finite.length) warnings.push(`No finite ${id} values are available in the requested period; its source response is retained with null samples.`);
    return { id, label: LABELS[id], unit, validSampleCount: finite.length, missingSampleCount: hours - finite.length, firstValidDate: finite[0]?.date ?? null, lastValidDate: finite.at(-1)?.date ?? null, series };
  });
  return {
    sourceId: "open-meteo-cams", sourceUrl: url.toString(), documentationUrl: DOCUMENTATION, retrievedAt: new Date().toISOString(), evidence: "model-derived", timeStandard: "UTC",
    period: { start: startDate, end: endDate, inclusive: true, interval: "hourly", requestedHours: hours },
    location: { latitude: query.latitude, longitude: query.longitude, sourcePoint: { latitude: raw.latitude, longitude: raw.longitude } },
    model: { id: "cams_global", name: "CAMS global atmospheric composition forecasts", nativeSpatialResolution: { latitudeDegrees: 0.4, longitudeDegrees: 0.4, approximateKilometres: 45 }, documentedSourceCadence: "3-hourly, as documented by Open-Meteo", outputCadence: "hourly", documentedArchiveStart: "2022-08", version: "not_returned" },
    license: { data: "CC BY 4.0", dataUrl: "https://open-meteo.com/en/licence", service: "free-non-commercial", termsUrl: "https://open-meteo.com/en/terms", attribution: [{ name: "Open-Meteo", url: "https://open-meteo.com/" }, { name: "Copernicus Atmosphere Monitoring Service (CAMS)", url: "https://ads.atmosphere.copernicus.eu/datasets/cams-global-atmospheric-composition-forecasts" }], rateLimits: { perMinute: 600, perHour: 5000, perDay: 10000 } },
    variables: normalized, raw, warnings
  };
}
