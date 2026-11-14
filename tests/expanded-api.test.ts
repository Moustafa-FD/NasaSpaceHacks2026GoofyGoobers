import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../apps/api/src/server.ts";
import { EnvironmentStore } from "../apps/api/src/environment/store.ts";
import type { EnvironmentExecutor } from "../apps/api/src/environment/service.ts";
import type { EnvironmentRequest, EnvironmentRun } from "../packages/contracts/src/environment.ts";

const fixtureExecutor: EnvironmentExecutor = async (request, _signal, report) => {
  report(60, `synthetic-fixture:${request.kind}`);
  return { evidence: "synthetic_test_fixture", kind: request.kind, request };
};
async function launch(t: TestContext, executor: EnvironmentExecutor | null = fixtureExecutor) {
  const root = await mkdtemp(join(tmpdir(), "spaceapps-expanded-"));
  const store = new EnvironmentStore(root);
  let api = await createApi({ store, ...(executor ? { executor } : {}) });
  const listen = async () => {
    await new Promise<void>(done => api.server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  };
  let base = await listen();
  t.after(async () => {
    await api.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("spaceapps-expanded-")) throw new Error("Refusing unexpected temporary cleanup path");
    await rm(root, { recursive: true, force: true });
  });
  return { store, get base() { return base; },
    get: (path: string) => fetch(new URL(path, base)),
    post: (body: unknown) => fetch(new URL("/v1/runs", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    restart: async () => { await api.close(); api = await createApi({ store, ...(executor ? { executor } : {}) }); base = await listen(); } };
}
type Client = Awaited<ReturnType<typeof launch>>;
async function json(client: Client, path: string): Promise<Record<string, any>> {
  const response = await client.get(path); assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json() as Promise<Record<string, any>>;
}
async function terminal(client: Client, path: string): Promise<EnvironmentRun> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = await json(client, path) as EnvironmentRun;
    if (run.status === "completed" || run.status === "failed") return run;
    await delay(10);
  }
  throw new Error("Expanded run did not reach a terminal state");
}

/** All cached rows below are synthetic and stay inside this test's temporary store. */
async function seed(client: Client) {
  const osm = { retrievedAt: "2026-11-14T00:00:00Z", completeness: "osm_query_snapshot_not_census", scope: { type: "global" }, license: { id: "ODbL-1.0" }, facilities: [
    { id: "osm/node/101", name: "Shared Campus", operator: "Fixture Operator", location: { latitude: 43.6, longitude: -79.3 }, address: { country: "CA", city: "Toronto" } },
    { id: "osm/way/102", name: "Shared Campus", operator: "US Fixture Operator", location: { latitude: 39, longitude: -77.5 }, address: { country: "US", city: "Ashburn" } },
    { id: "osm/relation/103", name: "Country tag missing", location: { latitude: 43.7, longitude: -79.4 }, address: { country: null, city: "Toronto" } },
    { id: "osm/node/104", name: "Unlocated mapped facility", location: { latitude: null, longitude: null }, address: { country: null, city: null } },
  ] };
  const npri = { retrievedAt: "2026-11-14T00:00:00Z", complete: true, coverage: { countryCode: "CA", sectorCode: "518210" }, facilities: [
    { id: "npri:101", name: "Shared Campus", company: "Fixture Operator", city: "Toronto", countryCode: "CA", location: { latitude: 43.6, longitude: -79.3 }, classification: { status: "sector_candidate", confirmedDatacenter: false } },
    { id: "npri:202", name: "Alberta Candidate", city: "Calgary", countryCode: "CA", location: { latitude: 51, longitude: -114 }, classification: { status: "sector_candidate", confirmedDatacenter: false } },
  ], records: [
    { id: "npri:101:2024:13506:air", facilityId: "npri:101", year: 2024, medium: "air", pollutant: { id: 13506, name: "Nitrogen oxides (expressed as nitrogen dioxide)" }, amount: 5, units: "tonnes", estimationBasis: { methods: [{ code: "E2" }] } },
    { id: "npri:101:2024:13506:water", facilityId: "npri:101", year: 2024, medium: "water", pollutant: { id: 13506, name: "Nitrogen oxides (expressed as nitrogen dioxide)" }, amount: null, units: "tonnes" },
    { id: "npri:202:2023:1:land", facilityId: "npri:202", year: 2023, medium: "land", pollutant: { id: 1, name: "Synthetic pollutant" }, amount: 0, units: "kilograms" },
  ] };
  const facility = { id: "eis/101", sourceId: "101", name: "Shared Campus", latitude: 39, longitude: -77.5, city: "Ashburn", state: "VA" };
  const epa = { retrievedAt: "2026-11-14T00:00:00Z", reportingYear: 2023, completeness: "complete_filtered_api_result_not_facility_census", scope: { country: "US", state: null }, records: [
    { id: "epa-nei/2023/101/NO2/CAP/TON", reportingYear: 2023, facility, pollutant: { code: "NO2", name: "Nitrogen dioxide" }, quantity: 2, unit: "TON", measurementMethod: "not_supplied_in_summary" },
    { id: "epa-nei/2023/101/PM25/CAP/TON", reportingYear: 2023, facility, pollutant: { code: "PM25", name: "Fine particulate matter" }, quantity: null, unit: "TON" },
    { id: "epa-nei/2023/303/NOX/CAP/TON", reportingYear: 2023, facility: { id: "eis/303", name: "Unlocated US candidate", latitude: null, longitude: null, city: null }, pollutant: { code: "NOX", name: "Nitrogen oxides" }, quantity: 0, unit: "TON" },
  ] };
  await Promise.all([client.store.write(client.store.processedDirectory, "facilities-osm", osm), client.store.write(client.store.processedDirectory, "emissions-npri", npri), client.store.write(client.store.processedDirectory, "emissions-epa-nei", epa)]);
  return { osm, npri, epa };
}

