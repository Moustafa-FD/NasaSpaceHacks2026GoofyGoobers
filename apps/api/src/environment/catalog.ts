/** Public collection discovery only; this module does not download observations. */
export const CATALOG_TARGETS = [
  { id: "merra2-temperature", label: "MERRA-2 monthly single-level diagnostics", shortName: "M2TMNXSLV", sourceResource: "Giovanni", resourceUrl: "https://giovanni.gsfc.nasa.gov/" },
  { id: "imerg-precipitation", label: "GPM IMERG monthly precipitation", shortName: "GPM_3IMERGM", sourceResource: "Giovanni", resourceUrl: "https://giovanni.gsfc.nasa.gov/" },
  { id: "omi-no2", label: "OMI total and tropospheric NO2 columns", shortName: "OMNO2d", sourceResource: "Giovanni", resourceUrl: "https://giovanni.gsfc.nasa.gov/" },
  { id: "modis-vegetation", label: "MODIS monthly vegetation indices", shortName: "MOD13C2", sourceResource: "AppEEARS", resourceUrl: "https://appeears.earthdatacloud.nasa.gov/" },
  { id: "modis-surface-temperature", label: "MODIS monthly land-surface temperature", shortName: "MOD11C3", sourceResource: "AppEEARS", resourceUrl: "https://appeears.earthdatacloud.nasa.gov/" },
  { id: "gldas-land-water", label: "GLDAS monthly land-model water variables", shortName: "GLDAS_NOAH025_M", sourceResource: "Hydrology Time Series", resourceUrl: "https://disc.gsfc.nasa.gov/information/tools?title=Hydrology%20Time%20Series" }
] as const;

type CatalogTarget = typeof CATALOG_TARGETS[number];
type BoundingBox = [west: number, south: number, east: number, north: number];

export interface CollectionInventory {
  targetId: string;
  targetLabel: string;
  shortName: string;
  version: string;
  conceptId: string;
  title: string;
  timeStart: string | null;
  timeEnd: string | null;
  links: Array<{ href: string; rel?: string; title?: string }>;
  bbox?: BoundingBox;
  boundingBoxes: BoundingBox[];
  catalogUrl: string;
  access: "metadata_only";
  retrievedAt: string;
  sourceResource: CatalogTarget["sourceResource"];
  resourceUrl: string;
}

export interface CatalogTargetStatus {
  targetId: string;
  status: "found" | "not_found" | "error" | "truncated";
  queryUrl: string;
  returnedCount: number;
  totalHits: number | null;
  error?: { code: "UPSTREAM_ERROR"; message: string };
}

export interface CollectionDiscovery {
  schemaVersion: "1.0";
  provider: "NASA CMR";
  access: "metadata_only";
  queryScope: "curated_environmental_collections";
  versionSelection: "all_returned_versions";
  retrievedAt: string;
  completeForCuratedTargets: boolean;
  records: CollectionInventory[];
  targets: CatalogTargetStatus[];
}

interface DiscoveryOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const CMR_SEARCH = "https://cmr.earthdata.nasa.gov/search/collections.json";
const PAGE_SIZE = 20;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boxes(value: unknown): BoundingBox[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item !== "string") return [];
    // CMR JSON boxes are south west north east, not GeoJSON/WGS84 bbox order.
    const coords = item.trim().split(/\s+/).map(Number);
    if (coords.length !== 4 || !coords.every(Number.isFinite)) return [];
    const [south, west, north, east] = coords;
    if (south < -90 || north > 90 || west < -180 || east > 180 || south > north) return [];
    return [[west, south, east, north] as BoundingBox];
  });
}

function links(value: unknown): CollectionInventory["links"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const link = object(item);
    const href = text(link?.href);
    if (!href || !/^https?:\/\//i.test(href)) return [];
    return [{ href, ...(text(link?.rel) ? { rel: text(link?.rel) } : {}), ...(text(link?.title) ? { title: text(link?.title) } : {}) }];
  });
}

