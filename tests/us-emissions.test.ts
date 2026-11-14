import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchUsEmissions, normalizeUsEmissions, US_NEI_YEARS } from "../apps/api/src/environment/us-emissions.ts";

function fixture(id = 21986211): Record<string, unknown> {
  return { address: "SWSW SEC 4 T6N R80W", address_postal_code: "80430", city_name: "WALDEN AREA", code_description: "Computing Infrastructure Providers, Data Processing, Web Hosting, And Related Services", county_fips: "08057", county_name: "Jackson", description: "Methanol", eis_facility_id: id, emissions: 5422.8, facility_type: null, fips: "08057", latitude: 40.50998, longitude: -106.38404, naics_code: 518210, pollutant_code: "67561", pollutant_type: "HAP", site_name: "CRUSOE ENERGY - SURPRISE S4 FACILITY", state_abbr: "CO", state_fips: "08", uom: "LB" };
}

test("EPA inventory rows preserve source IDs, year, pollutant, units and unverified sector classification", () => {
  const raw = [fixture(), { ...fixture(), pollutant_code: "NOX", description: "Nitrogen Oxides", pollutant_type: "CAP", emissions: 0, uom: "TON" }];
  const before = structuredClone(raw);
  const result = normalizeUsEmissions(raw, {}, { retrievedAt: "2026-11-14T20:00:00Z" });
  assert.equal(result.reportingYear, 2023);
  assert.equal(result.sourceId, "us-epa-nei");
  assert.equal(result.evidence, "reported_emissions_inventory");
  assert.equal(result.completeness, "complete_filtered_api_result_not_facility_census");
  assert.deepEqual(result.scope, { country: "US", state: null });
  assert.equal(result.records[0].facility.id, "eis/21986211");
  assert.equal(result.records[0].quantity, 5422.8);
  assert.equal(result.records[0].unit, "LB");
  assert.equal(result.records[1].quantity, 0);
  assert.equal(result.records[1].unit, "TON");
  assert.equal(result.records[0].measurementMethod, "not_supplied_in_summary");
  assert.equal(result.records[0].classification.status, "sector_candidate_unverified");
  assert.deepEqual(result.counts, { records: 2, facilities: 1, pollutants: 2, missingQuantities: 0, missingUnits: 0, unlocatedRecords: 0 });
  assert.ok(result.warnings.some(warning => warning.includes("not necessarily direct measurements")));
  assert.ok(result.warnings.some(warning => warning.includes("Do not sum different units")));
  assert.deepEqual(raw, before);
});

test("EPA pagination is sorted, bounded, state-filtered, and retains raw provenance", async () => {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    assert.ok(url.startsWith("https://data.epa.gov/dmapservice/nei.vw_facility_summaries_2020/naics_code/equals/518210/and/state_abbr/equals/CO/sort/eis_facility_id:asc,pollutant_code:asc,pollutant_type:asc,uom:asc/"));
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    if (requests.length === 1) { assert.ok(url.endsWith("/1:1000/json")); return Response.json(Array.from({ length: 1000 }, (_, index) => fixture(10_000 + index))); }
    assert.ok(url.endsWith("/1001:2000/json"));
    return Response.json([fixture(20_001)]);
  }) as typeof fetch;
  const result = await fetchUsEmissions({ year: 2020, state: "co" }, { fetchImpl });
  assert.equal(requests.length, 2);
  assert.equal(result.counts.records, 1001);
  assert.equal(result.counts.facilities, 1001);
  assert.equal(result.scope.state, "CO");
  assert.deepEqual(result.sourceUrls, requests);
  assert.equal(result.raw!.length, 1001);
  assert.equal(result.rawSha256, createHash("sha256").update(JSON.stringify(result.raw)).digest("hex"));
});

