import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../apps/api/src/server.ts";
import { EnvironmentStore } from "../apps/api/src/environment/store.ts";
import { validateEnvironmentRequest, type EnvironmentRun } from "../packages/contracts/src/environment.ts";

/** Synthetic monthly series with a known trend, seasonal cycle and deterministic noise (not real data). */
function synthetic(years: number, trendPerYear: number, seed = 7, startYear = 2001) {
  let state = seed;
  const noise = () => { state = (state * 1103515245 + 12345) % 2147483648; return (state / 2147483648 - 0.5) * 0.6; };
  const points: Array<{ date: string; value: number | null }> = [];
  for (let i = 0; i < years * 12; i++) {
    const year = startYear + Math.floor(i / 12), month = (i % 12) + 1;
    points.push({ date: `${year}-${String(month).padStart(2, "0")}`, value: 15 + trendPerYear * i / 12 + 8 * Math.sin(2 * Math.PI * (month - 4) / 12) + noise() });
  }
  return points;
}

async function launch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "spaceapps-trend-"));
  const store = new EnvironmentStore(root);
  const api = await createApi({ store });
  await new Promise<void>(done => api.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await api.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("spaceapps-trend-")) throw new Error("Refusing unexpected temporary cleanup path");
    await rm(root, { recursive: true, force: true });
  });
  const post = async (body: unknown) => {
    const response = await fetch(new URL("/v1/runs", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const finish = async (id: string): Promise<{ run: EnvironmentRun; result?: Record<string, any> }> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const run = await (await fetch(new URL(`/v1/runs/${id}`, base))).json() as EnvironmentRun;
      if (run.status === "completed") return { run, result: await (await fetch(new URL(`/v1/runs/${id}/results`, base))).json() as Record<string, any> };
      if (run.status === "failed") return { run };
      await delay(100);
    }
    throw new Error("trend run did not finish");
  };
  return { store, post, finish };
}

test("trend-analysis validation accepts run and inline inputs and rejects malformed requests", () => {
  const ok = { schemaVersion: "1.0", kind: "trend-analysis", input: { series: { label: "x", unit: "K", points: synthetic(1, 0).slice(0, 5) } } };
  assert.deepEqual(validateEnvironmentRequest(ok), []);
  assert.deepEqual(validateEnvironmentRequest({ schemaVersion: "1.0", kind: "trend-analysis", input: { runId: "abc-123", variable: "T2M" }, cadence: "annual" }), []);
  const bad = [
    { ...ok, input: { runId: "abc", variable: "T2M", series: {} } },
    { ...ok, input: { series: { label: "x", unit: "K", points: [{ date: "2020-01", value: 1 }] } } },
    { ...ok, input: { series: { label: "x", unit: "K", points: [{ date: "2020-01", value: 1 }, { date: "2020-01", value: 2 }, { date: "2020-02", value: 3 }] } } },
    { ...ok, input: { series: { label: "x", unit: "K", points: [{ date: "Jan 2020", value: 1 }, { date: "2020-02", value: 2 }, { date: "2020-03", value: 3 }] } } },
    { ...ok, alpha: 0.5 }, { ...ok, cadence: "weekly" }, { ...ok, extra: true },
    { ...ok, control: ok.input, cadence: "annual" },
  ];
  for (const request of bad) assert.notDeepEqual(validateEnvironmentRequest(request), [], JSON.stringify(request).slice(0, 120));
});

test("inline series: recovers a known trend through the job API with provenance", async t => {
  const { post, finish } = await launch(t);
  const accepted = await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { series: { label: "Synthetic temperature", unit: "K", source: "unit-test", points: synthetic(20, 0.05) } } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const { run, result } = await finish(accepted.body.id);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(result!.kind, "trend-analysis");
  assert.equal(result!.evidence, "statistical-analysis");
  assert.equal(result!.report.status, "ok");
  assert.equal(result!.report.direction, "increasing");
  const [low, high] = result!.report.sen.ciPerDecade;
  assert.ok(low < 0.5 && 0.5 < high, `CI ${low}..${high} should contain the true 0.5/decade`);
  assert.equal(result!.inputs[0].kind, "inline");
  assert.match(result!.inputs[0].inputSha256, /^[0-9a-f]{64}$/);
});

