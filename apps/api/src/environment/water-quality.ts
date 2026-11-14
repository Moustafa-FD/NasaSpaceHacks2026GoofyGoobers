import { createHash } from "node:crypto";

export const WATER_QUALITY_PARAMETERS = ["00010", "00095", "00400", "00300", "63680"] as const;
export type WaterQualityParameter = typeof WATER_QUALITY_PARAMETERS[number];
export const WATER_QUALITY_PARAMETER_NAMES: Record<WaterQualityParameter, string> = {
  "00010": "Water temperature", "00095": "Specific conductance", "00400": "pH", "00300": "Dissolved oxygen", "63680": "Turbidity (parameter 63680)",
};
export const WATER_QUALITY_SOURCE = {
  id: "usgs-continuous-water-quality", endpoint: "https://api.waterdata.usgs.gov/ogcapi/v1/",
  documentationUrl: "https://api.waterdata.usgs.gov/docs/ogcapi/", schemaUrl: "https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/schema?f=json",
  provisionalDataUrl: "https://waterdata.usgs.gov/provisional-data-statement/", apiKeysUrl: "https://api.waterdata.usgs.gov/docs/ogcapi/keys/",
} as const;
export interface WaterQualityQuery { stationId: string; start: string; end: string; parameters?: WaterQualityParameter[] }
export interface WaterQualityOptions { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: Date; maxRecords?: number; maxBytes?: number }
type Row = Record<string, unknown>;
export interface WaterQualityRecord {
  id: string; stationId: string; timeSeriesId: string; parameterCode: WaterQualityParameter; parameterName: string;
  date: string; sourceTime: string; value: number | null; rawValue: string | null; unit: string | null; statisticId: string | null;
  valueStatus: "numeric" | "censored" | "missing_or_non_numeric";
  censoring: { operator: string; bound: number; raw: string } | null;
  /** Retained only when explicitly supplied; a censoring bound is not inferred to be a detection limit. */
  detectionLimit: unknown; approvalStatus: string | null; qualifier: string | string[] | null; methodCategory: string | null;
  methodDetails: "not_supplied_by_continuous_endpoint"; lastModified: string | null;
  location: { latitude: number; longitude: number; crs: "EPSG:4326" } | null;
  sourceUrl: string;
}
export interface WaterQualityResult {
  schemaVersion: "1.0"; sourceId: "usgs-continuous-water-quality"; source: typeof WATER_QUALITY_SOURCE;
  evidence: "ground-observation"; complete: boolean; retrievedAt: string; timeStandard: "UTC";
  station: { id: string; name: string | null; countryCode: string | null; stateName: string | null; siteType: string | null;
    location: WaterQualityRecord["location"]; originalHorizontalDatum: string | null; sourceUrl: string };
  period: { start: string; end: string; inclusive: true };
  coverage: { scope: "one USGS monitoring location"; requestedParameters: WaterQualityParameter[]; recordCount: number; maxRecords: number; capped: boolean;
    firstObservationTime: string | null; lastObservationTime: string | null };
  parameters: Array<{ code: WaterQualityParameter; name: string; status: "returned_records" | "no_records_returned" | "not_queried_record_cap";
    recordCount: number; paginationComplete: boolean; units: string[]; timeSeriesIds: string[] }>;
  records: WaterQualityRecord[]; downloadedBytes: number;
  sourceDocuments: Array<{ url: string; bytes: number; sha256: string }>; raw: { station: unknown; pages: unknown[] }; rawSha256: string; warnings: string[];
}
function object(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid USGS ${label}`);
  return value as Row;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function realDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function geometry(value: unknown): WaterQualityRecord["location"] {
  if (value == null) return null;
  const item = object(value, "geometry"); const coordinates = item.coordinates;
  if (item.type !== "Point" || !Array.isArray(coordinates) || coordinates.length < 2 || typeof coordinates[0] !== "number" || !Number.isFinite(coordinates[0]) || Math.abs(coordinates[0]) > 180 || typeof coordinates[1] !== "number" || !Number.isFinite(coordinates[1]) || Math.abs(coordinates[1]) > 90) throw new Error("Invalid USGS station/observation coordinates");
  return { latitude: coordinates[1], longitude: coordinates[0], crs: "EPSG:4326" };
}
function numericValue(raw: string | null): Pick<WaterQualityRecord, "value" | "valueStatus" | "censoring"> {
  const numeric = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const censored = raw?.trim().match(new RegExp(`^(<=|>=|<|>)\\s*(${numeric})$`));
  if (censored && Number.isFinite(Number(censored[2]))) return { value: null, valueStatus: "censored", censoring: { operator: censored[1], bound: Number(censored[2]), raw: raw! } };
  if (raw !== null && new RegExp(`^${numeric}$`).test(raw.trim()) && Number.isFinite(Number(raw))) return { value: Number(raw), valueStatus: "numeric", censoring: null };
  return { value: null, valueStatus: "missing_or_non_numeric", censoring: null };
}

export function validateWaterQualityQuery(query: WaterQualityQuery, now = new Date()): void {
  if (typeof query.stationId !== "string" || !/^USGS-\d{8,15}$/.test(query.stationId)) throw new Error("stationId must be a USGS monitoring-location ID (USGS- followed by 8-15 digits)");
  if (!realDay(query.start) || !realDay(query.end) || query.start > query.end || query.end > now.toISOString().slice(0, 10) || (Date.parse(query.end) - Date.parse(query.start)) / 86_400_000 > 30) throw new Error("Water quality requires ordered historical YYYY-MM-DD dates spanning at most 31 inclusive UTC days");
  if (query.parameters !== undefined && (!Array.isArray(query.parameters) || !query.parameters.length || query.parameters.length > 5 || query.parameters.some(code => typeof code !== "string" || !WATER_QUALITY_PARAMETERS.includes(code)) || new Set(query.parameters).size !== query.parameters.length)) throw new Error("Choose unique supported water-quality parameter codes");
}

/** Real point-sensor records. No facility matching, exposure calculation or river-quality inference is performed. */
export async function fetchWaterQuality(query: WaterQualityQuery, options: WaterQualityOptions = {}): Promise<WaterQualityResult> {
  validateWaterQualityQuery(query, options.now);
  const maxRecords = options.maxRecords ?? 20_000; const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 20_000) throw new Error("USGS maxRecords must be 1-20000");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 65_536 || maxBytes > 64 * 1024 * 1024) throw new Error("USGS maxBytes must be between 64 KiB and 64 MiB");
  const selected = query.parameters ?? [...WATER_QUALITY_PARAMETERS];
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = new URL(WATER_QUALITY_SOURCE.endpoint);
  let downloadedBytes = 0;
  const sourceDocuments: WaterQualityResult["sourceDocuments"] = [];
  const retrieve = async (url: URL): Promise<unknown> => {
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + "collections/") || url.username || url.password || url.hash) throw new Error("USGS source URL is outside the fixed public API");
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(60_000)]); signal.throwIfAborted();
    const response = await fetchImpl(url, { signal, redirect: "error", headers: { Accept: "application/geo+json, application/json", "User-Agent": "GoofyGoobers-SpaceApps2026/0.2" } });
    if (response.status === 429) throw new Error("USGS anonymous rate limit reached; retry later or obtain your own API key for higher limits");
    if (!response.ok) throw new Error(`USGS water data returned HTTP ${response.status}; no observation fallback is fabricated`);
    if (response.headers.get("content-type") && !response.headers.get("content-type")!.toLowerCase().includes("json")) throw new Error("USGS returned a non-JSON response");
    if (Number(response.headers.get("content-length")) > 4 * 1024 * 1024) { await response.body?.cancel(); throw new Error("USGS document exceeds the 4 MiB response limit"); }
    if (!response.body) throw new Error("USGS returned an empty response");
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; downloadedBytes += part.value.byteLength;
        if (bytes > 4 * 1024 * 1024 || downloadedBytes > maxBytes) throw new Error("USGS acquisition exceeds its bounded byte budget");
        parts.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const body = Buffer.concat(parts);
    sourceDocuments.push({ url: url.href, bytes, sha256: createHash("sha256").update(body).digest("hex") });
    return JSON.parse(body.toString("utf8")) as unknown;
  };
  const stationUrl = new URL(`collections/monitoring-locations/items/${query.stationId}`, base); stationUrl.searchParams.set("f", "json");
  const rawStation = await retrieve(stationUrl);
  const stationFeature = object(rawStation, "station feature"); const stationProperties = object(stationFeature.properties, "station properties");
  if (stationFeature.type !== "Feature" || stationFeature.id !== query.stationId || stationProperties.id !== query.stationId) throw new Error("USGS station identity differs from the requested monitoring location");
  const station: WaterQualityResult["station"] = { id: query.stationId, name: text(stationProperties.monitoring_location_name), countryCode: text(stationProperties.country_code), stateName: text(stationProperties.state_name), siteType: text(stationProperties.site_type),
    location: geometry(stationFeature.geometry), originalHorizontalDatum: text(stationProperties.original_horizontal_datum), sourceUrl: stationUrl.href };
  const interval = `${query.start}T00:00:00Z/${query.end}T23:59:59.999Z`;
  const lower = Date.parse(`${query.start}T00:00:00Z`); const upper = Date.parse(`${query.end}T23:59:59.999Z`);
  const records: WaterQualityRecord[] = []; const rawPages: unknown[] = []; const seen = new Set<string>();
  const parameters: WaterQualityResult["parameters"] = [];
  let capped = false;
  for (const code of selected) {
    const startCount = records.length;
    if (records.length === maxRecords) { capped = true; parameters.push({ code, name: WATER_QUALITY_PARAMETER_NAMES[code], status: "not_queried_record_cap", recordCount: 0, paginationComplete: false, units: [], timeSeriesIds: [] }); continue; }
    let offset = 0; let paginationComplete = false;
    while (true) {
      const limit = Math.min(1000, maxRecords - records.length);
      const url = new URL("collections/continuous/items", base);
      for (const [key, value] of Object.entries({ f: "json", monitoring_location_id: query.stationId, parameter_code: code, datetime: interval, sortby: "time", limit: String(limit), offset: String(offset) })) url.searchParams.set(key, value);
      const rawPage = await retrieve(url); rawPages.push(rawPage); const page = object(rawPage, "continuous page");
      if (page.type !== "FeatureCollection" || !Array.isArray(page.features) || page.features.length > limit || (page.numberReturned !== undefined && page.numberReturned !== page.features.length)) throw new Error("Invalid USGS pagination count or feature collection");
      for (const value of page.features) {
        const feature = object(value, "observation feature"); const props = object(feature.properties, "observation properties");
        const featureId = text(feature.id); const timeSeriesId = text(props.time_series_id); const sourceTime = text(props.time);
        if (feature.type !== "Feature" || !featureId || !timeSeriesId || props.monitoring_location_id !== query.stationId || props.parameter_code !== code) throw new Error("USGS returned an observation outside the requested station/parameter");
        if (seen.has(featureId)) throw new Error("USGS pagination returned duplicate observation IDs"); seen.add(featureId);
        if (!sourceTime || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(sourceTime) || !realDay(sourceTime.slice(0, 10)) || !Number.isFinite(Date.parse(sourceTime)) || Date.parse(sourceTime) < lower || Date.parse(sourceTime) > upper) throw new Error("USGS observation time lies outside the requested UTC interval or is invalid");
        const rawValue = props.value == null ? null : typeof props.value === "string" ? props.value : undefined;
        if (rawValue === undefined) throw new Error("USGS observation value must preserve the source's numeric-string format");
        const qualifier = props.qualifier ?? null;
        if (qualifier !== null && typeof qualifier !== "string" && (!Array.isArray(qualifier) || qualifier.some(value => typeof value !== "string"))) throw new Error("Invalid USGS observation qualifier");
        records.push({ id: featureId, stationId: query.stationId, timeSeriesId, parameterCode: code, parameterName: WATER_QUALITY_PARAMETER_NAMES[code],
          date: new Date(sourceTime).toISOString(), sourceTime, rawValue, ...numericValue(rawValue), unit: text(props.unit_of_measure), statisticId: text(props.statistic_id),
          detectionLimit: props.detection_limit ?? null, approvalStatus: text(props.approval_status), qualifier: qualifier as string | string[] | null,
          methodCategory: text(props.method_category), methodDetails: "not_supplied_by_continuous_endpoint", lastModified: text(props.last_modified), location: geometry(feature.geometry), sourceUrl: url.href });
      }
      const links = page.links ?? [];
      if (!Array.isArray(links)) throw new Error("Invalid USGS pagination links");
      const nextLinks = links.map(value => object(value, "link")).filter(link => link.rel === "next");
      if (nextLinks.length > 1) throw new Error("USGS returned ambiguous next-page links");
      let nextOffset: number | undefined;
      if (nextLinks.length) {
        const next = new URL(String(nextLinks[0].href), base);
        if (next.origin !== base.origin || next.pathname !== url.pathname || next.username || next.password || next.hash || [...next.searchParams.keys()].some(key => ![...url.searchParams.keys()].includes(key))) throw new Error("USGS next-page URL is outside the fixed continuous API");
        for (const key of ["f", "monitoring_location_id", "parameter_code", "datetime", "sortby", "limit"]) if (next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== url.searchParams.get(key)) throw new Error("USGS next-page URL changed the requested filters");
        const value = next.searchParams.get("offset");
        if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) !== offset + page.features.length || page.features.length === 0) throw new Error("USGS next-page offset did not advance exactly over returned records");
        nextOffset = Number(value);
      }
      if (records.length === maxRecords) { capped = nextOffset !== undefined || page.features.length === limit || selected.indexOf(code) < selected.length - 1; paginationComplete = !capped; break; }
      if (nextOffset !== undefined) { offset = nextOffset; continue; }
      // A full page without a next link is probed once more, so truncation cannot masquerade as completion.
      if (page.features.length === limit) { offset += page.features.length; continue; }
      paginationComplete = true; break;
    }
    const selectedRecords = records.slice(startCount);
    parameters.push({ code, name: WATER_QUALITY_PARAMETER_NAMES[code], status: selectedRecords.length ? "returned_records" : "no_records_returned", recordCount: selectedRecords.length,
      paginationComplete, units: [...new Set(selectedRecords.map(record => record.unit).filter((value): value is string => value !== null))], timeSeriesIds: [...new Set(selectedRecords.map(record => record.timeSeriesId))] });
  }
  records.sort((a, b) => a.date.localeCompare(b.date) || a.parameterCode.localeCompare(b.parameterCode) || a.id.localeCompare(b.id));
  const raw = { station: rawStation, pages: rawPages };
  return { schemaVersion: "1.0", sourceId: WATER_QUALITY_SOURCE.id, source: WATER_QUALITY_SOURCE, evidence: "ground-observation", complete: parameters.every(parameter => parameter.paginationComplete), retrievedAt: new Date().toISOString(), timeStandard: "UTC", station,
    period: { start: query.start, end: query.end, inclusive: true }, coverage: { scope: "one USGS monitoring location", requestedParameters: selected, recordCount: records.length, maxRecords, capped, firstObservationTime: records[0]?.date ?? null, lastObservationTime: records.at(-1)?.date ?? null },
    parameters, records, downloadedBytes, sourceDocuments, raw, rawSha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"), warnings: [
      "These are station sensor records, distinct from regional modeled data. Provisional status, estimated/other qualifiers and method-category codes are retained; not every qualified value should be treated as a direct validated measurement.",
      "Complete means pagination for the requested station/parameters was exhausted, not that sensor coverage is continuous or every requested parameter was monitored. Empty parameters and gaps remain unknown.",
      "Original numeric strings and units are preserved. Censored values retain their operator/bound and have null numeric value; censoring bounds are not relabeled as laboratory detection limits.",
      "The continuous endpoint does not supply full analytical methods or detection-limit metadata for ordinary sensor records. Missing metadata remains null/not supplied.",
      "Geometry is EPSG:4326 per the modern USGS API; the station's original horizontal datum is retained separately.",
      "Water temperature, conductance, pH, dissolved oxygen and turbidity do not establish complete water chemistry, potability, facility withdrawals, or data-center causation. No flow value is substituted for chemistry.",
      "Anonymous public API requests have rate limits. API keys raise those limits; this adapter sends no key and performs sequential bounded requests.",
      ...(capped ? ["The record cap was reached; this acquisition is incomplete or its exact endpoint could not be confirmed. Narrow dates or parameter selection."] : []),
    ] };
}
