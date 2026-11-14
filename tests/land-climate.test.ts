import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CLIMATE_MODELS, dayRange, fetchLandClimate, validateDailyPoint, validDay, type DailyPointQuery } from "../apps/api/src/environment/land-climate.ts";

const now = new Date("2026-11-14T12:00:00Z");
const historical: DailyPointQuery = { latitude: 43.65, longitude: -79.38, start: "2024-02-28", end: "2024-03-01" };
const future: DailyPointQuery = { ...historical, start: "2030-01-01", end: "2030-01-03" };
const base = ["temperature_2m_mean", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "et0_fao_evapotranspiration"];

/** Synthetic source-schema fixtures, not downloaded climate observations. */
function fixture(query: DailyPointQuery, climate = false, models: readonly string[] = climate ? CLIMATE_MODELS : ["era5"]) {
  const dates = dayRange(query.start, query.end);
  const daily: Record<string, unknown> = { time: dates };
  const daily_units: Record<string, unknown> = { time: "iso8601" };
  const fields = [...base.map(variable => climate && variable === "et0_fao_evapotranspiration" ? `${variable}_sum` : variable),
    ...(climate ? ["soil_moisture_0_to_10cm_mean"] : ["soil_moisture_0_to_7cm_mean", "soil_moisture_7_to_28cm_mean", "soil_moisture_28_to_100cm_mean"])];
  models.forEach((model, modelIndex) => fields.forEach(variable => {
    const key = climate && models.length > 1 ? `${variable}_${model}` : variable;
    daily[key] = dates.map((_, index) => variable.includes("soil_moisture") ? (index + modelIndex) / 10 : index + modelIndex * 10);
    daily_units[key] = variable.includes("temperature") ? "°C" : variable.includes("soil_moisture") ? "m³/m³" : "mm";
  }));
  return { latitude: 43.6, longitude: -79.4, utc_offset_seconds: 0, timezone: "GMT", daily, daily_units };
}
const mock = (raw: unknown): typeof fetch => (async () => Response.json(raw)) as typeof fetch;

test("ERA5 daily adapter requests actual units/depths and preserves leap-day UTC, zeros and missing values", async () => {
  const raw = fixture(historical);
  (raw.daily.temperature_2m_mean as unknown[])[1] = null;
  (raw.daily.precipitation_sum as unknown[])[2] = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://archive-api.open-meteo.com");
    assert.equal(url.pathname, "/v1/archive");
    assert.equal(url.searchParams.get("models"), "era5");
    assert.equal(url.searchParams.get("timezone"), "GMT");
    assert.equal(url.searchParams.get("temperature_unit"), "celsius");
    assert.equal(url.searchParams.get("precipitation_unit"), "mm");
    assert.equal(url.searchParams.get("cell_selection"), "nearest");
    assert.equal(url.searchParams.has("disable_bias_correction"), false);
    assert.equal(url.searchParams.get("daily")?.includes("soil_moisture_28_to_100cm_mean"), true);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json(raw);
  }) as typeof fetch;
  const data = await fetchLandClimate(historical, { fetchImpl, now });
  assert.equal(data.sourceId, "open-meteo-era5"); assert.equal(data.evidence, "model-derived"); assert.equal(data.timeStandard, "UTC");
  assert.equal(data.models.length, 1); assert.equal(data.models[0].model, "era5"); assert.equal(data.models[0].metrics.length, 8);
  assert.deepEqual(data.sourcePoint, { latitude: 43.6, longitude: -79.4 });
  const temperature = data.models[0].metrics.find(metric => metric.id === "temperature_2m_mean")!;
  assert.equal(temperature.units, "°C");
  assert.deepEqual(temperature.series, [{ date: "2024-02-28", value: 0 }, { date: "2024-02-29", value: null }, { date: "2024-03-01", value: 2 }]);
  assert.equal(temperature.validDays, 2); assert.equal(temperature.missingDays, 1);
  assert.equal(data.models[0].metrics.find(metric => metric.id === "precipitation_sum")?.units, "mm");
  assert.equal(data.models[0].metrics.find(metric => metric.id === "soil_moisture_7_to_28cm_mean")?.units, "m³/m³");
  assert.deepEqual(data.raw, raw);
  assert.equal(data.rawSha256, createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  assert.equal(data.scenario, null);
  assert.match(data.license.access, /non-commercial/);
  assert.ok(data.warnings.some(value => value.includes("not a soil chemistry")));
});