test("run reference: analyses a completed point-series run's variable at annual cadence", async t => {
  const { store, post, finish } = await launch(t);
  await store.write(store.processedDirectory, "run-fixture-power", {
    schemaVersion: "1.0", kind: "series", evidence: "model-derived", sourceUrl: "https://power.larc.nasa.gov/fixture", rawSha256: "b".repeat(64),
    variables: [{ id: "T2M", label: "Temperature at 2 Meters", unit: "C", series: synthetic(15, 0.04).map(p => ({ ...p, quality: "valid" })) }],
  });
  const accepted = await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { runId: "fixture-power", variable: "T2M" }, cadence: "annual" });
  const { run, result } = await finish(accepted.body.id);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(result!.report.cadence, "annual");
  assert.equal(result!.report.mannKendall.variant, "hamed_rao");
  assert.deepEqual(result!.inputs[0].runIds, ["fixture-power"]);
  assert.equal(result!.inputs[0].evidence, "model-derived");
  assert.equal(result!.target.unit, "C");
});

test("control comparison and failure modes", async t => {
  const { post, finish } = await launch(t);
  const points = synthetic(15, 0.05);
  const same = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { series: { label: "a", unit: "K", points } }, control: { series: { label: "b", unit: "K", points } } })).body.id);
  assert.equal(same.run.status, "completed", JSON.stringify(same.run.error));
  assert.equal(same.result!.report.target.direction, "increasing");
  assert.equal(same.result!.report.difference.direction, "no significant trend");
  const incompatible = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { series: { label: "target", unit: "degC", points } }, control: { series: { label: "control", unit: "degF", points } } })).body.id);
  assert.equal(incompatible.run.status, "failed");
  assert.match(incompatible.run.error!.message, /different units/);

  const short = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { series: { label: "short", unit: "K", points: synthetic(4, 0.05) } } })).body.id);
  assert.equal(short.run.status, "completed");
  assert.equal(short.result!.report.status, "insufficient_data");
  assert.equal(short.result!.report.sen, undefined);

  const missing = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { runId: "does-not-exist", variable: "T2M" } })).body.id);
  assert.equal(missing.run.status, "failed");
  assert.match(missing.run.error!.message, /no completed result/);
});

/** Daily synthetic values with a known trend for Part 1-shaped fixtures (not real data). */
function dailyFixture(startYear: number, years: number, perYear: number) {
  const out: Array<{ date: string; value: number | null }> = [];
  for (let d = Date.UTC(startYear, 0, 1); d < Date.UTC(startYear + years, 0, 1); d += 86_400_000) {
    const date = new Date(d), t = (d - Date.UTC(2000, 0, 1)) / (365.25 * 86_400_000);
    out.push({ date: date.toISOString().slice(0, 10), value: 12 + perYear * t + 9 * Math.sin(2 * Math.PI * (date.getUTCMonth() - 3) / 12) });
  }
  return out;
}

