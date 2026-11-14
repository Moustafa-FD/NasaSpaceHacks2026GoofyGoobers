import test from "node:test";
import assert from "node:assert/strict";
import { fetchPowerSeries, type PowerSeriesQuery } from "../apps/api/src/environment/power.ts";

const query: PowerSeriesQuery = { latitude: 39, longitude: -77.5, start: "2024-01", end: "2024-03", variables: ["T2M", "PRECTOTCORR", "RH2M", "WS2M"] };

function fixture() {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-77.5, 39, 120.54] },
    properties: { parameter: {
      T2M: { "202312": -2, "202401": 0, "202402": -999, "202403": 8.03, "202404": 15, "202413": 14.2 },
      PRECTOTCORR: { "202401": 4.91, "202402": 1.88, "202403": 3.55, "202413": 2.63 },
      RH2M: { "202401": 86.69, "202402": 83.09, "202413": 74.46 },
      WS2M: { "202401": 2.2, "202402": 2.08, "202403": 2.4, "202413": 1.84 }
    } },
    header: { fill_value: -999, time_standard: "LST", sources: ["MERRA2", "POWER"] },
    parameters: {
      T2M: { units: "C", longname: "Temperature at 2 Meters" },
      PRECTOTCORR: { units: "mm/day", longname: "Precipitation Corrected" },
      RH2M: { units: "%", longname: "Relative Humidity at 2 Meters" },
      WS2M: { units: "m/s", longname: "Wind Speed at 2 Meters" }
    },
    messages: []
  };
}

test("POWER point adapter preserves units, zeroes, missing slots and provenance while excluding annual summaries", async () => {
  const raw = fixture();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.origin, "https://power.larc.nasa.gov");
    assert.equal(url.pathname, "/api/temporal/monthly/point");
    assert.equal(url.searchParams.get("community"), "RE");
    assert.equal(url.searchParams.get("start"), "2024");
    assert.equal(url.searchParams.get("end"), "2024");
    assert.equal(url.searchParams.get("parameters"), "T2M,PRECTOTCORR,RH2M,WS2M");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json(raw);
  }) as typeof fetch;
  const result = await fetchPowerSeries(query, { fetchImpl });
  assert.equal(result.sourceId, "nasa-power");
  assert.equal(result.evidence, "model-derived");
  assert.deepEqual(result.raw, raw);
  assert.deepEqual(result.location.reportedCoordinates, [-77.5, 39, 120.54]);
  const temperature = result.variables.find(variable => variable.id === "T2M")!;
  assert.equal(temperature.label, "Temperature at 2 Meters");
  assert.equal(temperature.unit, "C");
  assert.deepEqual(temperature.series, [
    { date: "2024-01", value: 0, quality: "valid" },
    { date: "2024-02", value: null, quality: "missing" },
    { date: "2024-03", value: 8.03, quality: "valid" }
  ]);
  assert.equal(result.variables.find(variable => variable.id === "RH2M")!.series[2].value, null);
  assert.equal(result.variables.find(variable => variable.id === "PRECTOTCORR")!.unit, "mm/day");
  assert.ok(result.warnings.some(warning => warning.includes("not monthly precipitation totals")));
  assert.ok(result.variables.every(variable => variable.series.length === 3));
  assert.ok(result.variables.every(variable => variable.series.every(point => !point.date.endsWith("-13"))));
});

test("POWER adapter validates dates, variable allow-list, numeric bounds and maximum request size before fetching", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return Response.json(fixture()); }) as typeof fetch;
  const badQueries: PowerSeriesQuery[] = [
    { ...query, latitude: 91 }, { ...query, longitude: NaN },
    { ...query, start: "1980-12" }, { ...query, start: "2024-04" },
    { ...query, start: "2024-1" }, { ...query, end: "2024-13" },
    { ...query, end: "2026-12" },
    { ...query, variables: [] }, { ...query, variables: ["T2M", "T2M"] },
    { ...query, variables: ["NO2"] }, { ...query, variables: ["T2M", "PRECTOTCORR", "RH2M", "WS2M", "T2M_MAX"] }
  ];
  for (const invalid of badQueries) await assert.rejects(fetchPowerSeries(invalid, { fetchImpl, now: new Date("2026-11-14T00:00:00Z") }));
  assert.equal(called, false);
});

test("POWER fill values come from metadata instead of a guessed constant", async () => {
  const raw = fixture();
  raw.header.fill_value = -777;
  raw.properties.parameter.T2M["202401"] = -777;
  raw.properties.parameter.T2M["202402"] = -999;
  const result = await fetchPowerSeries({ ...query, variables: ["T2M"] }, { fetchImpl: (async () => Response.json(raw)) as typeof fetch });
  assert.equal(result.variables[0].series[0].value, null);
  assert.equal(result.variables[0].series[1].value, -999);
});

test("POWER HTTP and response metadata failures are surfaced instead of inventing series or units", async () => {
  await assert.rejects(fetchPowerSeries(query, { fetchImpl: (async () => new Response("rate limit", { status: 429 })) as typeof fetch }), /HTTP 429/);
  await assert.rejects(fetchPowerSeries(query, { fetchImpl: (async () => Response.json({ properties: {} })) as typeof fetch }), /invalid point-series response/);
  const raw = fixture();
  raw.parameters.T2M.units = "";
  await assert.rejects(fetchPowerSeries(query, { fetchImpl: (async () => Response.json(raw)) as typeof fetch }), /lacks values or units for T2M/);
});

test("POWER adapter produces chronological monthly slots across a year boundary", async () => {
  const raw = fixture();
  const result = await fetchPowerSeries({ ...query, start: "2023-12", end: "2024-02", variables: ["T2M"] }, { fetchImpl: (async () => Response.json(raw)) as typeof fetch });
  assert.deepEqual(result.variables[0].series.map(point => point.date), ["2023-12", "2024-01", "2024-02"]);
  assert.equal(result.variables[0].series[0].value, -2);
});

test("POWER adapter respects caller cancellation before starting a request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  let called = false;
  await assert.rejects(fetchPowerSeries(query, { signal: controller.signal, fetchImpl: (async () => { called = true; return Response.json(fixture()); }) as typeof fetch }), /caller cancelled/);
  assert.equal(called, false);
});