test("missing quantities, units and locations remain null, while negative source estimates are retained", () => {
  const result = normalizeUsEmissions([
    { ...fixture(), emissions: null, uom: null, latitude: 91 },
    { ...fixture(21986212), emissions: "unknown", longitude: null },
    { ...fixture(21986213), emissions: -0.25, code_description: "Gasoline Stations With Convenience Stores" }
  ], { year: 2011 });
  assert.equal(result.records[0].quantity, null);
  assert.equal(result.records[0].unit, null);
  assert.equal(result.records[0].quality, "missing");
  assert.equal(result.records[0].facility.longitude, null);
  assert.equal(result.records[1].quantity, null);
  assert.equal(result.records[2].quantity, -0.25);
  assert.equal(result.records[2].classification.sourceDescription, "Gasoline Stations With Convenience Stores");
  assert.equal(result.records[2].classification.status, "sector_candidate_unverified");
  assert.equal(result.counts.missingQuantities, 2);
  assert.equal(result.counts.unlocatedRecords, 2);
});

test("unsupported years, invalid states, timeouts and prior cancellation never fetch", async () => {
  assert.deepEqual(US_NEI_YEARS, [2008, 2011, 2014, 2017, 2020, 2023]);
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json([]); }) as typeof fetch;
  for (const query of [{ year: 2026 }, { year: 2022 }, { year: 2023.5 }, { state: "Canada" }, { state: "ZZ" }, { state: "CO/and/naics_code/equals/1" }]) await assert.rejects(fetchUsEmissions(query, { fetchImpl }));
  await assert.rejects(fetchUsEmissions({}, { fetchImpl, timeoutMs: 180001 }), /timeout/);
  const controller = new AbortController();
  controller.abort(new Error("caller stopped acquisition"));
  await assert.rejects(fetchUsEmissions({}, { fetchImpl, signal: controller.signal }), /caller stopped/);
  assert.equal(calls, 0);
});

test("EPA HTTP errors, error JSON, partial JSON and ignored page bounds are rejected", async () => {
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch }), /EPA NEI returned HTTP 503.*partial pages were not accepted/);
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async () => Response.json({ error: "Unknown table" })) as typeof fetch }), /error or invalid response/);
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async () => new Response("[{")) as typeof fetch }), /invalid or truncated JSON/);
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async () => Response.json(Array.from({ length: 1001 }, () => fixture()))) as typeof fetch }), /ignored the requested page bounds/);
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async () => new Response("[]", { headers: { "Content-Length": String(33 * 1024 * 1024) } })) as typeof fetch }), /32 MiB/);
});

test("EPA duplicate pages and out-of-filter rows cannot silently become a completed inventory", async () => {
  const page = Array.from({ length: 1000 }, (_, index) => fixture(10_000 + index));
  let calls = 0;
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async () => Response.json(++calls === 1 ? page : [page[0]])) as typeof fetch }), /duplicate.*pagination may be unstable/);
  assert.throws(() => normalizeUsEmissions([{ ...fixture(), naics_code: 111111 }]), /outside the requested NAICS/);
  assert.throws(() => normalizeUsEmissions([fixture()], { state: "VA" }), /outside the requested state/);
  assert.throws(() => normalizeUsEmissions([{ ...fixture(), eis_facility_id: null }]), /valid facility ID/);
});

test("EPA record cap uses an overflow probe and rejects records beyond the bounded inventory", async () => {
  let calls = 0;
  await assert.rejects(fetchUsEmissions({}, { fetchImpl: (async input => {
    calls++;
    const url = String(input);
    const first = Number(/\/(\d+):\d+\/json$/.exec(url)![1]);
    if (calls === 11) { assert.ok(url.endsWith("/10001:10001/json")); return Response.json([fixture(10_001)]); }
    return Response.json(Array.from({ length: 1000 }, (_, index) => fixture(first + index)));
  }) as typeof fetch }), /exceeds 10000.*truncated results/);
  assert.equal(calls, 11);
});

test("a successful empty EPA query remains empty without assigning zero emissions to facilities", async () => {
  const result = await fetchUsEmissions({ year: 2008, state: "AK" }, { fetchImpl: (async () => Response.json([])) as typeof fetch });
  assert.deepEqual(result.records, []);
  assert.equal(result.counts.facilities, 0);
  assert.equal(result.scope.state, "AK");
  assert.equal(result.completeness, "complete_filtered_api_result_not_facility_census");
  assert.ok(result.warnings.some(warning => warning.includes("not be interpreted as zero")));
});
