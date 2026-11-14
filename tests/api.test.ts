import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection, type AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createApi } from "../apps/api/src/server.ts";
import { pythonRunner, type ModelRunner } from "../apps/api/src/model-worker.ts";
import type { ResultManifest, RunSnapshot, Scenario } from "../packages/contracts/src/index.ts";

const sample: Scenario = JSON.parse(await readFile(new URL("../data/examples/scenario.json", import.meta.url), "utf8"));

async function launch(t: TestContext, options: Parameters<typeof createApi>[0] = {}) {
  const api = createApi(options);
  t.after(() => api.close());
  await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  return {
    base,
    get: (path: string) => fetch(new URL(path, base)),
    post: (body: unknown) => fetch(new URL("/v1/runs", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  };
}

async function terminal(get: (path: string) => Promise<Response>, path: string): Promise<RunSnapshot> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await get(path);
    assert.equal(response.status, 200);
    const run = await response.json() as RunSnapshot;
    if (run.status === "completed" || run.status === "failed") return run;
    await delay(20);
  }
  throw new Error("Run did not reach a terminal state");
}

test("real Node-to-Python run preserves accounting units, provenance and unavailable domains", { timeout: 15_000 }, async t => {
  const client = await launch(t);
  const response = await client.post(sample);
  assert.equal(response.status, 202);
  const job = await response.json() as { id: string; statusUrl: string; resultUrl: string; eventsUrl: string };
  const completed = await terminal(client.get, job.statusUrl);
  assert.equal(completed.status, "completed", completed.error?.message);
  const resultResponse = await client.get(job.resultUrl);
  assert.equal(resultResponse.status, 200);
  const result = await resultResponse.json() as ResultManifest;
  assert.equal(result.runId, job.id);
  assert.equal(result.provenance.kind, "synthetic");
  assert.equal(result.metrics.length, 4);
  const first = Object.fromEntries(result.metrics.map(metric => [metric.id, metric.series[0].value]));
  assert.equal(first.facility_electricity, 79_716_000);
  assert.equal(first.cooling_water_use, 30_660_000);
  assert.equal(first.grid_emissions, 19_929);
  assert.ok(Math.abs(first.facility_electricity_bill - 7_971_600) < 0.001);
  assert.ok(result.unavailable.some(item => item.domain === "noise"));
  assert.ok(result.unavailable.some(item => item.domain === "water-quality"));
  assert.deepEqual(result.layers, []);
  assert.ok(result.metrics.every(metric => metric.uncertainty.status === "not_quantified"));

  // The run already finished: reconnecting must still receive its terminal snapshot.
  const url = new URL(job.eventsUrl, client.base);
  url.protocol = "ws:";
  const snapshot = await new Promise<RunSnapshot>((resolve, reject) => {
    const socket = new WebSocket(url);
    t.after(() => socket.terminate());
    socket.once("error", reject);
    socket.once("message", data => {
      try { const event = JSON.parse(data.toString()); assert.equal(event.type, "run.status"); resolve(event.run); }
      catch (error) { reject(error); }
      finally { socket.close(); }
    });
  });
  assert.equal(snapshot.id, job.id);
  assert.equal(snapshot.status, "completed");
});

test("invalid scenarios are rejected before a worker can run", async t => {
  let called = false;
  const runner: ModelRunner = async () => { called = true; throw new Error("Must not run"); };
  const client = await launch(t, { runner });
  for (const mutate of [
    (scenario: Scenario) => { scenario.years.end = scenario.years.start - 1; },
    (scenario: Scenario) => { scenario.region.bbox = [10, 20, -10, 30]; },
    (scenario: Scenario) => { scenario.assumptions.pue = 0.9; },
    (scenario: Scenario) => { (scenario.assumptions as unknown as Record<string, unknown>).utilization = true; },
    (scenario: Scenario) => { (scenario as unknown as Record<string, unknown>).unrecognized = 123; }
  ]) {
    const scenario = structuredClone(sample);
    mutate(scenario);
    assert.equal((await client.post(scenario)).status, 422);
  }
  assert.equal(called, false);
});

test("malformed and oversized bodies return explicit client errors", async t => {
  const client = await launch(t);
  const malformed = await fetch(new URL("/v1/runs", client.base), { method: "POST", body: "{broken" });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(new URL("/v1/runs", client.base), { method: "POST", body: JSON.stringify({ text: "x".repeat(70_000) }) });
  assert.equal(oversized.status, 413);
});

test("results remain unavailable while a worker is running, then failures become terminal", async t => {
  let fail!: (error: Error) => void;
  const runner: ModelRunner = () => new Promise((_resolve, reject) => { fail = reject; });
  const client = await launch(t, { runner });
  const response = await client.post(sample);
  const job = await response.json() as { statusUrl: string; resultUrl: string };
  assert.equal((await client.get(job.resultUrl)).status, 409);
  fail(new Error("Fixture model is intentionally unavailable"));
  const run = await terminal(client.get, job.statusUrl);
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "MODEL_FAILED");
  assert.equal((await client.get(job.resultUrl)).status, 409);
});

test("capacity limits are explicit instead of silently deleting old results", async t => {
  const client = await launch(t, { maxRuns: 1 });
  const first = await client.post(sample);
  assert.equal(first.status, 202);
  const job = await first.json() as { statusUrl: string };
  await terminal(client.get, job.statusUrl);
  assert.equal((await client.post(sample)).status, 503);
  assert.equal((await client.get(job.statusUrl)).status, 200);
});

test("health, registry, and missing run behavior are discoverable", async t => {
  const client = await launch(t);
  assert.deepEqual(await (await client.get("/health")).json(), { status: "ok", schemaVersion: "1.0", mode: "illustrative" });
  const registry = await (await client.get("/v1/domains")).json() as { domains: Array<{ id: string; status: string }> };
  assert.equal(registry.domains.find(domain => domain.id === "noise")?.status, "planned");
  assert.equal(registry.domains.filter(domain => domain.status === "illustrative").length, 4);
  assert.equal((await client.get("/v1/runs/00000000-0000-0000-0000-000000000000")).status, 404);
});

test("an unavailable Python executable fails the job rather than returning invented output", async t => {
  const client = await launch(t, { runner: pythonRunner("goofy-goobers-python-that-does-not-exist", 1000) });
  const response = await client.post(sample);
  const job = await response.json() as { statusUrl: string };
  const run = await terminal(client.get, job.statusUrl);
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "MODEL_FAILED");
});

test("malformed WebSocket upgrade URLs do not crash the API", async t => {
  const client = await launch(t);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(client.base).port) });
    t.after(() => socket.destroy());
    socket.once("error", reject);
    socket.setTimeout(2000, () => reject(new Error("Malformed upgrade was not rejected")));
    socket.once("data", chunk => { resolve(chunk.toString()); socket.destroy(); });
    socket.once("connect", () => socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
  });
  assert.match(response, /^HTTP\/1.1 400/);
  assert.equal((await client.get("/health")).status, 200);
});
