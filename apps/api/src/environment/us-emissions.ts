import { createHash } from "node:crypto";

/** Verified public NEI facility-summary inventory years; not a continuous annual series. */
export const US_NEI_YEARS = [2008, 2011, 2014, 2017, 2020, 2023] as const;
export const US_NEI_SOURCE = {
  id: "us-epa-nei",
  endpoint: "https://data.epa.gov/dmapservice/",
  documentationUrl: "https://www.epa.gov/enviro/envirofacts-data-service-api",
  inventoryUrl: "https://www.epa.gov/air-emissions-inventories/national-emissions-inventory-nei",
  guideUrl: "https://www.epa.gov/enviro/nei-search-user-guide",
  attribution: "U.S. Environmental Protection Agency, National Emissions Inventory (NEI)"
} as const;
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(" "));
const PAGE_SIZE = 1000;
const MAX_RECORDS = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;

export interface UsEmissionsQuery { year?: number; state?: string; }
export interface UsEmissionsOptions { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number; }
export interface UsEmissionRecord {
  id: string;
  reportingYear: number;
  facility: { id: string; sourceId: string; name: string | null; latitude: number | null; longitude: number | null; address: string | null; city: string | null; county: string | null; state: string | null; postalCode: string | null; sourceFacilityType: string | null };
  classification: { naicsCode: "518210"; sourceDescription: string | null; status: "sector_candidate_unverified" };
  pollutant: { code: string; name: string | null; type: string | null };
  quantity: number | null;
  unit: string | null;
  quality: "finite_source_value" | "missing";
  measurementMethod: "not_supplied_in_summary";
  sourceUrl: string;
}
export interface UsEmissionsInventory {
  schemaVersion: "1.0";
  sourceId: "us-epa-nei";
  sourceUrl: string;
  sourceUrls: string[];
  retrievedAt: string;
  evidence: "reported_emissions_inventory";
  reportingYear: number;
  naicsCode: "518210";
  scope: { country: "US"; state: string | null };
  completeness: "complete_filtered_api_result_not_facility_census";
  attribution: string;
  counts: { records: number; facilities: number; pollutants: number; missingQuantities: number; missingUnits: number; unlocatedRecords: number };
  records: UsEmissionRecord[];
  warnings: string[];
  /** Full downloaded rows, retained separately from normalized/public results. */
  raw?: Record<string, unknown>[];
  /** SHA-256 of UTF-8 JSON.stringify(raw), rather than original HTTP bytes. */
  rawSha256?: string;
}

function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function validated(query: UsEmissionsQuery): { year: number; state: string | null } {
  const year = query.year ?? 2023;
  if (!Number.isInteger(year) || !(US_NEI_YEARS as readonly number[]).includes(year)) throw new Error(`EPA NEI year must be one of ${US_NEI_YEARS.join(", ")}; unavailable years are not interpolated`);
  if (query.state !== undefined && (typeof query.state !== "string" || !STATES.has(query.state.toUpperCase()))) throw new Error("EPA NEI state must be a supported two-letter US state/territory postal code");
  return { year, state: query.state?.toUpperCase() ?? null };
}
function pageUrl(year: number, state: string | null, first: number, last: number): string {
  const filter = `naics_code/equals/518210${state ? `/and/state_abbr/equals/${state}` : ""}`;
  return `${US_NEI_SOURCE.endpoint}nei.vw_facility_summaries_${year}/${filter}/sort/eis_facility_id:asc,pollutant_code:asc,pollutant_type:asc,uom:asc/${first}:${last}/json`;
}
function sourceId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return undefined;
}

