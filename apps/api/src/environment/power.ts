/** Supplementary public NASA POWER point-series access, not a Giovanni adapter. */
export const POWER_VARIABLES = ["T2M", "PRECTOTCORR", "RH2M", "WS2M"] as const;
type PowerVariable = typeof POWER_VARIABLES[number];

export interface PowerSeriesQuery {
  latitude: number;
  longitude: number;
  start: string;
  end: string;
  variables: string[];
}

export interface PowerSeriesResult {
  sourceId: "nasa-power";
  sourceUrl: string;
  retrievedAt: string;
  evidence: "model-derived";
  location: {
    latitude: number;
    longitude: number;
    reportedCoordinates?: number[];
    reportedGeometryType?: string;
  };
  variables: Array<{
    id: PowerVariable;
    label: string;
    unit: string;
    series: Array<{ date: string; value: number | null; quality: "valid" | "missing" }>;
  }>;
  raw: Record<string, unknown>;
  warnings: string[];
}

interface PowerSeriesOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Optional clock for deterministic validation; defaults to current UTC month. */
  now?: Date;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function monthNumber(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("POWER dates must use YYYY-MM");
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}

function monthString(value: number): string {
  return `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, "0")}`;
}

/**
 * Fetch at most four meteorological variables for one point and retain each
 * requested calendar month, including explicit nulls for unavailable samples.
 * https://power.larc.nasa.gov/docs/services/api/temporal/monthly/
 */
export async function fetchPowerSeries(query: PowerSeriesQuery, options: PowerSeriesOptions = {}): Promise<PowerSeriesResult> {
  options.signal?.throwIfAborted();
  if (!Number.isFinite(query.latitude) || query.latitude < -90 || query.latitude > 90 || !Number.isFinite(query.longitude) || query.longitude < -180 || query.longitude > 180) {
    throw new Error("POWER coordinates must be finite latitude/longitude within WGS84 bounds");
  }
  if (!Array.isArray(query.variables) || query.variables.length < 1 || query.variables.length > 4 || new Set(query.variables).size !== query.variables.length || query.variables.some(id => !POWER_VARIABLES.includes(id as PowerVariable))) {
    throw new Error(`POWER requires 1-4 unique variables from ${POWER_VARIABLES.join(", ")}`);
  }
  const start = monthNumber(query.start);
  const end = monthNumber(query.end);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("POWER validation clock is invalid");
  const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  if (start < 1981 * 12 || end < start || end > currentMonth) throw new Error("POWER period must start in 1981 or later, be ordered, and end no later than the current UTC month");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("POWER timeout must be an integer from 1 to 60000 ms");

  const url = new URL("https://power.larc.nasa.gov/api/temporal/monthly/point");
  url.searchParams.set("parameters", query.variables.join(","));
  url.searchParams.set("community", "RE");
  url.searchParams.set("latitude", String(query.latitude));
  url.searchParams.set("longitude", String(query.longitude));
  url.searchParams.set("start", query.start.slice(0, 4));
  url.searchParams.set("end", query.end.slice(0, 4));
  url.searchParams.set("format", "JSON");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await (options.fetchImpl ?? fetch)(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`NASA POWER returned HTTP ${response.status}`);
  const raw = object(await response.json());
  const parameterValues = object(object(raw?.properties)?.parameter);
  const parameterMetadata = object(raw?.parameters);
  const header = object(raw?.header);
  if (!raw || !parameterValues || !parameterMetadata || !header) throw new Error("NASA POWER returned an invalid point-series response");
  const fillValue = header.fill_value;
  if (typeof fillValue !== "number" || !Number.isFinite(fillValue)) throw new Error("NASA POWER response is missing finite fill-value metadata");

  const variables = query.variables.map(requestedId => {
    const id = requestedId as PowerVariable;
    const values = object(parameterValues[id]);
    const metadata = object(parameterMetadata[id]);
    if (!values || !metadata || typeof metadata.units !== "string" || !metadata.units.trim()) throw new Error(`NASA POWER response lacks values or units for ${id}`);
    const series: PowerSeriesResult["variables"][number]["series"] = [];
    for (let month = start; month <= end; month++) {
      const date = monthString(month);
      const sourceValue = values[date.replace("-", "")];
      const valid = typeof sourceValue === "number" && Number.isFinite(sourceValue) && sourceValue !== fillValue;
      series.push({ date, value: valid ? sourceValue : null, quality: valid ? "valid" : "missing" });
    }
    return { id, label: typeof metadata.longname === "string" && metadata.longname.trim() ? metadata.longname : id, unit: metadata.units, series };
  });

  const geometry = object(raw.geometry);
  const reportedCoordinates = Array.isArray(geometry?.coordinates) && geometry.coordinates.every(value => typeof value === "number" && Number.isFinite(value)) ? geometry.coordinates as number[] : undefined;
  const warnings = [
    "This is a point time series of model-derived meteorology at the source's native resolution, not a global grid download or direct ground observation.",
    "Reported response coordinates may echo the requested point; they do not establish the exact native model grid-cell center.",
    "The API is queried by whole years, then filtered to requested YYYY-MM slots; YYYY13 annual summaries are excluded.",
    "Missing, fill, non-numeric and unavailable monthly samples are preserved as null, not zero; current months may not yet be published.",
    "The quality label 'valid' means finite and non-fill only; no additional scientific quality-control or trend validation is claimed.",
    "Meteorological time series do not provide pollutant concentrations, water quality, facility water use, or noise measurements."
  ];
  if (query.variables.includes("PRECTOTCORR")) warnings.push("PRECTOTCORR monthly values are returned as mean daily precipitation rates in the supplied units (normally mm/day), not monthly precipitation totals; no total conversion is performed.");
  if (typeof header.time_standard === "string") warnings.push(`NASA POWER reports time_standard=${header.time_standard}; retain that convention when comparing other sources.`);
  if (Array.isArray(raw.messages)) for (const message of raw.messages.slice(0, 10)) if (typeof message === "string") warnings.push(`NASA POWER message: ${message.slice(0, 240)}`);

  return {
    sourceId: "nasa-power", sourceUrl: url.toString(), retrievedAt: new Date().toISOString(), evidence: "model-derived",
    location: {
      latitude: query.latitude, longitude: query.longitude,
      ...(reportedCoordinates ? { reportedCoordinates } : {}),
      ...(typeof geometry?.type === "string" ? { reportedGeometryType: geometry.type } : {})
    },
    variables, raw, warnings
  };
}