test("Part 1 → Part 2: stitches consecutive land-water runs and refuses unsafe merges", async t => {
  const { store, post, finish } = await launch(t);
  const ids: string[] = [];
  for (let y = 2004; y < 2024; y += 2) {
    const id = `era5-${y}`; ids.push(id);
    await store.write(store.processedDirectory, `run-${id}`, { schemaVersion: "1.0", kind: "land-water", evidence: "model-derived", sourceUrl: `https://archive-api.open-meteo.com/fixture/${y}`,
      models: [{ model: "era5", metrics: [{ id: "temperature_2m_mean", units: "°C", series: dailyFixture(y, 2, 0.05) }] }] });
  }
  const ok = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { runIds: ids, variable: "temperature_2m_mean" } })).body.id);
  assert.equal(ok.run.status, "completed", JSON.stringify(ok.run.error));
  assert.equal(ok.result!.report.direction, "increasing");
  assert.equal(ok.result!.inputs[0].resultKind, "land-water");
  assert.equal(ok.result!.inputs[0].sources.length, 10);
  const [low, high] = ok.result!.report.sen.ciPerDecade;
  assert.ok(low <= 0.5 + 1e-9 && high >= 0.5 - 1e-9, `CI ${low}..${high} should contain the true 0.5/decade`);

  await store.write(store.processedDirectory, "run-scenario", { schemaVersion: "1.0", kind: "climate", evidence: "climate-scenario",
    models: [{ model: "MRI_AGCM3_2_S", metrics: [{ id: "temperature_2m_mean", units: "°C", series: dailyFixture(2030, 2, 0.05) }] }] });
  const mixed = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { runIds: [...ids, "scenario"], variable: "temperature_2m_mean" } })).body.id);
  assert.equal(mixed.run.status, "failed");
  assert.match(mixed.run.error!.message, /mix evidence types/);
});

test("Part 1 → Part 2: hourly air quality becomes daily means; censored water quality stays missing", async () => {
  const { extractVariable, toDaily } = await import("../apps/api/src/environment/trends.ts");
  const grid = extractVariable({kind:'series',metrics:[{variable:'T2M',units:'C',series:[{date:'2000-01',value:10},{date:'2000-02',value:null}]}]},'grid','T2M');
  assert.equal(grid.unit,'C');
  assert.deepEqual(grid.points,[{date:'2000-01',value:10},{date:'2000-02',value:null}]);
  const hourly = toDaily([{ date: "2024-01-01T00:00", value: 10 }, { date: "2024-01-01T12:00", value: 20 }, { date: "2024-01-02T00:00", value: null }]);
  assert.deepEqual(hourly, [{ date: "2024-01-01", value: 15 }, { date: "2024-01-02", value: null }]);
  const water = extractVariable({ kind: "water-quality", evidence: "ground-observation", records: [
    { parameterCode: "00010", parameterName: "Temperature, water", unit: "degC", sourceTime: "2026-11-01T00:00:00Z", valueStatus: "numeric", value: 12.5 },
    { parameterCode: "00010", parameterName: "Temperature, water", unit: "degC", sourceTime: "2026-11-02T00:00:00Z", valueStatus: "censored", value: 0.5 },
    { parameterCode: "00300", parameterName: "Dissolved oxygen", unit: "mg/l", sourceTime: "2026-11-01T00:00:00Z", valueStatus: "numeric", value: 8 },
  ] }, "wq", "00010");
  assert.equal(water.unit, "degC");
  assert.deepEqual(water.points.map(p => p.value), [12.5, null]);
  assert.throws(() => extractVariable({ kind: "facilities-sync" }, "f", "x"), /no time series/);
  assert.throws(() => extractVariable({ kind: "climate", models: [{ model: "A", metrics: [] }, { model: "B", metrics: [] }] }, "c", "x"), /needs model/);
});

test("CORS: allow-listed front ends can call the API; others are refused", async t => {
  const root = await mkdtemp(join(tmpdir(), "spaceapps-trend-"));
  const api = await createApi({ store: new EnvironmentStore(root) });
  await new Promise<void>(done => api.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  const allowed = await fetch(`${base}/v1/runs`, { method: "OPTIONS", headers: { origin: "http://localhost:8765", "access-control-request-method": "POST" } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:8765");
  const health = await fetch(`${base}/v1/domains`, { headers: { origin: "https://moustafa-fd.github.io" } });
  assert.equal(health.headers.get("access-control-allow-origin"), "https://moustafa-fd.github.io");
  const denied = await fetch(`${base}/v1/runs`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});
