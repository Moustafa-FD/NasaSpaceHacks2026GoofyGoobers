import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchWaterQuality, validateWaterQualityQuery, WATER_QUALITY_PARAMETERS, WATER_QUALITY_SOURCE, type WaterQualityQuery } from "../apps/api/src/environment/water-quality.ts";

const now = new Date("2026-11-14T12:00:00Z");
const query: WaterQualityQuery = { stationId: "USGS-01646500", start: "2026-11-01", end: "2026-11-01", parameters: ["00010"] };
/** Synthetic observations exercise the verified USGS response schema; not field measurements. */
function observation(index: number, overrides: Record<string, unknown> = {}) {
  return { type: "Feature", id: `synthetic-${index}`, geometry: { type: "Point", coordinates: [-77.12, 38.95] }, properties: {
    monitoring_location_id: query.stationId, time_series_id: "synthetic-series", parameter_code: "00010", statistic_id: "00011",
    time: new Date(Date.parse("2026-11-01T00:00:00Z") + index * 60_000).toISOString(), value: String(index), unit_of_measure: "degC", approval_status: "Provisional", qualifier: null,
    method_category: "STNRD", last_modified: "2026-11-02T01:00:00+00:00", ...overrides,
  } };
}
function fixture(records = [observation(0, { value: "0", approval_status: "Approved" }), observation(1, { value: "16.00", qualifier: "Estimated", method_category: "ESTIM" }), observation(2, { value: "<0.1", qualifier: ["censored"] }), observation(3, { value: "Eqp", qualifier: "Equipment malfunction" })], pageSize = 2) {
  const calls: URL[] = [];
  const station = { type: "Feature", id: query.stationId, geometry: { type: "Point", coordinates: [-77.12, 38.95] }, properties: {
    id: query.stationId, monitoring_location_name: "Synthetic station", country_code: "US", state_name: "Maryland", site_type: "Stream", original_horizontal_datum: "NAD83",
  } };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input); calls.push(url);
    assert.equal(url.origin, "https://api.waterdata.usgs.gov"); assert.equal(init?.redirect, "error");
    assert.equal(url.searchParams.has("api_key"), false); assert.equal(new Headers(init?.headers).has("X-Api-Key"), false);
    if (url.pathname.includes("monitoring-locations/items/")) return Response.json(station);
    assert.equal(url.pathname, "/ogcapi/v1/collections/continuous/items");
    assert.equal(url.searchParams.get("monitoring_location_id"), query.stationId); assert.equal(url.searchParams.get("sortby"), "time");
    assert.equal(url.searchParams.get("datetime"), "2026-11-01T00:00:00Z/2026-11-01T23:59:59.999Z");
    const selected = url.searchParams.get("parameter_code") === "00010" ? records : [];
    const offset = Number(url.searchParams.get("offset")); const limit = Math.min(Number(url.searchParams.get("limit")), pageSize);
    const features = selected.slice(offset, offset + limit); const next = new URL(url);
    next.searchParams.set("offset", String(offset + features.length));
    return Response.json({ type: "FeatureCollection", features, numberReturned: features.length, links: offset + features.length < selected.length ? [{ rel: "next", href: next.href }] : [] });
  }) as typeof fetch;
  return { fetchImpl, calls, station };
}

