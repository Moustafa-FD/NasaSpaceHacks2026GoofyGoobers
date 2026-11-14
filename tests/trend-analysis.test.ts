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
  assert.equal(result!.inputs[0].runId, "fixture-power");
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

  const short = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { series: { label: "short", unit: "K", points: synthetic(4, 0.05) } } })).body.id);
  assert.equal(short.run.status, "completed");
  assert.equal(short.result!.report.status, "insufficient_data");
  assert.equal(short.result!.report.sen, undefined);

  const missing = await finish((await post({ schemaVersion: "1.0", kind: "trend-analysis", input: { runId: "does-not-exist", variable: "T2M" } })).body.id);
  assert.equal(missing.run.status, "failed");
  assert.match(missing.run.error!.message, /no completed result/);
});
