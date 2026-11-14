import test from "node:test";
import assert from "node:assert/strict";
import { AIR_QUALITY_VARIABLES, fetchAirQuality, type AirQualityQuery } from "../apps/api/src/environment/air-quality.ts";

const now = new Date("2026-11-14T12:00:00Z");
const query: AirQualityQuery = { latitude: 43.65, longitude: -79.38, start: "2026-11-01", end: "2026-11-02", variables: [...AIR_QUALITY_VARIABLES] };

function fixture(start = "2026-11-01", days = 2) {
  const time = Array.from({ length: days * 24 }, (_, index) => new Date(Date.parse(`${start}T00:00:00Z`) + index * 3_600_000).toISOString().slice(0, 16));
  const hourly: Record<string, unknown> = { time };
  const hourly_units: Record<string, unknown> = { time: "iso8601" };
  for (const variable of AIR_QUALITY_VARIABLES) {
    hourly[variable] = Array.from({ length: time.length }, (_, index) => index === 0 ? 0 : index / 10);
    hourly_units[variable] = "μg/m³";
  }
  return { latitude: 43.6, longitude: -79.2, utc_offset_seconds: 0, timezone: "GMT", hourly, hourly_units };
}

function mocked(raw: unknown): typeof fetch { return (async () => Response.json(raw)) as typeof fetch; }

test("CAMS adapter fixes the public endpoint/global domain and preserves concentrations, missing values, UTC and source metadata", async () => {
  const raw = fixture();
  (raw.hourly.pm2_5 as unknown[])[1] = null;
  (raw.hourly.pm2_5 as unknown[])[2] = "3.5";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, "https://air-quality-api.open-meteo.com");
    assert.equal(url.pathname, "/v1/air-quality");
    assert.equal(url.searchParams.get("domains"), "cams_global");
    assert.equal(url.searchParams.get("timezone"), "GMT");
    assert.equal(url.searchParams.get("cell_selection"), "nearest");
    assert.equal(url.searchParams.get("start_date"), "2026-11-01");
    assert.equal(url.searchParams.get("end_date"), "2026-11-02");
    assert.equal(url.searchParams.get("hourly"), AIR_QUALITY_VARIABLES.join(","));
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(init?.redirect, "error");
    return Response.json(raw);
  }) as typeof fetch;
  const result = await fetchAirQuality(query, { fetchImpl, now });
  assert.equal(result.evidence, "model-derived");
  assert.equal(result.timeStandard, "UTC");
  assert.deepEqual(result.period, { start: "2026-11-01", end: "2026-11-02", inclusive: true, interval: "hourly", requestedHours: 48 });
  assert.deepEqual(result.location, { latitude: 43.65, longitude: -79.38, sourcePoint: { latitude: 43.6, longitude: -79.2 } });
  assert.deepEqual(result.raw, raw);
  const particulate = result.variables[0];
  assert.equal(particulate.unit, "μg/m³");
  assert.deepEqual(particulate.series.slice(0, 3), [
    { date: "2026-11-01T00:00:00Z", value: 0, quality: "valid" },
    { date: "2026-11-01T01:00:00Z", value: null, quality: "missing" },
    { date: "2026-11-01T02:00:00Z", value: null, quality: "missing" }
  ]);
  assert.equal(particulate.series.at(-1)?.date, "2026-11-02T23:00:00Z");
  assert.equal(particulate.validSampleCount, 46);
  assert.equal(particulate.missingSampleCount, 2);
  assert.equal(particulate.firstValidDate, "2026-11-01T00:00:00Z");
  assert.equal(particulate.lastValidDate, "2026-11-02T23:00:00Z");
  assert.equal(result.model.id, "cams_global");
  assert.equal(result.model.version, "not_returned");
  assert.equal(result.license.service, "free-non-commercial");
  assert.equal(result.license.data, "CC BY 4.0");
  assert.ok(result.license.attribution.some(item => item.name.includes("CAMS")));
  assert.ok(result.warnings.some(warning => warning.includes("not ground-sensor")));
  assert.ok(result.warnings.some(warning => warning.includes("not a homogeneous")));
});

test("CAMS defaults to seven completed UTC days and all supported pollutants without fetching forecasts", async () => {
  const result = await fetchAirQuality({ latitude: -33.86, longitude: 151.2 }, { now, fetchImpl: (async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.searchParams.get("start_date"), "2026-11-07");
    assert.equal(url.searchParams.get("end_date"), "2026-11-13");
    return Response.json(fixture("2026-11-07", 7));
  }) as typeof fetch });
  assert.equal(result.period.requestedHours, 168);
  assert.equal(result.variables.length, 5);
});