test("USGS records preserve numeric strings, zeroes, censored/non-numeric values and station provenance", async () => {
  const f = fixture(); const result = await fetchWaterQuality(query, { fetchImpl: f.fetchImpl, now });
  assert.equal(result.complete, true); assert.equal(result.evidence, "ground-observation"); assert.equal(result.timeStandard, "UTC");
  assert.equal(result.coverage.recordCount, 4); assert.equal(result.station.originalHorizontalDatum, "NAD83");
  assert.deepEqual(result.station.location, { latitude: 38.95, longitude: -77.12, crs: "EPSG:4326" });
  assert.equal(result.records[0].value, 0); assert.equal(result.records[0].rawValue, "0"); assert.equal(result.records[0].approvalStatus, "Approved");
  assert.equal(result.records[1].value, 16); assert.equal(result.records[1].rawValue, "16.00"); assert.equal(result.records[1].unit, "degC");
  assert.equal(result.records[1].qualifier, "Estimated"); assert.equal(result.records[1].methodCategory, "ESTIM");
  assert.equal(result.records[1].methodDetails, "not_supplied_by_continuous_endpoint");
  assert.equal(result.records[2].value, null); assert.equal(result.records[2].valueStatus, "censored");
  assert.deepEqual(result.records[2].censoring, { operator: "<", bound: 0.1, raw: "<0.1" });
  assert.equal(result.records[2].detectionLimit, null); assert.deepEqual(result.records[2].qualifier, ["censored"]);
  assert.equal(result.records[3].value, null); assert.equal(result.records[3].valueStatus, "missing_or_non_numeric");
  assert.equal(result.records[0].date, "2026-11-01T00:00:00.000Z");
  assert.equal(result.records[0].timeSeriesId, "synthetic-series"); assert.equal(result.records[0].statisticId, "00011");
  assert.equal(result.records[0].lastModified, "2026-11-02T01:00:00+00:00");
  assert.ok(result.sourceDocuments.every(document => /^[a-f0-9]{64}$/.test(document.sha256)));
  assert.equal(result.rawSha256, createHash("sha256").update(JSON.stringify(result.raw)).digest("hex"));
  assert.match(result.source.schemaUrl, /\/v1\/collections\/continuous\/schema/);
});

test("unmonitored parameters and absent observation geometry stay unknown rather than zero", async () => {
  const missingGeometry = observation(0); missingGeometry.geometry = null as any;
  const f = fixture([missingGeometry]);
  const result = await fetchWaterQuality({ ...query, parameters: [...WATER_QUALITY_PARAMETERS] }, { fetchImpl: f.fetchImpl, now });
  assert.equal(result.complete, true); assert.equal(result.records.length, 1); assert.equal(result.records[0].location, null);
  assert.equal(result.parameters.length, 5);
  assert.ok(result.parameters.slice(1).every(parameter => parameter.status === "no_records_returned" && parameter.recordCount === 0 && parameter.units.length === 0));
  const empty = await fetchWaterQuality(query, { fetchImpl: fixture([]).fetchImpl, now });
  assert.equal(empty.complete, true); assert.equal(empty.coverage.firstObservationTime, null); assert.deepEqual(empty.records, []);
});

test("record caps explicitly mark incomplete pagination and unqueried parameters", async () => {
  const result = await fetchWaterQuality({ ...query, parameters: [...WATER_QUALITY_PARAMETERS] }, { fetchImpl: fixture().fetchImpl, maxRecords: 2, now });
  assert.equal(result.complete, false); assert.equal(result.coverage.capped, true); assert.equal(result.records.length, 2);
  assert.equal(result.parameters[0].paginationComplete, false);
  assert.ok(result.parameters.slice(1).every(parameter => parameter.status === "not_queried_record_cap"));
  assert.ok(result.warnings.some(warning => warning.includes("record cap")));
});

test("a full page without a next link is probed again before declaring acquisition complete", async () => {
  const records = Array.from({ length: 1001 }, (_, i) => observation(i)); const f = fixture(records, 1000);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await f.fetchImpl(input, init); const body = await response.json() as Record<string, unknown>;
    if (Array.isArray(body.links)) body.links = [];
    return Response.json(body);
  }) as typeof fetch;
  const result = await fetchWaterQuality(query, { fetchImpl, now });
  assert.equal(result.complete, true); assert.equal(result.records.length, 1001);
  assert.equal(f.calls.filter(url => url.pathname.endsWith("continuous/items")).length, 2);
});