test("climate adapter keeps two model suffixes separate and normalizes reference-ET0 variable names", async () => {
  const raw = fixture(future, true);
  (raw.daily[`temperature_2m_mean_${CLIMATE_MODELS[0]}`] as unknown[])[1] = null;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://climate-api.open-meteo.com");
    assert.equal(url.searchParams.get("models"), CLIMATE_MODELS.join(","));
    assert.equal(url.searchParams.get("disable_bias_correction"), "false");
    assert.ok(url.searchParams.get("daily")?.includes("et0_fao_evapotranspiration_sum"));
    assert.ok(url.searchParams.get("daily")?.includes("soil_moisture_0_to_10cm_mean"));
    return Response.json(raw);
  }) as typeof fetch;
  const data = await fetchLandClimate(future, { climate: true, fetchImpl, now });
  assert.equal(data.evidence, "climate-scenario"); assert.equal(data.timeStandard, "UTC");
  assert.deepEqual(data.models.map(value => value.model), [...CLIMATE_MODELS]);
  assert.equal(data.models[0].metrics[0].series[1].value, null);
  assert.equal(data.models[1].metrics[0].series[1].value, 11);
  for (const model of data.models) {
    const et0 = model.metrics.find(metric => metric.id === "et0_fao_evapotranspiration")!;
    assert.equal(et0.sourceVariable, "et0_fao_evapotranspiration_sum"); assert.equal(et0.units, "mm");
    assert.equal(model.metrics.length, 6);
  }
  assert.match(data.scenario!, /HighResMIP/);
  assert.ok(data.warnings.some(value => value.includes("not weather forecasts")));
  assert.ok(data.warnings.some(value => value.includes("not a probability")));
});

test("one selected climate model uses unsuffixed daily keys", async () => {
  const query = { ...future, models: [CLIMATE_MODELS[1]] };
  const data = await fetchLandClimate(query, { climate: true, fetchImpl: mock(fixture(query, true, query.models)), now });
  assert.equal(data.models.length, 1); assert.equal(data.models[0].model, CLIMATE_MODELS[1]);
  assert.equal(data.models[0].metrics[0].series[2].value, 2);
});

test("daily normalization rejects shifted/gapped source dates, non-UTC data, wrong units and invalid values", async () => {
  for (const mutation of [
    (raw: ReturnType<typeof fixture>) => { (raw.daily.time as string[])[1] = "2024-03-01"; },
    (raw: ReturnType<typeof fixture>) => { raw.utc_offset_seconds = 3600; },
    (raw: ReturnType<typeof fixture>) => { raw.latitude = 91; },
    (raw: ReturnType<typeof fixture>) => { raw.daily_units.temperature_2m_mean = "°F"; },
    (raw: ReturnType<typeof fixture>) => { (raw.daily.precipitation_sum as unknown[])[1] = "3"; },
    (raw: ReturnType<typeof fixture>) => { (raw.daily.precipitation_sum as unknown[]).pop(); },
  ]) {
    const raw = fixture(historical); mutation(raw);
    await assert.rejects(fetchLandClimate(historical, { fetchImpl: mock(raw), now }), /source|Source/);
  }
  await assert.rejects(fetchLandClimate(historical, { fetchImpl: mock([fixture(historical)]), now }), /object/);
});

test("daily requests reject invalid dates, points and source-horizon/range overflow before fetching", () => {
  assert.equal(validDay("2024-02-29"), true); assert.equal(validDay("2023-02-29"), false); assert.equal(validDay("2024-02-30"), false);
  assert.deepEqual(dayRange("2024-02-28", "2024-03-01"), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  for (const query of [{ ...historical, latitude: NaN }, { ...historical, longitude: 181 }, { ...historical, start: "2024-02-30" }, { ...historical, end: "2024-02-27" }, { ...historical, start: "1939-12-31" }, { ...historical, end: "2026-11-10" }, { ...historical, start: "2020-01-01" }]) assert.throws(() => validateDailyPoint(query, false, now));
  assert.doesNotThrow(() => validateDailyPoint({ ...future, start: "2049-12-31", end: "2050-01-01" }, true, now));
  for (const query of [{ ...future, end: "2050-01-02" }, { ...future, start: "1949-12-31" }, { ...future, start: "2000-01-01" }, { ...future, models: [CLIMATE_MODELS[0], CLIMATE_MODELS[0]] }]) assert.throws(() => validateDailyPoint(query, true, now));
});

test("daily acquisition respects response size/status and caller cancellation", async () => {
  await assert.rejects(fetchLandClimate(historical, { fetchImpl: (async () => new Response("failure", { status: 503 })) as typeof fetch, now }), /503/);
  await assert.rejects(fetchLandClimate(historical, { fetchImpl: (async () => new Response("{}", { headers: { "content-length": "5000000" } })) as typeof fetch, now }), /4 MiB/);
  const abort = new AbortController(); abort.abort(); let called = false;
  await assert.rejects(fetchLandClimate(historical, { signal: abort.signal, fetchImpl: (async () => { called = true; return Response.json(fixture(historical)); }) as typeof fetch, now }), /abort/i);
  assert.equal(called, false);
});
