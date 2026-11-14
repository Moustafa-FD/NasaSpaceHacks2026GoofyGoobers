import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { EnvironmentStore } from "../apps/api/src/environment/store.ts";
import { libraryInventory, queryLibrary, shouldReplaceNpriCanonical, sourceSnapshots } from "../apps/api/src/environment/library.ts";
import { environmentExecutor } from "../apps/api/src/environment/service.ts";

class MemoryStore extends EnvironmentStore {
  values = new Map<string, unknown>();
  constructor() { super(tmpdir()); }
  override async read<T>(directory: string, key: string): Promise<T | undefined> { return structuredClone(this.values.get(`${directory}/${key}`)) as T | undefined; }
  override async write(directory: string, key: string, value: unknown): Promise<void> { this.values.set(`${directory}/${key}`, structuredClone(value)); }
  override async list(directory: string): Promise<string[]> { return [...this.values.keys()].filter(key => key.startsWith(`${directory}/`)).map(key => key.slice(directory.length + 1)); }
}
type Row = Record<string, any>;
const oldTime = "2026-11-13T00:00:00Z", newTime = "2026-11-14T00:00:00Z";
function npri(years: number[], retrievedAt = oldTime, complete = true): Row {
  return { retrievedAt, complete, sourceId: "canada-npri", coverage: { requestedStartYear: Math.min(...years), requestedEndYear: Math.max(...years), downloadedReports: years.length, truncated: !complete },
    facilities: [{ id: "npri:1", name: "Canadian candidate", countryCode: "CA", location: { latitude: 45, longitude: -73 }, locationReportYear: Math.max(...years), reportYears: years }],
    reports: years.map(year => ({ facilityId: "npri:1", year, reportTypes: ["NPRI Inventory"] })),
    records: years.map(year => ({ id: `npri:1:${year}:1:air`, facilityId: "npri:1", year, amount: year - 2000, units: "tonnes", medium: "air", pollutant: { id: 1, name: "Synthetic pollutant" } })), rawRecord: `raw-${retrievedAt}`, rawSha256: `hash-${retrievedAt}` };
}
function epa(year: number, retrievedAt: string, state: string | null, ids = ["1"]): Row {
  return { retrievedAt, reportingYear: year, completeness: "complete_filtered_api_result_not_facility_census", scope: { country: "US", state },
    records: ids.map(id => ({ id: `epa-nei/${year}/${id}/NOX/CAP/TON`, reportingYear: year, facility: { id: `eis/${id}`, name: `Facility ${year}`, latitude: 39, longitude: -77, state: state ?? "VA" }, pollutant: { code: "NOX", name: "Nitrogen oxides" }, quantity: 1, unit: "TON" })) };
}
async function put(store: MemoryStore, key: string, data: Row) { await store.write(store.processedDirectory, key, data); }
const scopeKey = (store: MemoryStore, label: string) => `emissions-npri-scope-${store.key(label)}`;

test("NPRI newest facility-year report replaces older quantities, including DNMC reports", async () => {
  const store = new MemoryStore();
  const broad = npri([2023, 2024, 2025]);
  const update = npri([2024], newTime);
  update.reports[0].reportTypes = ["NPRI DNMC"]; update.records = [];
  update.facilities[0].name = "Older location-report year"; update.facilities[0].location.latitude = 44;
  await put(store, "emissions-npri", broad); await put(store, scopeKey(store, "narrow"), update);
  const snapshots = await sourceSnapshots(store); const data = snapshots.find(row => row.source === "npri")!.data!;
  assert.deepEqual(data.records.map((row: Row) => row.year), [2025, 2023]);
  assert.equal(data.reports.find((row: Row) => row.year === 2024).reportTypes[0], "NPRI DNMC");
  assert.equal(data.facilities[0].name, "Canadian candidate", "Highest location report year must win over a newer retrieval of an older year");
  assert.deepEqual(data.facilities[0].reportYears, [2023, 2024, 2025]);
  assert.equal(data.rawSha256, undefined, "A merged dataset must not reuse one source snapshot's hash");
  assert.equal(data.provenance.snapshots.length, 2);
});

test("NPRI same-year facility metadata uses latest retrieval and partial scope completeness remains explicit", async () => {
  const store = new MemoryStore(); const before = npri([2024]); const after = npri([2024], newTime, false);
  after.facilities[0].name = "Updated name"; after.facilities[0].location.latitude = 46; after.records[0].amount = null;
  await put(store, "emissions-npri", before); await put(store, scopeKey(store, "partial"), after);
  const result = await queryLibrary(store, new URLSearchParams("source=npri"), "emissions");
  assert.equal(result.total, 1); assert.equal(result.records[0].amount, null);
  const facilities = await queryLibrary(store, new URLSearchParams("source=npri"), "facilities");
  assert.equal(facilities.records[0].name, "Updated name"); assert.equal(facilities.records[0].location.latitude, 46);
  const inventory = (await libraryInventory(store)).find(row => row.source === "npri")!;
  assert.equal(inventory.complete, false); assert.equal(inventory.coverage.globalCoverage, false); assert.equal(inventory.coverage.cachedScopes.length, 2);
});