test("pagination rejects other origins/paths, changed filters and nonadvancing offsets", async () => {
  const mutations = [
    (next: URL) => { next.hostname = "untrusted.invalid"; }, (next: URL) => { next.pathname = "/different-api"; },
    (next: URL) => { next.searchParams.set("monitoring_location_id", "USGS-00000000"); },
    (next: URL) => { next.searchParams.set("parameter_code", "00060"); },
    (next: URL) => { next.searchParams.set("offset", "0"); },
  ];
  for (const mutation of mutations) {
    const f = fixture();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await f.fetchImpl(input, init); const body = await response.json() as Record<string, any>;
      if (body.links?.length) { const next = new URL(body.links[0].href); mutation(next); body.links[0].href = next.href; }
      return Response.json(body);
    }) as typeof fetch;
    await assert.rejects(fetchWaterQuality(query, { fetchImpl, now }), /next-page/);
    assert.equal(f.calls.length, 2, "unsafe pagination must fail before another source request");
  }
});

test("source identities, time bounds, page counts and duplicate observation IDs are validated", async () => {
  for (const overrides of [{ monitoring_location_id: "USGS-00000000" }, { parameter_code: "00060" }, { time: "2026-11-02T00:00:00Z" }, { time: "2026-02-30T00:00:00Z" }, { value: 0 }]) {
    await assert.rejects(fetchWaterQuality(query, { fetchImpl: fixture([observation(0, overrides)]).fetchImpl, now }), /USGS/);
  }
  const one = observation(0); const duplicate = observation(1); duplicate.id = one.id;
  await assert.rejects(fetchWaterQuality(query, { fetchImpl: fixture([one, duplicate], 1).fetchImpl, now }), /duplicate/);
  const f = fixture();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await f.fetchImpl(input, init); const body = await response.json() as Record<string, unknown>;
    if (body.type === "FeatureCollection") body.numberReturned = 999;
    return Response.json(body);
  }) as typeof fetch;
  await assert.rejects(fetchWaterQuality(query, { fetchImpl, now }), /pagination count/);
});

test("queries exclude flow-as-chemistry, malformed IDs, future dates and intervals over 31 inclusive days", () => {
  assert.doesNotThrow(() => validateWaterQualityQuery({ ...query, start: "2026-10-01", end: "2026-10-31" }, now));
  for (const value of [{ ...query, stationId: "01646500" }, { ...query, stationId: "USGS-../00000000" }, { ...query, parameters: ["00060"] },
    { ...query, parameters: ["00010", "00010"] }, { ...query, parameters: [["00010"]] }, { ...query, start: "2026-10-01", end: "2026-11-01" },
    { ...query, start: "2026-02-30" }, { ...query, end: "2026-11-15" }]) assert.throws(() => validateWaterQualityQuery(value as WaterQualityQuery, now));
});

test("anonymous quota/error responses, byte limits and caller cancellation produce explicit failures", async () => {
  await assert.rejects(fetchWaterQuality(query, { fetchImpl: (async () => new Response("quota", { status: 429 })) as typeof fetch, now }), /rate limit/);
  await assert.rejects(fetchWaterQuality(query, { fetchImpl: (async () => new Response("error", { status: 503 })) as typeof fetch, now }), /503/);
  await assert.rejects(fetchWaterQuality(query, { fetchImpl: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch, now }), /non-JSON/);
  await assert.rejects(fetchWaterQuality(query, { fetchImpl: (async () => new Response("{}", { headers: { "content-length": "5000000", "content-type": "application/json" } })) as typeof fetch, now }), /4 MiB/);
  const f = fixture();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { const response = await f.fetchImpl(input, init); const body = await response.json() as Record<string, unknown>; body.padding = "x".repeat(70_000); return Response.json(body); }) as typeof fetch;
  await assert.rejects(fetchWaterQuality(query, { fetchImpl, now, maxBytes: 65_536 }), /byte budget/);
  const abort = new AbortController(); abort.abort(); let called = false;
  await assert.rejects(fetchWaterQuality(query, { signal: abort.signal, now, fetchImpl: (async () => { called = true; return Response.json({}); }) as typeof fetch }), /abort/i);
  assert.equal(called, false);
  assert.equal(WATER_QUALITY_SOURCE.endpoint, "https://api.waterdata.usgs.gov/ogcapi/v1/");
});
