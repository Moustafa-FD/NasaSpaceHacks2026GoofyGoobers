import { EnvironmentStore } from "./store.ts";

export class LibraryQueryError extends Error {}
const SOURCE_KEYS = { osm: "facilities-osm", npri: "emissions-npri", "epa-nei": "emissions-epa-nei" } as const;
type Row = Record<string, any>;
type Snapshot = { key: string; data: Row };
const retrieved = (data: Row) => Number.isFinite(Date.parse(data.retrievedAt)) ? Date.parse(data.retrievedAt) : 0;
const ordered = (snapshots: Snapshot[]) => [...snapshots].sort((a, b) => retrieved(a.data) - retrieved(b.data) || a.key.localeCompare(b.key));
const reportIdentity = (facilityId: unknown, year: unknown) => typeof facilityId === "string" && typeof year === "number" && Number.isInteger(year) ? `${facilityId}\u0000${year}` : undefined;

/** Preserve the broader canonical alias; every acquisition is also kept by scope. */
export function shouldReplaceNpriCanonical(previous: Row | undefined, next: Row): boolean {
  if (!previous) return true;
  if (previous.complete === true && next.complete !== true) return false;
  const before = previous.coverage ?? {}, after = next.coverage ?? {};
  const bounds = [before.requestedStartYear, before.requestedEndYear, after.requestedStartYear, after.requestedEndYear];
  if (bounds.every(value => typeof value === "number" && Number.isInteger(value))) {
    if (after.requestedStartYear > before.requestedStartYear || after.requestedEndYear < before.requestedEndYear) return false;
    return next.complete === true || (after.downloadedReports ?? next.reports?.length ?? 0) >= (before.downloadedReports ?? previous.reports?.length ?? 0);
  }
  const identities = (data: Row) => new Set((data.reports ?? data.records ?? []).map((row: Row) => reportIdentity(row.facilityId, row.year)).filter(Boolean));
  const nextReports = identities(next);
  return [...identities(previous)].every(identity => nextReports.has(identity));
}