test("CAMS validates finite coordinates, real dates, bounded historical periods and variable allow-list before fetching", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json(fixture()); }) as typeof fetch;
  const invalid: AirQualityQuery[] = [
    { ...query, latitude: NaN }, { ...query, longitude: Infinity }, { ...query, latitude: 91 }, { ...query, longitude: -181 },
    { ...query, start: "2026-11-31" }, { ...query, start: "2026-2-01" }, { ...query, start: "2026-02-29" },
    { ...query, start: "2022-07-31" }, { ...query, start: "2026-11-03" }, { ...query, end: "2026-11-14" }, { ...query, end: "2050-01-01" },
    { ...query, start: "2026-10-01", end: "2026-11-01" }, { ...query, start: undefined }, { ...query, end: undefined },
    { ...query, variables: [] }, { ...query, variables: ["pm10", "pm10"] }, { ...query, variables: ["NO2"] }, { ...query, variables: ["pm10", "ozone", "pm2_5", "sulphur_dioxide", "nitrogen_dioxide", "carbon_monoxide"] }
  ];
  for (const bad of invalid) await assert.rejects(fetchAirQuality(bad, { now, fetchImpl }));
  await assert.rejects(fetchAirQuality(query, { now: new Date(NaN), fetchImpl }), /clock/);
  for (const timeoutMs of [0, -1, Infinity, 60_001, 1.5]) await assert.rejects(fetchAirQuality(query, { now, fetchImpl, timeoutMs }), /timeout/);
  assert.equal(calls, 0);
});

test("CAMS accepts the 31-day bound and chronological leap-day/hour boundaries", async () => {
  const result = await fetchAirQuality({ ...query, start: "2024-02-01", end: "2024-03-02", variables: ["ozone"] }, { now, fetchImpl: mocked(fixture("2024-02-01", 31)) });
  assert.equal(result.period.requestedHours, 744);
  assert.ok(result.variables[0].series.some(sample => sample.date === "2024-02-29T23:00:00Z"));
  assert.equal(result.variables[0].series.at(-1)?.date, "2024-03-02T23:00:00Z");
});

test("CAMS keeps all-missing source history explicit and does not report finite availability", async () => {
  const raw = fixture("2022-08-01", 1);
  raw.hourly.ozone = Array(24).fill(null);
  const result = await fetchAirQuality({ ...query, start: "2022-08-01", end: "2022-08-01", variables: ["ozone"] }, { now, fetchImpl: mocked(raw) });
  assert.equal(result.variables[0].validSampleCount, 0);
  assert.equal(result.variables[0].missingSampleCount, 24);
  assert.equal(result.variables[0].firstValidDate, null);
  assert.equal(result.variables[0].lastValidDate, null);
  assert.ok(result.variables[0].series.every(sample => sample.value === null));
  assert.ok(result.warnings.some(warning => warning.includes("No finite ozone")));
});

test("CAMS rejects empty/misaligned time arrays, wrong UTC metadata and unverified source coordinates", async () => {
  const mutations: Array<(raw: ReturnType<typeof fixture>) => void> = [
    raw => { raw.hourly.time = []; },
    raw => { (raw.hourly.time as string[]).pop(); },
    raw => { (raw.hourly.time as string[])[1] = "2026-11-01T00:00"; },
    raw => { raw.utc_offset_seconds = 3600; },
    raw => { raw.latitude = Infinity; },
    raw => { raw.longitude = 181; },
    raw => { raw.hourly_units.pm10 = ""; },
    raw => { raw.hourly.pm10 = []; },
    raw => { delete raw.hourly.nitrogen_dioxide; }
  ];
  for (const mutate of mutations) {
    const raw = fixture(); mutate(raw);
    await assert.rejects(fetchAirQuality(query, { now, fetchImpl: mocked(raw) }));
  }
});

test("CAMS propagates provider errors and rejects invalid/oversized response bodies", async () => {
  await assert.rejects(fetchAirQuality(query, { now, fetchImpl: (async () => new Response("limited", { status: 429 })) as typeof fetch }), /HTTP 429/);
  await assert.rejects(fetchAirQuality(query, { now, fetchImpl: mocked({ error: true, reason: "date unavailable" }) }), /date unavailable/);
  await assert.rejects(fetchAirQuality(query, { now, fetchImpl: (async () => new Response("{broken")) as typeof fetch }), /not valid JSON/);
  await assert.rejects(fetchAirQuality(query, { now, fetchImpl: (async () => new Response(null)) as typeof fetch }), /empty/);
  await assert.rejects(fetchAirQuality(query, { now, fetchImpl: (async () => new Response(" ".repeat(2 * 1024 * 1024 + 1))) as typeof fetch }), /exceeds 2 MiB/);
  await assert.rejects(fetchAirQuality(query, { now, fetchImpl: (async () => new Response("{}", { headers: { "content-length": "3000000" } })) as typeof fetch }), /exceeds 2 MiB/);
});

test("CAMS respects cancellation before fetching and passes a bounded abort signal to pending requests", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  let called = false;
  await assert.rejects(fetchAirQuality(query, { signal: controller.signal, fetchImpl: (async () => { called = true; return Response.json(fixture()); }) as typeof fetch }), /caller cancelled/);
  assert.equal(called, false);
  const pending = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    assert.ok(init?.signal);
    init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  // Keep the test alive while AbortSignal.timeout's intentionally unref'ed timer runs.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(fetchAirQuality(query, { now, timeoutMs: 5, fetchImpl: pending }), /timeout/i); }
  finally { clearTimeout(keepAlive); }
});