/** Normalize verified, complete facility/pollutant summary rows without unit conversions or synthetic years. */
export function normalizeUsEmissions(raw: unknown, query: UsEmissionsQuery = {}, context: { sourceUrls?: string[]; retrievedAt?: string } = {}): UsEmissionsInventory {
  const { year, state } = validated(query);
  if (!Array.isArray(raw)) throw new Error("EPA NEI returned invalid JSON; expected facility-summary rows");
  if (raw.length > MAX_RECORDS) throw new Error(`EPA NEI result exceeds ${MAX_RECORDS} records; narrow the state filter`);
  const recordIds = new Set<string>();
  const records = raw.map(value => {
    const row = object(value);
    const eisId = sourceId(row?.eis_facility_id);
    const pollutantCode = typeof row?.pollutant_code === "number" && Number.isFinite(row.pollutant_code) ? String(row.pollutant_code) : text(row?.pollutant_code);
    if (!row || !eisId || pollutantCode === null) throw new Error("EPA NEI returned a row without a valid facility ID/pollutant code");
    if (String(row.naics_code) !== "518210") throw new Error("EPA NEI returned a row outside the requested NAICS 518210 filter");
    const sourceState = text(row.state_abbr);
    if (state && sourceState?.toUpperCase() !== state) throw new Error("EPA NEI returned a row outside the requested state filter");
    const unit = text(row.uom);
    const pollutantType = text(row.pollutant_type);
    const id = `epa-nei/${year}/${eisId}/${encodeURIComponent(pollutantCode)}/${encodeURIComponent(pollutantType ?? "")}/${encodeURIComponent(unit ?? "")}`;
    if (recordIds.has(id)) throw new Error(`EPA NEI returned duplicate facility/pollutant rows; pagination may be unstable: ${id}`);
    recordIds.add(id);
    const located = typeof row.latitude === "number" && Number.isFinite(row.latitude) && Math.abs(row.latitude) <= 90 && typeof row.longitude === "number" && Number.isFinite(row.longitude) && Math.abs(row.longitude) <= 180;
    const quantity = typeof row.emissions === "number" && Number.isFinite(row.emissions) ? row.emissions : null;
    return {
      id, reportingYear: year,
      facility: { id: `eis/${eisId}`, sourceId: eisId, name: text(row.site_name), latitude: located ? row.latitude as number : null, longitude: located ? row.longitude as number : null, address: text(row.address), city: text(row.city_name), county: text(row.county_name), state: sourceState, postalCode: text(row.address_postal_code), sourceFacilityType: text(row.facility_type) },
      classification: { naicsCode: "518210" as const, sourceDescription: text(row.code_description), status: "sector_candidate_unverified" as const },
      pollutant: { code: pollutantCode, name: text(row.description), type: pollutantType },
      quantity, unit, quality: quantity === null ? "missing" as const : "finite_source_value" as const,
      measurementMethod: "not_supplied_in_summary" as const,
      sourceUrl: `${US_NEI_SOURCE.endpoint}nei.vw_facility_summaries_${year}/eis_facility_id/equals/${eisId}/and/naics_code/equals/518210/1:1000/json`
    };
  });
  const retrievedAt = context.retrievedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error("Invalid EPA NEI retrieval timestamp");
  const sourceUrls = context.sourceUrls ?? [pageUrl(year, state, 1, PAGE_SIZE)];
  return {
    schemaVersion: "1.0", sourceId: "us-epa-nei", sourceUrl: sourceUrls[0] ?? pageUrl(year, state, 1, PAGE_SIZE), sourceUrls, retrievedAt,
    evidence: "reported_emissions_inventory", reportingYear: year, naicsCode: "518210", scope: { country: "US", state }, completeness: "complete_filtered_api_result_not_facility_census", attribution: US_NEI_SOURCE.attribution,
    counts: { records: records.length, facilities: new Set(records.map(record => record.facility.id)).size, pollutants: new Set(records.map(record => record.pollutant.code)).size, missingQuantities: records.filter(record => record.quantity === null).length, missingUnits: records.filter(record => record.unit === null).length, unlocatedRecords: records.filter(record => record.facility.latitude === null).length },
    records,
    warnings: [
      "NEI quantities are historical facility-level emissions inventory estimates assembled from agency reports and EPA estimates; they are not necessarily direct measurements, ambient concentrations, permit limits or predictions.",
      "NAICS 518210 includes computing infrastructure, hosting, data processing and related services. Every returned facility is an unverified sector candidate, not automatically a confirmed data center; historical source descriptions can be inconsistent with the numeric NAICS code.",
      "Coverage is the filtered NEI point-source inventory for the selected year/state, not all data centers or all their emissions. Missing facilities or pollutant rows must not be interpreted as zero emissions.",
      "Source uom codes (for example TON and LB) are preserved without conversion. Do not sum different units, pollutants, overlapping particulate definitions or inventory years.",
      "The facility summary does not supply a per-row estimation/measurement method, uncertainty or publication timestamp; retrieval time does not establish source publication time.",
      "Only the six verified triennial inventory years 2008, 2011, 2014, 2017, 2020 and 2023 are supported. No intervening years or recent/future quantities are filled in, and changing inventories/methods can affect comparisons.",
      "These point-source quantities do not establish off-site electricity emissions, a facility's water use, water quality, noise or its causal effect on nearby environmental trends."
    ]
  };
}

