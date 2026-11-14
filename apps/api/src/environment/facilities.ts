import { createHash } from "node:crypto";

/** Public, community-mapped facility locations; separate from NASA environmental data. */
export const FACILITY_SOURCE = {
  id: "openstreetmap-overpass",
  endpoint: "https://overpass-api.de/api/interpreter",
  documentationUrl: "https://dev.overpass-api.de/overpass-doc/en/",
  taggingUrl: "https://wiki.openstreetmap.org/wiki/Telecommunication#Data_centres",
  license: {
    id: "ODbL-1.0",
    url: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    attributionUrl: "https://www.openstreetmap.org/copyright"
  }
} as const;

const MAX_RECORDS = 20_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
type FacilityElementType = "node" | "way" | "relation";
export interface FacilitiesQuery { bbox?: [number, number, number, number]; }
export interface FacilitiesOptions { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number; }
export interface FacilityRecord {
  id: string;
  osmType: FacilityElementType;
  osmId: number;
  sourceUrl: string;
  name: string | null;
  operator: string | null;
  location: { latitude: number | null; longitude: number | null; method: "osm_node" | "bounding_box_center" | "missing" };
  address: { country: string | null; city: string | null; state: string | null; postcode: string | null; street: string | null; housenumber: string | null };
  tags: Record<string, string>;
}
export interface FacilityInventory {
  schemaVersion: "1.0";
  sourceId: "openstreetmap-overpass";
  sourceUrl: string;
  query: string;
  retrievedAt: string;
  sourceUpdatedAt: string | null;
  sourceGenerator: string | null;
  sourceCopyright: string | null;
  scope: { type: "global" | "bbox"; bbox: [number, number, number, number] | null };
  completeness: "osm_query_snapshot_not_census";
  license: typeof FACILITY_SOURCE.license;
  counts: {
    records: number;
    sourceTotal: number;
    located: number;
    unlocated: number;
    byElementType: Record<FacilityElementType, number>;
    /** Only explicit addr:country tags; these are not reverse-geocoded countries. */
    byCountryTag: Record<string, number>;
    missingCountryTag: number;
    priorityCountriesByExplicitCountryTag: { CA: number; US: number };
  };
  facilities: FacilityRecord[];
  warnings: string[];
  /** Fetch-only upstream JSON, to persist separately from the public result. */
  raw?: Record<string, unknown>;
  /** SHA-256 of UTF-8 JSON.stringify(raw), rather than original HTTP bytes. */
  rawSha256?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nullableText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function validateQuery(query: FacilitiesQuery): void {
  if (query.bbox !== undefined) {
    const box = query.bbox;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(value => typeof value === "number" && Number.isFinite(value)) || !(-180 <= box[0] && box[0] < box[2] && box[2] <= 180 && -90 <= box[1] && box[1] < box[3] && box[3] <= 90)) {
      throw new Error("Facility bbox must be ordered [west,south,east,north] within WGS84 bounds; dateline crossing is unsupported");
    }
  }
}
function buildQuery(query: FacilitiesQuery): string {
  validateQuery(query);
  const bbox = query.bbox ? `(${query.bbox[1]},${query.bbox[0]},${query.bbox[3]},${query.bbox[2]})` : "";
  // The union deduplicates identical OSM elements, not distinct representations
  // of the same physical campus. A final count detects out-limit truncation.
  return `[out:json][timeout:90][maxsize:134217728];\n(\n  nwr["telecom"="data_center"]${bbox};\n  nwr["building"="data_center"]${bbox};\n  nwr["man_made"="data_center"]${bbox};\n);\nout body center ${MAX_RECORDS + 1};\nout count;`;
}

/**
 * Normalize a complete Overpass response produced by this adapter's query.
 * Missing coordinates and names remain null; IDs are never replaced by names.
 * https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL#Print_(out)
 */