function normalizeEntry(value: unknown, target: CatalogTarget, retrievedAt: string): CollectionInventory {
  const entry = object(value);
  const shortName = text(entry?.short_name);
  const version = text(entry?.version_id);
  const conceptId = text(entry?.id);
  const title = text(entry?.dataset_id) ?? text(entry?.title);
  if (!entry || !shortName || !version || !conceptId || !title || shortName.toLowerCase() !== target.shortName.toLowerCase()) {
    throw new Error("NASA CMR returned an invalid or mismatched collection entry");
  }
  const boundingBoxes = boxes(entry.boxes);
  return {
    targetId: target.id,
    targetLabel: target.label,
    shortName,
    version,
    conceptId,
    title,
    timeStart: text(entry.time_start) ?? null,
    timeEnd: text(entry.time_end) ?? null,
    links: links(entry.links),
    ...(boundingBoxes.length === 1 ? { bbox: boundingBoxes[0] } : {}),
    boundingBoxes,
    catalogUrl: `https://cmr.earthdata.nasa.gov/search/concepts/${encodeURIComponent(conceptId)}.html`,
    access: "metadata_only",
    retrievedAt,
    sourceResource: target.sourceResource,
    resourceUrl: target.resourceUrl
  };
}

/**
 * Search six curated environmental short names, retaining every returned version.
 * This bounded inventory is global metadata, not all NASA collections/granules.
 * See https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html.
 */
export async function discoverCollections(options: DiscoveryOptions = {}): Promise<CollectionDiscovery> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Catalog timeout must be an integer from 1 to 60000 ms");
  options.signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const retrievedAt = new Date().toISOString();
  const searches = await Promise.all(CATALOG_TARGETS.map(async target => {
    const url = new URL(CMR_SEARCH);
    url.searchParams.set("short_name", target.shortName);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    url.searchParams.set("include_has_granules", "true");
    const queryUrl = url.toString();
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, { signal, headers: { Accept: "application/json", "Client-Id": "goofy-goobers-environment-catalog" } });
      if (!response.ok) throw new Error(`NASA CMR returned HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const entries = object(object(payload)?.feed)?.entry;
      if (!Array.isArray(entries)) throw new Error("NASA CMR returned an invalid feed");
      if (entries.length > PAGE_SIZE) throw new Error("NASA CMR exceeded the bounded page size");
      const records = entries.map(entry => normalizeEntry(entry, target, retrievedAt));
      const hitsHeader = response.headers.get("CMR-Hits");
      const hitCount = hitsHeader === null ? NaN : Number(hitsHeader);
      const totalHits = Number.isInteger(hitCount) && hitCount >= 0 ? hitCount : null;
      // CMR can return a search-after cursor even for a complete short page.
      // Its hit count, not cursor presence, determines whether this bounded page truncates results.
      const moreResults = totalHits !== null ? totalHits > records.length : records.length === PAGE_SIZE;
      const status: CatalogTargetStatus = {
        targetId: target.id,
        status: moreResults ? "truncated" : records.length ? "found" : "not_found",
        queryUrl,
        returnedCount: records.length,
        totalHits
      };
      return { records, status };
    } catch (error) {
      options.signal?.throwIfAborted();
      return {
        records: [] as CollectionInventory[],
        status: {
          targetId: target.id, status: "error" as const, queryUrl, returnedCount: 0, totalHits: null,
          error: { code: "UPSTREAM_ERROR" as const, message: (error instanceof Error ? error.message : "NASA CMR request failed").slice(0, 240) }
        }
      };
    }
  }));
  return {
    schemaVersion: "1.0", provider: "NASA CMR", access: "metadata_only",
    queryScope: "curated_environmental_collections", versionSelection: "all_returned_versions", retrievedAt,
    completeForCuratedTargets: searches.every(search => search.status.status === "found"),
    records: searches.flatMap(search => search.records),
    targets: searches.map(search => search.status)
  };
}