test("cached facility library keeps regulatory/map identities separate and country tags explicit", async t => {
  const client = await launch(t); await seed(client);
  const all = await json(client, "/v1/facilities"); assert.equal(all.total, 8);
  const shared = await json(client, "/v1/facilities?q=SHARED");
  assert.equal(shared.total, 4);
  assert.deepEqual(new Set(shared.records.map((row: any) => row.id)), new Set(["osm/node/101", "osm/way/102", "npri:101", "eis/101"]));
  const canada = await json(client, "/v1/facilities?country=ca"); assert.equal(canada.total, 3);
  assert.ok(!canada.records.some((row: any) => row.id === "osm/relation/103"));
  const region = await json(client, "/v1/facilities?bbox=-80,43,-78,44");
  assert.deepEqual(new Set(region.records.map((row: any) => row.id)), new Set(["osm/node/101", "osm/relation/103", "npri:101"]));
  assert.equal((await json(client, "/v1/facilities?source=osm&country=US")).total, 1);
  assert.equal((await json(client, "/v1/facilities?source=epa-nei&country=US")).total, 2);
  const candidate = await json(client, "/v1/facilities?id=npri%3A101");
  assert.equal(candidate.total, 1); assert.equal(candidate.records[0].sourceId, "npri");
  assert.equal(candidate.records[0].classification.confirmedDatacenter, false);
});

test("cached emissions filter exact source/facility/year/media and retain source units, zeroes and unknowns", async t => {
  const client = await launch(t); await seed(client);
  const no2 = await json(client, "/v1/emissions?source=epa-nei&facilityId=eis%2F101&year=2023&medium=air&pollutant=no2");
  assert.equal(no2.total, 1); assert.equal(no2.records[0].amount, 2); assert.equal(no2.records[0].units, "TON");
  assert.equal(no2.records[0].measurementMethod, "not_supplied_in_summary");
  const nox = await json(client, "/v1/emissions?source=npri&facilityId=npri%3A101&year=2024&medium=air&pollutant=13506");
  assert.equal(nox.total, 1); assert.equal(nox.records[0].amount, 5); assert.equal(nox.records[0].units, "tonnes");
  assert.equal(nox.records[0].estimationBasis.methods[0].code, "E2");
  assert.equal((await json(client, "/v1/emissions?source=npri&pollutant=NO2")).total, 0, "NOx must not silently become NO2");
  const missing = await json(client, "/v1/emissions?source=npri&medium=water"); assert.equal(missing.records[0].amount, null);
  const zero = await json(client, "/v1/emissions?source=npri&year=2023&medium=land"); assert.equal(zero.records[0].amount, 0); assert.equal(zero.records[0].units, "kilograms");
  const inventory = await json(client, "/v1/inventory");
  assert.equal(inventory.datasets.find((row: any) => row.source === "npri").reportedQuantities, 2);
  assert.equal(inventory.datasets.find((row: any) => row.source === "epa-nei").reportedQuantities, 2);
});

