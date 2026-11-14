import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FACILITY_SOURCE, fetchFacilities, normalizeFacilities } from "../apps/api/src/environment/facilities.ts";

function fixture() {
  return {
    version: 0.6,
    generator: "Overpass API 0.7.62.8",
    osm3s: { timestamp_osm_base: "2026-11-14T15:01:02Z", copyright: "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL." },
    elements: [
      { type: "node", id: 1234, lat: 0, lon: 0, tags: { telecom: "data_center", name: "  Example DC  ", operator: "Example Operator", "addr:country": "US", "addr:city": "Example City" } },
      { type: "way", id: 1234, nodes: [100, 101, 100], center: { lat: 43.7, lon: -79.4 }, tags: { building: "data_center", "addr:country": "ca", "addr:postcode": "M1A 1A1" } },
      { type: "relation", id: 4321, members: [{ type: "way", ref: 1234, role: "outer" }], tags: { man_made: "data_center", name: "Canada named site without a country tag", operator: "   " } },
      { type: "count", id: 0, tags: { nodes: "1", ways: "1", relations: "1", areas: "0", total: "3" } }
    ]
  };
}

test("facility snapshots preserve OSM identities, nullable metadata, coordinates and licensing", () => {
  const raw = fixture();
  const untouched = structuredClone(raw);
  const result = normalizeFacilities(raw, { retrievedAt: "2026-11-14T16:00:00Z" });
  assert.equal(result.sourceId, "openstreetmap-overpass");
  assert.equal(result.scope.type, "global");
  assert.equal(result.scope.bbox, null);
  assert.equal(result.completeness, "osm_query_snapshot_not_census");
  assert.equal(result.sourceUpdatedAt, "2026-11-14T15:01:02Z");
  assert.equal(result.license.id, "ODbL-1.0");
  assert.equal(result.license.attribution, "© OpenStreetMap contributors");
  assert.deepEqual(result.facilities.map(record => record.id), ["osm/node/1234", "osm/way/1234", "osm/relation/4321"]);
  assert.deepEqual(result.facilities[0].location, { latitude: 0, longitude: 0, method: "osm_node" });
  assert.equal(result.facilities[0].name, "Example DC");
  assert.equal(result.facilities[0].sourceUrl, "https://www.openstreetmap.org/node/1234");
  assert.deepEqual(result.facilities[1].location, { latitude: 43.7, longitude: -79.4, method: "bounding_box_center" });
  assert.equal(result.facilities[1].name, null);
  assert.deepEqual(result.facilities[2].location, { latitude: null, longitude: null, method: "missing" });
  assert.equal(result.facilities[2].operator, null);
  assert.deepEqual(result.counts, { records: 3, sourceTotal: 3, located: 2, unlocated: 1, byElementType: { node: 1, way: 1, relation: 1 }, byCountryTag: { US: 1, ca: 1 }, missingCountryTag: 1, priorityCountriesByExplicitCountryTag: { CA: 1, US: 1 } });
  assert.ok(result.warnings.some(warning => warning.includes("same physical facility")));
  assert.ok(result.warnings.some(warning => warning.includes("not a complete global")));
  assert.deepEqual(raw, untouched);
});

test("facility fetch sends one bounded tag-union query with correct bbox order and completion count", async () => {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(input, FACILITY_SOURCE.endpoint);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    assert.ok(init?.signal instanceof AbortSignal);
    const query = new URLSearchParams(String(init?.body)).get("data")!;
    assert.match(query, /\[timeout:90\]\[maxsize:134217728\]/);
    for (const tag of ["telecom", "building", "man_made"]) assert.ok(query.includes(`nwr["${tag}"="data_center"](25,-130,72,-55)`));
    assert.match(query, /out body center 20001;\nout count;$/);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json(fixture());
  }) as typeof fetch;
  const result = await fetchFacilities({ bbox: [-130, 25, -55, 72] }, { fetchImpl });
  assert.equal(calls, 1);
  assert.deepEqual(result.scope, { type: "bbox", bbox: [-130, 25, -55, 72] });
  assert.ok(result.warnings.some(warning => warning.includes("requested bbox filter")));
  assert.deepEqual(result.raw, fixture());
  assert.equal(result.rawSha256, createHash("sha256").update(JSON.stringify(result.raw)).digest("hex"));
});