export function normalizeFacilities(raw: unknown, context: { query?: FacilitiesQuery; retrievedAt?: string } = {}): FacilityInventory {
  const query = context.query ?? {};
  const queryText = buildQuery(query);
  const payload = object(raw);
  if (!payload || !Array.isArray(payload.elements)) throw new Error("OpenStreetMap Overpass returned invalid facility JSON");
  if (payload.remark !== undefined && payload.remark !== null && String(payload.remark).trim()) throw new Error(`OpenStreetMap Overpass returned an incomplete query: ${String(payload.remark).slice(0, 1000)}`);
  const elements = payload.elements;
  const count = object(elements.at(-1));
  if (!count || count.type !== "count" || elements.slice(0, -1).some(value => object(value)?.type === "count")) throw new Error("OpenStreetMap Overpass response lacks the final completion count; it may be truncated");
  const countTags = object(count.tags);
  const totalText = countTags?.total;
  if (typeof totalText !== "string" || !/^\d+$/.test(totalText) || !Number.isSafeInteger(Number(totalText))) throw new Error("OpenStreetMap Overpass returned an invalid completion count");
  const sourceTotal = Number(totalText);
  if (sourceTotal > MAX_RECORDS || elements.length - 1 > MAX_RECORDS) throw new Error(`OpenStreetMap Overpass facility result exceeds ${MAX_RECORDS} records; use a bbox rather than accepting a truncated global result`);
  if (sourceTotal !== elements.length - 1) throw new Error("OpenStreetMap Overpass facility count does not match the response; result may be truncated");
  const ids = new Set<string>();
  const facilities = elements.slice(0, -1).map(value => {
    const element = object(value);
    if (!element || !["node", "way", "relation"].includes(String(element.type)) || typeof element.id !== "number" || !Number.isSafeInteger(element.id) || element.id <= 0) throw new Error("OpenStreetMap Overpass returned an invalid facility element ID/type");
    const osmType = element.type as FacilityElementType;
    const osmId = element.id;
    const id = `osm/${osmType}/${osmId}`;
    if (ids.has(id)) throw new Error(`OpenStreetMap Overpass returned a duplicate element: ${id}`);
    ids.add(id);
    const sourceTags = object(element.tags);
    if (!sourceTags || Object.values(sourceTags).some(tag => typeof tag !== "string")) throw new Error(`OpenStreetMap Overpass returned invalid tags for ${id}`);
    const tags = { ...sourceTags } as Record<string, string>;
    if (![tags.telecom, tags.building, tags.man_made].includes("data_center")) throw new Error(`OpenStreetMap Overpass returned an element outside the requested data-center tags: ${id}`);
    const coordinates = osmType === "node" ? element : object(element.center);
    const latitude = coordinates?.lat;
    const longitude = coordinates?.lon;
    const located = typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90 && typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
    return {
      id, osmType, osmId, sourceUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
      name: nullableText(tags.name), operator: nullableText(tags.operator),
      location: { latitude: located ? latitude : null, longitude: located ? longitude : null, method: located ? osmType === "node" ? "osm_node" as const : "bounding_box_center" as const : "missing" as const },
      address: { country: nullableText(tags["addr:country"]), city: nullableText(tags["addr:city"]), state: nullableText(tags["addr:state"]), postcode: nullableText(tags["addr:postcode"]), street: nullableText(tags["addr:street"]), housenumber: nullableText(tags["addr:housenumber"]) },
      tags
    };
  });
  const counts: FacilityInventory["counts"] = { records: facilities.length, sourceTotal, located: 0, unlocated: 0, byElementType: { node: 0, way: 0, relation: 0 }, byCountryTag: {}, missingCountryTag: 0, priorityCountriesByExplicitCountryTag: { CA: 0, US: 0 } };
  for (const facility of facilities) {
    counts.byElementType[facility.osmType]++;
    counts[facility.location.method === "missing" ? "unlocated" : "located"]++;
    const countryTag = facility.address.country;
    if (countryTag === null) counts.missingCountryTag++;
    else {
      // Retain exactly the provided country text; only explicit ISO US/CA tags
      // participate in the priority-country counters. Never infer from a name.
      Object.defineProperty(counts.byCountryTag, countryTag, { value: (Object.hasOwn(counts.byCountryTag, countryTag) ? counts.byCountryTag[countryTag] : 0) + 1, enumerable: true, writable: true, configurable: true });
      if (countryTag.toUpperCase() === "CA" || countryTag.toUpperCase() === "US") counts.priorityCountriesByExplicitCountryTag[countryTag.toUpperCase() as "CA" | "US"]++;
    }
  }
  const osm3s = object(payload.osm3s);
  const timestamp = nullableText(osm3s?.timestamp_osm_base);
  const sourceUpdatedAt = timestamp !== null && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
  const retrievedAt = context.retrievedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error("Invalid facility retrieval timestamp");
  const warnings = [
    "OpenStreetMap is a community-mapped snapshot, not a complete global data-center census; mapping/tagging varies by region and changes over time.",
    "The query covers telecom=data_center, building=data_center and legacy man_made=data_center tags; other tagging and unmapped sites are not included.",
    "Distinct nodes, buildings and campus relations are retained by OSM ID and can represent the same physical facility; these records must not be treated as unique operating businesses.",
    "Way/relation locations are bounding-box centers, not surveyed entrances, building centroids or facility boundaries. Missing/invalid coordinates remain null.",
    "Facility tags do not establish operating status, capacity, historical opening dates, emissions, water consumption or environmental impacts.",
    "Country counts use explicit addr:country tags only; missing countries are not inferred from names or coordinates. Canada/USA counters count only explicit CA/US tags.",
    "Display © OpenStreetMap contributors and the ODbL link when using these locations; the OSM-derived database remains subject to ODbL attribution/share-alike requirements."
  ];
  if (query.bbox) warnings.push("This snapshot uses the requested bbox filter; Overpass selects using source geometry, and returned bounding-box centers may fall outside that bbox.");
  if (sourceUpdatedAt === null) warnings.push("The response did not provide a usable OSM base timestamp; retrieval time does not establish source freshness.");
  return { schemaVersion: "1.0", sourceId: "openstreetmap-overpass", sourceUrl: FACILITY_SOURCE.endpoint, query: queryText, retrievedAt, sourceUpdatedAt, sourceGenerator: nullableText(payload.generator), sourceCopyright: nullableText(osm3s?.copyright), scope: { type: query.bbox ? "bbox" : "global", bbox: query.bbox ? [...query.bbox] : null }, completeness: "osm_query_snapshot_not_census", license: { ...FACILITY_SOURCE.license }, counts, facilities, warnings };
}

/** One bounded public request; callers should cache successful snapshots. */
export async function fetchFacilities(query: FacilitiesQuery = {}, options: FacilitiesOptions = {}): Promise<FacilityInventory> {
  options.signal?.throwIfAborted();
  const queryText = buildQuery(query);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150_000) throw new Error("Facility timeout must be an integer from 1 to 150000 ms");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await (options.fetchImpl ?? fetch)(FACILITY_SOURCE.endpoint, { method: "POST", signal, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "NasaSpaceHacks2026GoofyGoobers/0.1 (public OSM data-center inventory)" }, body: new URLSearchParams({ data: queryText }).toString() });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenStreetMap Overpass returned HTTP ${response.status}; no fallback or partial facility inventory was accepted`); }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error("OpenStreetMap Overpass facility response exceeds 32 MiB"); }
  if (!response.body) throw new Error("OpenStreetMap Overpass returned an empty facility response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("OpenStreetMap Overpass facility response exceeds 32 MiB"); }
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
  catch { throw new Error("OpenStreetMap Overpass returned invalid or truncated facility JSON"); }
  const normalized = normalizeFacilities(raw, { query });
  return { ...normalized, raw: raw as Record<string, unknown>, rawSha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex") };
}