async function readPage(response: Response, remainingBytes: number, signal: AbortSignal): Promise<{ raw: unknown; bytes: number }> {
  if (Number(response.headers.get("content-length")) > remainingBytes) { await response.body?.cancel(); throw new Error("EPA NEI response exceeds the 32 MiB total download limit"); }
  if (!response.body) throw new Error("EPA NEI returned an empty response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > remainingBytes) throw new Error("EPA NEI response exceeds the 32 MiB total download limit");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const content = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  try { return { raw: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)), bytes }; }
  catch { throw new Error("EPA NEI returned invalid or truncated JSON"); }
}

/** Bounded, sorted pagination of one fixed public EPA table and NAICS filter. */
export async function fetchUsEmissions(query: UsEmissionsQuery = {}, options: UsEmissionsOptions = {}): Promise<UsEmissionsInventory> {
  options.signal?.throwIfAborted();
  const { year, state } = validated(query);
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("EPA NEI timeout must be an integer from 1 to 180000 ms");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const raw: Record<string, unknown>[] = [];
  const sourceUrls: string[] = [];
  let totalBytes = 0;
  for (let first = 1; first <= MAX_RECORDS + 1; first += PAGE_SIZE) {
    const last = Math.min(first + PAGE_SIZE - 1, MAX_RECORDS + 1);
    const url = pageUrl(year, state, first, last);
    sourceUrls.push(url);
    const response = await (options.fetchImpl ?? fetch)(url, { signal, headers: { Accept: "application/json", "User-Agent": "NasaSpaceHacks2026GoofyGoobers/0.1 (public EPA environmental inventory)" } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`EPA NEI returned HTTP ${response.status} for ${url}; partial pages were not accepted`); }
    const page = await readPage(response, MAX_BYTES - totalBytes, signal);
    totalBytes += page.bytes;
    if (!Array.isArray(page.raw)) throw new Error("EPA NEI returned an error or invalid response instead of facility-summary rows");
    if (page.raw.length > last - first + 1) throw new Error("EPA NEI ignored the requested page bounds; response may be incomplete");
    for (const value of page.raw) {
      const row = object(value);
      if (!row) throw new Error("EPA NEI returned invalid facility-summary rows");
      raw.push(row);
    }
    if (raw.length > MAX_RECORDS) throw new Error(`EPA NEI result exceeds ${MAX_RECORDS} records; narrow the state filter rather than accepting truncated results`);
    if (page.raw.length < last - first + 1) {
      const normalized = normalizeUsEmissions(raw, { year, ...(state ? { state } : {}) }, { sourceUrls });
      return { ...normalized, raw, rawSha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex") };
    }
  }
  throw new Error(`EPA NEI result reaches the ${MAX_RECORDS}-record cap; completeness could not be established`);
}