test("library pagination is bounded and invalid query parameters are client errors", async t => {
  const client = await launch(t); await seed(client);
  const first = await json(client, "/v1/facilities?limit=3&offset=0");
  const next = await json(client, `/v1/facilities?limit=3&offset=${first.nextOffset}`);
  assert.equal(first.total, 8); assert.equal(first.records.length, 3); assert.equal(first.nextOffset, 3); assert.equal(next.nextOffset, 6);
  assert.ok(first.records.every((row: any) => !next.records.some((other: any) => other.id === row.id)));
  const empty = await json(client, "/v1/facilities?offset=999"); assert.equal(empty.total, 8); assert.deepEqual(empty.records, []); assert.equal(empty.nextOffset, null);
  for (const path of ["/v1/facilities?source=other", "/v1/facilities?limit=0", "/v1/facilities?limit=501", "/v1/facilities?offset=-1", "/v1/facilities?offset=1000001", "/v1/facilities?country=Canada", "/v1/facilities?source=osm&source=npri", "/v1/facilities?bbox=0,,1,2", "/v1/facilities?bbox=10,0,-10,10", "/v1/facilities?bbox=-181,-90,180,90", "/v1/facilities?year=2023", "/v1/facilities?q=%00", `/v1/facilities?q=${"x".repeat(201)}`, "/v1/emissions?medium=soil", "/v1/emissions?year=2023.5", "/v1/emissions?year=2099", "/v1/emissions?pollutant=NOX&pollutant=NO2", "/v1/emissions?country=CA"]) {
    const response = await client.get(path); assert.equal(response.status, 400, path);
    assert.equal((await response.json() as any).error.code, "INVALID_LIBRARY_QUERY");
  }
});

test("EPA year snapshots preserve independently queryable histories and latest facility metadata", async t => {
  const client = await launch(t); const { epa } = await seed(client);
  const historical = { ...epa, reportingYear: 2020, records: [{ ...epa.records[0], id: "epa-nei/2020/101/NO2/CAP/TON", reportingYear: 2020, quantity: 1,
    facility: { ...epa.records[0].facility, name: "Historical former name", latitude: 38.5 } }] };
  await client.store.write(client.store.processedDirectory, "emissions-epa-nei-year-2020", historical);
  const latest = await json(client, "/v1/emissions?source=epa-nei&year=2023&pollutant=NO2");
  const old = await json(client, "/v1/emissions?source=epa-nei&year=2020&pollutant=NO2");
  assert.equal(latest.total, 1); assert.equal(latest.records[0].amount, 2); assert.equal(latest.records[0].year, 2023);
  assert.equal(old.total, 1); assert.equal(old.records[0].amount, 1); assert.equal(old.records[0].year, 2020);
  await client.store.write(client.store.processedDirectory, "emissions-epa-nei-year-2023", epa);
  assert.equal((await json(client, "/v1/emissions?source=epa-nei&year=2023&pollutant=NO2")).total, 1, "alias and same-year history must not duplicate rows");
  const facility = await json(client, "/v1/facilities?source=epa-nei&id=eis%2F101");
  assert.equal(facility.total, 1); assert.equal(facility.records[0].name, "Shared Campus"); assert.equal(facility.records[0].location.latitude, 39);
});

const point = { latitude: 43.65, longitude: -79.38 };
const agriculture = { schemaVersion: "1.0", kind: "agriculture", point, baseline: { start: "2000-01-01", end: "2001-12-31" }, future: { start: "2040-01-01", end: "2041-12-31" }, models: ["EC_Earth3P_HR"], growingMonths: [4, 5, 6, 7, 8, 9], baseTemperatureC: 10, heatThresholdC: 30, dryDayThresholdMm: 1 };