test("NPRI canonical replacement preserves broader complete coverage", () => {
  const broad = npri([2023, 2024, 2025]);
  assert.equal(shouldReplaceNpriCanonical(broad, npri([2025], newTime)), false);
  assert.equal(shouldReplaceNpriCanonical(broad, npri([2023, 2024, 2025], newTime, false)), false);
  assert.equal(shouldReplaceNpriCanonical(broad, npri([2022, 2023, 2024, 2025], newTime)), true);
  assert.equal(shouldReplaceNpriCanonical(undefined, broad), true);
});

test("the NPRI executor retains a bounded scope without overwriting its broader canonical snapshot", async t => {
  const store = new MemoryStore(); const broad = npri([2023, 2024, 2025]); await put(store, "emissions-npri", broad);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input)); const path = url.pathname.split("/npri/")[1];
    if (path === "Data/ReportYears") return Response.json([2023, 2024, 2025]);
    if (path === "Data/PublishDate") return Response.json({ reportYear: 2025, isPreliminaryData: true });
    if (path === "Search") return Response.json({ recordsFiltered: 1, data: [{ npriID: 1, year: 2025, facility: "Candidate", naics: { id: 518210 } }] });
    if (path === "Details/Report") return Response.json({ npriId: 1, reportYear: 2025, reportTypes: [{ en: "NPRI DNMC" }], facility: { name: "Candidate", industry: { naics6Primary: { id: 518210 } } }, substanceSummary: [] });
    throw new Error(`Unexpected fixture URL ${url}`);
  });
  const request = { schemaVersion: "1.0", kind: "emissions-sync", source: "npri", startYear: 2025, endYear: 2025, maxReports: 1 } as const;
  await environmentExecutor(store)(request, new AbortController().signal, () => {});
  assert.deepEqual(await store.read(store.processedDirectory, "emissions-npri"), broad);
  const saved = await store.read<Row>(store.processedDirectory, `emissions-npri-scope-${store.key(request)}`);
  assert.deepEqual(saved!.reports[0].reportTypes, ["NPRI DNMC"]);
  assert.equal(saved!.records.length, 0);
  assert.equal((await queryLibrary(store, new URLSearchParams("source=npri&year=2025"), "emissions")).total, 0);
});