test("partial, limited, duplicate and malformed facility responses fail instead of claiming completeness", () => {
  assert.throws(() => normalizeFacilities({ ...fixture(), remark: "runtime error: Query timed out in query" }), /incomplete query.*timed out/);
  assert.throws(() => normalizeFacilities({ ...fixture(), elements: fixture().elements.slice(0, -1) }), /completion count.*truncated/);
  const mismatch = fixture();
  mismatch.elements.at(-1)!.tags!.total = "4";
  assert.throws(() => normalizeFacilities(mismatch), /count does not match/);
  const limited = fixture();
  limited.elements.at(-1)!.tags!.total = "20001";
  assert.throws(() => normalizeFacilities(limited), /exceeds 20000.*truncated/);
  const duplicate = fixture();
  duplicate.elements[1] = { ...duplicate.elements[0] };
  assert.throws(() => normalizeFacilities(duplicate), /duplicate element/);
  const unrelated = fixture();
  unrelated.elements[0].tags!.telecom = "exchange";
  assert.throws(() => normalizeFacilities(unrelated), /outside the requested/);
  assert.throws(() => normalizeFacilities({ elements: [] }), /completion count/);
});

test("invalid locations remain null without dropping their source IDs or inventing countries", () => {
  const raw = fixture();
  raw.elements[0].lat = 91;
  raw.elements[1].center!.lon = NaN;
  const result = normalizeFacilities(raw);
  assert.equal(result.counts.records, 3);
  assert.equal(result.counts.unlocated, 3);
  assert.equal(result.facilities[0].osmId, 1234);
  assert.deepEqual(result.facilities[1].location, { latitude: null, longitude: null, method: "missing" });
  assert.equal(result.facilities[2].address.country, null);
  assert.equal(result.counts.priorityCountriesByExplicitCountryTag.CA, 1, "Only the explicit ca tag counts; the Canada name does not");
  assert.equal(result.counts.missingCountryTag, 1);
});

test("facility country tags cannot modify the aggregate object's prototype", () => {
  const raw = fixture();
  raw.elements[0].tags!["addr:country"] = "__proto__";
  const result = normalizeFacilities(raw);
  assert.equal(Object.getPrototypeOf(result.counts.byCountryTag), Object.prototype);
  assert.equal(Object.hasOwn(result.counts.byCountryTag, "__proto__"), true);
  assert.equal(result.counts.byCountryTag["__proto__"], 1);
  assert.equal(result.counts.priorityCountriesByExplicitCountryTag.US, 0);
});

test("facility requests validate spatial bounds, timeout and cancellation before network work", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json(fixture()); }) as typeof fetch;
  for (const bbox of [[10, 20, -10, 30], [-181, -90, 180, 90], [-180, -91, 180, 90], [-180, -90, 180, Infinity], [0, 0, 0, 0], [0, 0, 1]] as Array<[number, number, number, number]>) await assert.rejects(fetchFacilities({ bbox }, { fetchImpl }), /bbox/);
  await assert.rejects(fetchFacilities({}, { fetchImpl, timeoutMs: 150001 }), /timeout/);
  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(fetchFacilities({}, { fetchImpl, signal: controller.signal }), /cancelled by caller/);
  assert.equal(calls, 0);
});

test("facility HTTP, malformed JSON and byte-limit failures surface without fallback requests", async () => {
  let calls = 0;
  await assert.rejects(fetchFacilities({}, { fetchImpl: (async () => { calls++; return new Response("Rate limited", { status: 429 }); }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
  await assert.rejects(fetchFacilities({}, { fetchImpl: (async () => new Response('{"elements":[')) as typeof fetch }), /invalid or truncated/);
  await assert.rejects(fetchFacilities({}, { fetchImpl: (async () => new Response("{}", { headers: { "Content-Length": String(33 * 1024 * 1024) } })) as typeof fetch }), /exceeds 32 MiB/);
  let cancelled = false;
  let produced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { produced++; controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(fetchFacilities({}, { fetchImpl: (async () => new Response(body)) as typeof fetch }), /exceeds 32 MiB/);
  assert.equal(cancelled, true);
  assert.ok(produced <= 34, "The upstream body must stop after the byte limit");
});

test("a successful empty query is an empty snapshot rather than a fabricated facility", () => {
  const result = normalizeFacilities({ elements: [{ type: "count", id: 0, tags: { total: "0" } }] });
  assert.equal(result.counts.records, 0);
  assert.deepEqual(result.facilities, []);
  assert.equal(result.sourceUpdatedAt, null);
  assert.ok(result.warnings.some(warning => warning.includes("does not establish source freshness")));
});