function npriUnion(snapshots: Snapshot[]): Row | undefined {
  if (!snapshots.length) return undefined;
  const sorted = ordered(snapshots), latest = sorted.at(-1)!.data;
  const reports = new Map<string, { report: Row; snapshot: Snapshot; records: Row[] }>();
  const facilities = new Map<string, { facility: Row; snapshot: Snapshot }>();
  for (const snapshot of sorted) {
    const bounds = snapshot.data.coverage ?? {};
    const completeScope = snapshot.data.complete === true && bounds.truncated !== true
      && Number.isInteger(bounds.requestedStartYear) && Number.isInteger(bounds.requestedEndYear)
      && bounds.requestedStartYear <= bounds.requestedEndYear;
    // An exhausted query is authoritative for absence within its full year
    // range, including a successful refresh that now returns zero reports.
    if (completeScope) for (const [identity, { report }] of reports) {
      if (report.year >= bounds.requestedStartYear && report.year <= bounds.requestedEndYear) reports.delete(identity);
    }
    // Legacy canonical snapshots may lack report metadata. New snapshots carry
    // explicit reports even for DNMC/no-substance reports, so absence of rows
    // in a newly fetched report replaces all older quantities for that report.
    const sourceReports: Row[] = snapshot.data.reports ?? [...new Map<string, Row>((snapshot.data.records ?? []).map((row: Row) => [reportIdentity(row.facilityId, row.year) ?? row.id, { facilityId: row.facilityId, year: row.year }])).values()];
    for (const report of sourceReports) {
      const identity = reportIdentity(report.facilityId, report.year);
      if (identity) {
        const rows = (snapshot.data.records ?? []).filter((row: Row) => reportIdentity(row.facilityId, row.year) === identity);
        // New NPRI adapters fetch each listed report in full, even when the
        // overall report-count cap truncates the query. Legacy partial rows
        // without report metadata cannot establish absence of other pollutants.
        const replaceReport = Array.isArray(snapshot.data.reports) || snapshot.data.complete === true;
        const retained = replaceReport ? rows : [...new Map<string, Row>([...(reports.get(identity)?.records ?? []), ...rows].map(row => [row.id, row])).values()];
        reports.set(identity, { report, snapshot, records: retained });
      }
    }
    for (const facility of snapshot.data.facilities ?? []) {
      const previous = facilities.get(facility.id);
      const year = facility.locationReportYear ?? Math.max(0, ...(facility.reportYears ?? []));
      const priorYear = previous?.facility.locationReportYear ?? Math.max(0, ...(previous?.facility.reportYears ?? []));
      if (!previous || year > priorYear || (year === priorYear && retrieved(snapshot.data) >= retrieved(previous.snapshot.data))) facilities.set(facility.id, { facility, snapshot });
    }
  }
  const records: Row[] = [];
  for (const report of reports.values()) records.push(...report.records);
  records.sort((a, b) => b.year - a.year || String(a.facilityId).localeCompare(String(b.facilityId)) || String(a.id).localeCompare(String(b.id)));
  const retainedFacilityIds = new Set([...reports.values()].map(({ report }) => report.facilityId));
  const mergedFacilities = [...facilities.values()].filter(({ facility }) => retainedFacilityIds.has(facility.id)).map(({ facility }): Row => ({ ...facility, reportYears: [...new Set([...reports.values()].filter(({ report }) => report.facilityId === facility.id).map(({ report }) => report.year))].sort((a, b) => a - b) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cachedScopes = sorted.map(({ key, data }) => ({ key, retrievedAt: data.retrievedAt, complete: data.complete === true, coverage: data.coverage ?? null, rawRecord: data.rawRecord ?? null, rawSha256: data.rawSha256 ?? null }));
  return { ...latest, raw: undefined, rawRecord: undefined, rawSha256: undefined, sourceRevision: undefined,
    complete: sorted.every(({ data }) => data.complete === true),
    coverage: { globalCoverage: false, geographicScope: "Canada NPRI reporting facilities in the cached scopes only", sectorCode: "518210", selectionBasis: "NAICS sector candidates, not independently verified datacenters", cachedReportCount: reports.size, cachedScopes },
    reports: [...reports.values()].map(({ report }) => report).sort((a, b) => b.year - a.year || String(a.facilityId).localeCompare(String(b.facilityId))), facilities: mergedFacilities, records,
    sourceDocuments: [...new Map(sorted.flatMap(({ data }) => (data.sourceDocuments ?? []).map((document: Row) => [`${document.url}\u0000${document.sha256}`, document] as const))).values()],
    provenance: { type: "cached_scope_union", snapshots: cachedScopes },
    warnings: [...new Set([...sorted.flatMap(({ data }) => data.warnings ?? []), "Complete cached queries replace older reports in their requested year ranges, including absent reports; truncated queries replace only explicitly downloaded full reports. Completeness concerns the listed cached scopes, never all Canadian facilities or global emissions."])] };
}

function epaUnion(snapshots: Snapshot[]): Row | undefined {
  if (!snapshots.length) return undefined;
  const sorted = ordered(snapshots);
  const groups = new Map<string, Row[]>();
  for (const { data } of sorted) {
    const completeScope = data.completeness === "complete_filtered_api_result_not_facility_census";
    const state = typeof data.scope?.state === "string" ? data.scope.state.toUpperCase() : null;
    if (completeScope) for (const [identity, rows] of groups) {
      if (rows.some(record => record.reportingYear === data.reportingYear
        && (state === null || record.facility?.state?.toUpperCase() === state))) groups.delete(identity);
    }
    const current = new Map<string, Row[]>();
    for (const record of data.records ?? []) {
      const identity = reportIdentity(record.facility?.id, record.reportingYear ?? data.reportingYear);
      if (!identity) continue;
      const rows = current.get(identity) ?? [];
      rows.push(record.reportingYear === undefined ? { ...record, reportingYear: data.reportingYear } : record);
      current.set(identity, rows);
    }
    for (const [identity, rows] of current) {
      const retained = completeScope ? rows : [...new Map<string, Row>([...(groups.get(identity) ?? []), ...rows].map(record => [record.id, record])).values()];
      groups.set(identity, retained);
    }
  }
  const records = [...new Map<string, Row>([...groups.values()].flat().map(record => [record.id, record])).values()].sort((a, b) => (b.reportingYear ?? 0) - (a.reportingYear ?? 0) || String(a.facility?.id).localeCompare(String(b.facility?.id)) || String(a.id).localeCompare(String(b.id)));
  const reportingYears = [...new Set(sorted.map(({ data }) => data.reportingYear))].sort((a, b) => a - b);
  const latestYear = reportingYears.at(-1);
  const latest = [...sorted].reverse().find(({ data }) => data.reportingYear === latestYear)!.data;
  const cachedScopes = sorted.map(({ key, data }) => ({ key, reportingYear: data.reportingYear, scope: data.scope ?? { country: "US", state: null }, retrievedAt: data.retrievedAt, completeness: data.completeness, rawRecord: data.rawRecord ?? null, rawSha256: data.rawSha256 ?? null }));
  const nationwideYears = reportingYears.filter(year => sorted.some(({ data }) => data.reportingYear === year && !data.scope?.state && data.completeness === "complete_filtered_api_result_not_facility_census"));
  return { ...latest, raw: undefined, rawRecord: undefined, rawSha256: undefined, reportingYears, records,
    complete: nationwideYears.length === reportingYears.length,
    scope: { country: "US", type: "cached_scopes", state: null },
    coverage: { globalCoverage: false, country: "US", cachedScopes, nationwideYears, regionalOnlyYears: reportingYears.filter(year => !nationwideYears.includes(year)) },
    counts: { ...latest.counts, records: records.length, facilities: new Set(records.map(record => record.facility?.id)).size, pollutants: new Set(records.map(record => record.pollutant?.code)).size, missingQuantities: records.filter(record => record.quantity === null).length, missingUnits: records.filter(record => record.unit === null).length, unlocatedRecords: records.filter(record => record.facility?.latitude === null).length },
    historySnapshots: reportingYears.map(reportingYear => ({ reportingYear, scopes: cachedScopes.filter(scope => scope.reportingYear === reportingYear) })), provenance: { type: "cached_scope_union", snapshots: cachedScopes },
    warnings: [...new Set([...sorted.flatMap(({ data }) => data.warnings ?? []), "Complete national/state snapshots replace prior records in their inventory year and geographic scope, including removed facilities. Partial snapshots update only returned record identities. Regional-only years do not establish nationwide coverage."])] };
}

export async function sourceSnapshots(store: EnvironmentStore) {
  const [entries, keys] = await Promise.all([Promise.all(Object.entries(SOURCE_KEYS).map(async ([source, key]) => ({ source, data: await store.read<Row>(store.processedDirectory, key) }))), store.list(store.processedDirectory)]);
  const scoped = await Promise.all(keys.filter(key => /^emissions-(?:npri-scope-[a-f0-9]{64}|epa-nei-(?:year-\d{4}|state-[A-Z]{2}-\d{4}))$/.test(key)).sort().map(async key => ({ key, data: await store.read<Row>(store.processedDirectory, key) })));
  for (const source of ["npri", "epa-nei"] as const) {
    const entry = entries.find(value => value.source === source)!;
    const snapshots: Snapshot[] = scoped.filter((value): value is Snapshot => Boolean(value.data) && value.key.startsWith(`emissions-${source}-`));
    if (entry.data) snapshots.push({ key: SOURCE_KEYS[source], data: entry.data });
    entry.data = source === "npri" ? npriUnion(snapshots) : epaUnion(snapshots);
  }
  return entries;
}
export async function libraryInventory(store: EnvironmentStore) {
  return (await sourceSnapshots(store)).map(({ source, data }) => ({ source, status: data ? "downloaded_snapshot" : "not_synced", retrievedAt: data?.retrievedAt ?? null,
    records: source === "osm" ? data?.facilities?.length ?? 0 : data?.records?.length ?? 0,
    reportedQuantities: source === "osm" ? null : data?.records?.filter((record: Row) => typeof (record.amount ?? record.quantity) === "number").length ?? 0,
    complete: data?.complete ?? Boolean(data && (source === "osm" || data.completeness === "complete_filtered_api_result_not_facility_census")), coverage: data?.coverage ?? data?.scope ?? null, reportingYears: data?.reportingYears ?? null, license: data?.license ?? null }));
}
export async function queryLibrary(store: EnvironmentStore, params: URLSearchParams, kind: "facilities" | "emissions") {
  const allowed = kind === "facilities" ? ["source", "q", "id", "country", "bbox", "limit", "offset"] : ["source", "facilityId", "year", "pollutant", "medium", "limit", "offset"];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length > 1) throw new LibraryQueryError("Unknown or duplicate library query parameter");
  const source = params.get("source");
  if (source && !Object.keys(SOURCE_KEYS).includes(source)) throw new LibraryQueryError("source must be osm, npri or epa-nei");
  function integer(key: string, fallback: number, maximum: number) { const text = params.get(key); if (text === null) return fallback; if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > maximum || (key === "limit" && Number(text) < 1)) throw new LibraryQueryError(`Invalid ${key}`); return Number(text); }
  const limit = integer("limit", 100, 500), offset = integer("offset", 0, 1_000_000);
  for (const [key, value] of params) if (value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new LibraryQueryError(`Invalid ${key}`);
  const country = params.get("country"); if (country && !/^[A-Za-z]{2}$/.test(country)) throw new LibraryQueryError("country must be an ISO two-letter code");
  let bbox: number[] | undefined;
  if (params.has("bbox")) { bbox = params.get("bbox")!.split(",").map(Number); if (params.get("bbox")!.split(",").some(value => !value.trim()) || bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new LibraryQueryError("bbox must be ordered west,south,east,north"); }
  const year = params.get("year"); if (year && (!/^\d{4}$/.test(year) || Number(year) < 1993 || Number(year) > new Date().getUTCFullYear())) throw new LibraryQueryError("Invalid inventory year");
  const medium = params.get("medium"); if (medium && !["air", "water", "land", "all_media"].includes(medium)) throw new LibraryQueryError("Unknown release medium");
  const snapshots = (await sourceSnapshots(store)).filter(entry => !source || entry.source === source);
  const rows: Row[] = [];
  for (const entry of snapshots) {
    const data = entry.data; if (!data) continue;
    if (kind === "facilities") {
      if (entry.source === "osm" || entry.source === "npri") rows.push(...(data.facilities ?? []).map((facility: Row) => ({ ...facility, sourceId: entry.source, countryCode: entry.source === "osm" ? facility.address?.country ?? null : facility.countryCode })));
      else {
        const unique = new Map<string, Row>();
        for (const record of data.records ?? []) {
          const facility = record.facility;
          if (facility && !unique.has(facility.id)) unique.set(facility.id, { ...facility, location: { latitude: facility.latitude ?? null, longitude: facility.longitude ?? null }, countryCode: "US", sourceId: entry.source, metadataReportingYear: record.reportingYear ?? data.reportingYear, classification: "sector_candidate_unverified" });
        }
        rows.push(...unique.values());
      }
    } else if (entry.source !== "osm") {
      rows.push(...(data.records ?? []).map((record: Row) => entry.source === "npri" ? { ...record, sourceId: entry.source } : { ...record, sourceId: entry.source, facilityId: record.facility?.id, year: record.reportingYear ?? data.reportingYear, medium: "air", amount: record.quantity, units: record.unit }));
    }
  }
  const query = params.get("q")?.toLowerCase(); const pollutant = params.get("pollutant")?.toLowerCase();
  const filtered = rows.filter(row => {
    if (kind === "facilities") {
      if (params.has("id") && row.id !== params.get("id")) return false;
      if (country && row.countryCode?.toUpperCase() !== country.toUpperCase()) return false;
      if (query && ![row.name, row.operator, row.company, row.city, row.address?.city].some(value => typeof value === "string" && value.toLowerCase().includes(query))) return false;
      if (bbox) { const point = row.location; if (!point || point.latitude === null || point.longitude === null || point.longitude < bbox[0] || point.longitude > bbox[2] || point.latitude < bbox[1] || point.latitude > bbox[3]) return false; }
    } else {
      if (params.has("facilityId") && row.facilityId !== params.get("facilityId")) return false;
      if (year && row.year !== Number(year)) return false;
      if (medium && row.medium !== medium) return false;
      if (pollutant && !String(row.pollutant?.name ?? "").toLowerCase().includes(pollutant) && String(row.pollutant?.code ?? row.pollutant?.id ?? "").toLowerCase() !== pollutant) return false;
    }
    return true;
  });
  return { schemaVersion: "1.0", kind, total: filtered.length, limit, offset, nextOffset: offset + limit < filtered.length ? offset + limit : null, sources: snapshots.map(entry => ({ id: entry.source, status: entry.data ? "downloaded_snapshot" : "not_synced", retrievedAt: entry.data?.retrievedAt ?? null, license: entry.data?.license ?? null })), records: filtered.slice(offset, offset + limit),
    warnings: ["Source identities are kept separate; records are not automatically joined by name or proximity.", "OSM elements can represent the same physical campus; sector-filtered regulatory records are candidates requiring facility verification.", "OSM country filtering uses sparse explicit country tags; use bbox for geographic coverage when country tags are missing.", "Emissions quantities, units, years and media remain separate; no cross-pollutant totals or facility-causation claims are calculated."] };
}