test("EPA state-only snapshots are queryable and report regional-only coverage", async () => {
  const store = new MemoryStore(); await put(store, "emissions-epa-nei-state-VA-2023", epa(2023, newTime, "VA"));
  assert.equal((await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2023"), "emissions")).total, 1);
  const inventory = (await libraryInventory(store)).find(row => row.source === "epa-nei")!;
  assert.equal(inventory.status, "downloaded_snapshot"); assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.coverage.nationwideYears, []); assert.deepEqual(inventory.coverage.regionalOnlyYears, [2023]);
});

test("EPA national/state refreshes replace whole facility-years, deduplicate IDs and preserve newest-year metadata", async () => {
  const store = new MemoryStore(); const national = epa(2023, oldTime, null, ["1", "2"]);
  national.records[1].facility.state = "MD";
  national.records.push({ ...national.records[0], id: "epa-nei/2023/1/PM25/CAP/TON", pollutant: { code: "PM25", name: "Fine particles" }, quantity: 9 });
  const state = epa(2023, newTime, "VA"); state.records[0].quantity = 7; state.records[0].facility.name = "Latest facility name";
  await put(store, "emissions-epa-nei", national); await put(store, "emissions-epa-nei-year-2023", national); await put(store, "emissions-epa-nei-state-VA-2023", state);
  await put(store, "emissions-epa-nei-year-2020", epa(2020, "2026-11-15T00:00:00Z", null));
  const emissions = await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2023"), "emissions");
  assert.equal(emissions.total, 2, "Refreshed facility 1 drops its stale PM25 row; facility 2 remains retained");
  assert.equal(emissions.records.find((row: Row) => row.facilityId === "eis/1")!.amount, 7);
  const facilities = await queryLibrary(store, new URLSearchParams("source=epa-nei&id=eis%2F1"), "facilities");
  assert.equal(facilities.total, 1); assert.equal(facilities.records[0].name, "Latest facility name"); assert.equal(facilities.records[0].metadataReportingYear, 2023);
  assert.equal((await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2020"), "emissions")).total, 1);
  assert.deepEqual((await libraryInventory(store)).find(row => row.source === "epa-nei")!.reportingYears, [2020, 2023]);
});

test("a complete empty EPA state refresh removes only that state and inventory year", async () => {
  const store = new MemoryStore(); const national = epa(2023, oldTime, null, ["1", "2"]);
  national.records[1].facility.state = "MD";
  await put(store, "emissions-epa-nei-year-2023", national);
  await put(store, "emissions-epa-nei-year-2020", epa(2020, oldTime, null));
  await put(store, "emissions-epa-nei-state-VA-2023", epa(2023, newTime, "VA", []));
  const current = await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2023"), "emissions");
  assert.equal(current.total, 1); assert.equal(current.records[0].facilityId, "eis/2");
  assert.equal((await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2020"), "emissions")).total, 1);
  const facility = await queryLibrary(store, new URLSearchParams("source=epa-nei&id=eis%2F1"), "facilities");
  assert.equal(facility.records[0].metadataReportingYear, 2020, "Removed 2023 metadata must not mask the retained historical record");
});

test("a complete EPA national refresh removes absent facilities and pollutant rows", async () => {
  const store = new MemoryStore(); const previous = epa(2023, oldTime, null, ["1", "2"]);
  previous.records.push({ ...previous.records[0], id: "epa-nei/2023/1/PM25/CAP/TON", pollutant: { code: "PM25" }, quantity: 9 });
  const latest = epa(2023, newTime, null); latest.records[0].quantity = 7;
  await put(store, "emissions-epa-nei", previous);
  await put(store, "emissions-epa-nei-state-VA-2023", epa(2023, oldTime, "VA", ["3"]));
  await put(store, "emissions-epa-nei-year-2023", latest);
  const current = await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2023"), "emissions");
  assert.equal(current.total, 1); assert.equal(current.records[0].facilityId, "eis/1"); assert.equal(current.records[0].amount, 7);
  assert.equal((await queryLibrary(store, new URLSearchParams("source=epa-nei"), "facilities")).total, 1);
});

test("partial EPA snapshots cannot erase unseen facilities or pollutants", async () => {
  const store = new MemoryStore(); const previous = epa(2023, oldTime, null, ["1", "2"]);
  previous.records.push({ ...previous.records[0], id: "epa-nei/2023/1/PM25/CAP/TON", pollutant: { code: "PM25" }, quantity: 9 });
  const partial = epa(2023, newTime, "VA"); partial.completeness = "partial_result"; partial.records[0].quantity = 7;
  await put(store, "emissions-epa-nei", previous); await put(store, "emissions-epa-nei-state-VA-2023", partial);
  const current = await queryLibrary(store, new URLSearchParams("source=epa-nei&year=2023"), "emissions");
  assert.equal(current.total, 3);
  assert.equal(current.records.find((row: Row) => row.facilityId === "eis/1" && row.pollutant.code === "NOX")!.amount, 7);
  assert.equal(current.records.find((row: Row) => row.pollutant.code === "PM25")!.amount, 9);
});

test("a complete empty NPRI year refresh removes absent reports and orphan facilities only within that year", async () => {
  const store = new MemoryStore(); const previous = npri([2022, 2023, 2024]);
  previous.facilities.push({ ...previous.facilities[0], id: "npri:2", locationReportYear: 2023, reportYears: [2023] });
  previous.reports.push({ facilityId: "npri:2", year: 2023 });
  previous.records.push({ ...previous.records[1], id: "npri:2:2023:1:air", facilityId: "npri:2" });
  const empty = npri([2023], newTime); empty.reports = []; empty.records = []; empty.facilities = []; empty.coverage.downloadedReports = 0;
  await put(store, "emissions-npri", previous); await put(store, scopeKey(store, "empty-2023"), empty);
  const current = await queryLibrary(store, new URLSearchParams("source=npri"), "emissions");
  assert.deepEqual(current.records.map((row: Row) => row.year), [2024, 2022]);
  assert.equal((await queryLibrary(store, new URLSearchParams("source=npri&year=2023"), "emissions")).total, 0);
  const facilities = await queryLibrary(store, new URLSearchParams("source=npri"), "facilities");
  assert.equal(facilities.total, 1); assert.deepEqual(facilities.records[0].reportYears, [2022, 2024]);
});

test("truncated NPRI queries retain unseen report years and legacy partial rows retain unseen pollutants", async () => {
  const store = new MemoryStore(); const previous = npri([2022, 2023, 2024]);
  previous.records.push({ ...previous.records[1], id: "npri:1:2023:2:air", pollutant: { id: 2 }, amount: 9 });
  const partial = npri([2023], newTime, false); delete partial.reports;
  partial.coverage.requestedStartYear = 2022; partial.coverage.requestedEndYear = 2024; partial.records[0].amount = 7;
  await put(store, "emissions-npri", previous); await put(store, scopeKey(store, "truncated"), partial);
  const current = await queryLibrary(store, new URLSearchParams("source=npri"), "emissions");
  assert.equal(current.total, 4);
  assert.equal(current.records.find((row: Row) => row.year === 2023 && row.pollutant.id === 1)!.amount, 7);
  assert.equal(current.records.find((row: Row) => row.year === 2023 && row.pollutant.id === 2)!.amount, 9);
  assert.deepEqual(new Set(current.records.map((row: Row) => row.year)), new Set([2022, 2023, 2024]));
});

test("legacy canonical-only EPA and NPRI snapshots remain readable", async () => {
  const store = new MemoryStore(); const canada = npri([2024]); delete canada.reports;
  await put(store, "emissions-npri", canada); await put(store, "emissions-epa-nei", epa(2023, oldTime, null));
  assert.equal((await queryLibrary(store, new URLSearchParams(), "emissions")).total, 2);
  assert.equal((await queryLibrary(store, new URLSearchParams(), "facilities")).total, 2);
});