test("expanded job types complete through the actual API queue and retain requests/results across restart", async t => {
  const calls: EnvironmentRequest[] = [];
  const client = await launch(t, async (...args) => { calls.push(structuredClone(args[0])); return fixtureExecutor(...args); });
  const requests = [{ schemaVersion: "1.0", kind: "facilities-sync" }, { schemaVersion: "1.0", kind: "emissions-sync", source: "npri", startYear: 2023, endYear: 2024, maxReports: 3 },
    { schemaVersion: "1.0", kind: "emissions-sync", source: "epa-nei", year: 2023, state: "VA" }, { schemaVersion: "1.0", kind: "air-quality", point, start: "2024-01-01", end: "2024-01-02", variables: ["nitrogen_dioxide"] },
    { schemaVersion: "1.0", kind: "land-water", point, start: "2024-01-01", end: "2024-01-02" }, { schemaVersion: "1.0", kind: "climate", point, start: "2030-01-01", end: "2030-01-02", models: ["EC_Earth3P_HR", "MRI_AGCM3_2_S"] }, agriculture];
  let last: { statusUrl: string; resultUrl: string } | undefined;
  for (const request of requests) {
    const response = await client.post(request); assert.equal(response.status, 202, JSON.stringify(request));
    const job = await response.json() as { statusUrl: string; resultUrl: string }; last = job;
    const run = await terminal(client, job.statusUrl); assert.equal(run.status, "completed", run.error?.message); assert.equal(run.progress, 100);
    const result = await json(client, job.resultUrl); assert.equal(result.evidence, "synthetic_test_fixture"); assert.deepEqual(result.request, request);
  }
  assert.equal(calls.length, requests.length);
  await client.restart();
  assert.equal((await json(client, last!.statusUrl)).status, "completed"); assert.equal((await json(client, last!.resultUrl)).kind, "agriculture");
});

test("invalid expanded dates, cross-source fields, nonstring enums and unknown fields never execute", async t => {
  let calls = 0; const client = await launch(t, async (...args) => { calls++; return fixtureExecutor(...args); });
  const bad = [
    { schemaVersion: "1.0", kind: ["facilities-sync"] }, { schemaVersion: "1.0", kind: {} }, { schemaVersion: "1.0", kind: null },
    { schemaVersion: "1.0", kind: "facilities-sync", unexpected: true },
    { schemaVersion: "1.0", kind: "emissions-sync", source: ["npri"] }, { schemaVersion: "1.0", kind: "emissions-sync", source: "npri", year: 2023 },
    { schemaVersion: "1.0", kind: "emissions-sync", source: "npri", state: "VA" }, { schemaVersion: "1.0", kind: "emissions-sync", source: "epa-nei", startYear: 2023 },
    { schemaVersion: "1.0", kind: "emissions-sync", source: "epa-nei", maxReports: 3 }, { schemaVersion: "1.0", kind: "emissions-sync", source: "epa-nei", year: 2024 },
    { schemaVersion: "1.0", kind: "emissions-sync", source: "epa-nei", state: "ZZ" }, { schemaVersion: "1.0", kind: "emissions-sync", source: "npri", startYear: 2025, endYear: 2024 },
    { schemaVersion: "1.0", kind: "land-water", point, start: "2024-02-30", end: "2024-03-02" }, { schemaVersion: "1.0", kind: "land-water", point, start: "2024-01-01", end: "2040-01-01" },
    { schemaVersion: "1.0", kind: "climate", point, start: "2030-01-01", end: "2050-01-02" }, { schemaVersion: "1.0", kind: "climate", point, start: "2030-01-01", end: "2030-01-02", models: [["EC_Earth3P_HR"]] },
    { schemaVersion: "1.0", kind: "air-quality", point, start: "2024-01-01", end: "2024-01-02", variables: [["pm2_5"]] },
    { schemaVersion: "1.0", kind: "series", source: ["power-grid"], variables: ["T2M"], start: "2024-01", end: "2024-02", bbox: [-180, -90, 180, 90] },
    { ...agriculture, future: { start: "2040-01-02", end: "2041-12-31" } }, { ...agriculture, future: { start: "2020-01-01", end: "2021-12-31" } },
    { ...agriculture, heatThresholdC: undefined }, { ...agriculture, point: { ...point, unexpected: true } },
  ];
  for (const request of bad) {
    const response = await client.post(request); assert.equal(response.status, 422, JSON.stringify(request));
    assert.equal((await response.json() as any).error.code, "INVALID_ENVIRONMENT_REQUEST");
  }
  assert.equal(calls, 0); assert.deepEqual(await client.store.list(client.store.runsDirectory), []);
});

function groundFixture() {
  const provenance = { sourceUrl: "https://synthetic-evidence.invalid/never-fetched", recordId: "synthetic-fixture-1", method: "estimated", qualityFlag: "synthetic_test_fixture" };
  return { schemaVersion: "1.0", kind: "ground-evidence", records: [
    { domain: "water-quality", variable: "nitrate", unit: "mg/L", value: null, date: "2024-01-01T00:00:00Z", point, stationId: "synthetic-water", qualifiers: ["below-detection-limit"], detectionLimit: 0.1, provenance },
    { domain: "water-quality", variable: "synthetic-zero", unit: "mg/L", value: 0, date: "2024-01-01T00:00:00Z", point, stationId: "synthetic-zero", provenance: { ...provenance, recordId: "synthetic-fixture-2" } },
    { domain: "noise", variable: "LAeq", unit: "dB(A)", value: 42, date: "2024-01-01T00:00:00Z", point, stationId: "synthetic-noise", durationSeconds: 900, provenance: { ...provenance, recordId: "synthetic-fixture-3" } },
  ] };
}

test("real ground-evidence executor structurally validates and persists source records without fetching their URLs", async t => {
  const client = await launch(t, null); const request = groundFixture();
  const originalFetch = globalThis.fetch; let externalFetches = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "127.0.0.1") { externalFetches++; throw new Error("Ground import must not fetch its source reference"); }
    return originalFetch(input, init);
  });
  const response = await client.post(request); assert.equal(response.status, 202);
  const job = await response.json() as { statusUrl: string; resultUrl: string };
  const run = await terminal(client, job.statusUrl); assert.equal(run.status, "completed", run.error?.message);
  const result = await json(client, job.resultUrl);
  assert.equal(result.recordCount, 3); assert.deepEqual(result.records, request.records); assert.equal(result.evidence, "user-supplied");
  assert.equal(result.verification.status, "not_independently_verified"); assert.equal(result.verification.method, "structural_validation_only");
  assert.equal(result.records[0].value, null); assert.equal(result.records[1].value, 0); assert.equal(result.records[2].durationSeconds, 900);
  assert.equal(externalFetches, 0);
  const keys = await client.store.list(client.store.processedDirectory);
  assert.ok(keys.some(key => key.startsWith("evidence-")));
  const persisted = await client.store.read<Record<string, any>>(client.store.processedDirectory, `evidence-${result.cache.key}`);
  assert.deepEqual(persisted?.records, request.records);
  await client.restart(); assert.deepEqual((await json(client, job.resultUrl)).records, request.records);
  assert.equal(externalFetches, 0);
});

test("invalid ground records are rejected before queuing, including incomplete acoustic metadata", async t => {
  let calls = 0; const client = await launch(t, async (...args) => { calls++; return fixtureExecutor(...args); });
  const valid = groundFixture();
  const invalid = [
    { ...valid, records: [] }, { ...valid, records: [{ ...valid.records[2], durationSeconds: undefined }] },
    { ...valid, records: [{ ...valid.records[2], date: "2024-01-01T00:00:00-05:00" }] },
    { ...valid, records: [{ ...valid.records[0], provenance: { ...valid.records[0].provenance, sourceUrl: "http://untrusted.invalid" } }] },
    { ...valid, records: [{ ...valid.records[1], value: "0" }] },
    { ...valid, records: [{ ...valid.records[0], detectionLimit: -1 }] },
  ];
  for (const request of invalid) assert.equal((await client.post(request)).status, 422, JSON.stringify(request));
  assert.equal(calls, 0); assert.deepEqual(await client.store.list(client.store.runsDirectory), []);
});
