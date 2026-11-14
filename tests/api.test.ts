import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConnection, type AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createApi } from "../apps/api/src/server.ts";
import { EnvironmentStore } from "../apps/api/src/environment/store.ts";
import type { EnvironmentExecutor } from "../apps/api/src/environment/service.ts";
import type { EnvironmentRequest, EnvironmentRun } from "../packages/contracts/src/environment.ts";

const sample: EnvironmentRequest = { schemaVersion: "1.0", kind: "series", source: "power-grid", variables: ["T2M"], start: "2024-01", end: "2024-12", bbox: [-180, -90, 180, 90] };
const fixture: EnvironmentExecutor = async (request, _signal, report) => {
  report(50, "reading-fixture");
  return { evidence: "test_fixture", request, metrics: [{ variable: "T2M", units: "C", series: [{ date: "2024-01", value: 0 }] }] };
};

async function launch(t: TestContext, executor: EnvironmentExecutor = fixture) {
  const root = await mkdtemp(join(tmpdir(), "spaceapps-env-"));
  const store = new EnvironmentStore(root);
  let api = await createApi({ store, executor });
  const listen = async () => {
    await new Promise<void>(resolve => api.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  };
  let base = await listen();
  t.after(async () => {
    await api.close();
    if (dirname(resolvePath(root)) !== resolvePath(tmpdir()) || !basename(root).startsWith("spaceapps-env-")) throw new Error("Refusing unexpected temporary cleanup path");
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    get base() { return base; },
    get: (path: string) => fetch(new URL(path, base)),
    post: (body: unknown) => fetch(new URL("/v1/runs", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    restart: async () => { await api.close(); api = await createApi({ store, executor }); base = await listen(); }
  };
}

async function terminal(get: (path: string) => Promise<Response>, path: string): Promise<EnvironmentRun> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await get(path);
    assert.equal(response.status, 200);
    const run = await response.json() as EnvironmentRun;
    if (run.status === "completed" || run.status === "failed") return run;
    await delay(20);
  }
  throw new Error("Environmental run did not reach a terminal state");
}

test("environmental jobs deliver results, late WebSocket snapshots, and restart persistence", async t => {
  const client = await launch(t);
  const response = await client.post(sample);
  assert.equal(response.status, 202);
  const job = await response.json() as { id: string; statusUrl: string; resultUrl: string; eventsUrl: string };
  const run = await terminal(client.get, job.statusUrl);
  assert.equal(run.status, "completed", run.error?.message);
  const result = await (await client.get(job.resultUrl)).json() as { evidence: string; metrics: Array<{ series: Array<{ value: number }> }> };
  assert.equal(result.evidence, "test_fixture");
  assert.equal(result.metrics[0].series[0].value, 0);
  const url = new URL(job.eventsUrl, client.base); url.protocol = "ws:";
  const snapshot = await new Promise<EnvironmentRun>((resolve, reject) => {
    const socket = new WebSocket(url);
    t.after(() => socket.terminate());
    socket.once("error", reject);
    socket.once("message", data => {
      try { const event = JSON.parse(data.toString()); assert.equal(event.type, "run.status"); resolve(event.run); }
      catch (error) { reject(error); }
      finally { socket.close(); }
    });
  });
  assert.equal(snapshot.status, "completed");
  await client.restart();
  assert.equal((await (await client.get(job.statusUrl)).json() as EnvironmentRun).status, "completed");
  assert.deepEqual(await (await client.get(job.resultUrl)).json(), result);
});

test("invalid environmental and obsolete accounting requests never execute", async t => {
  let calls = 0;
  const client = await launch(t, async (...args) => { calls++; return fixture(...args); });
  for (const request of [
    { ...sample, end: "2099-01" },
    { ...sample, bbox: [10, 20, -10, 30] },
    { ...sample, point: { latitude: true, longitude: 0 }, bbox: undefined },
    { ...sample, source: "https://untrusted.example/data" },
    { ...sample, variables: ["PM25"] },
    { ...sample, unrecognized: 1 },
    { schemaVersion: "1.0", mode: "illustrative", assumptions: { electricityPricePerKwh: 1 } },
    { schemaVersion: "1.0", kind: "grid", source: "power-grid", date: "2024-01", variables: ["T2M", "RH2M"] }
  ]) assert.equal((await client.post(request)).status, 422);
  assert.equal(calls, 0);
});

test("malformed and oversized requests have bounded client errors", async t => {
  const client = await launch(t);
  assert.equal((await fetch(new URL("/v1/runs", client.base), { method: "POST", body: "{broken" })).status, 400);
  assert.equal((await fetch(new URL("/v1/runs", client.base), { method: "POST", body: JSON.stringify({ text: "x".repeat(70_000) }) })).status, 413);
});

test("failed data operations have persistent terminal errors and unavailable results", async t => {
  let rejectWorker!: (reason: Error) => void;
  let workerStarted!: () => void;
  const started = new Promise<void>(resolve => { workerStarted = resolve; });
  const client = await launch(t, async () => new Promise((_resolve, reject) => { rejectWorker = reject; workerStarted(); }));
  const response = await client.post(sample);
  const job = await response.json() as { statusUrl: string; resultUrl: string };
  assert.equal((await client.get(job.resultUrl)).status, 409);
  await started;
  rejectWorker(new Error("Source login required; no fabricated fallback"));
  const run = await terminal(client.get, job.statusUrl);
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "DATA_ACQUISITION_FAILED");
  assert.equal((await client.get(job.resultUrl)).status, 409);
  await client.restart();
  assert.equal((await (await client.get(job.statusUrl)).json() as EnvironmentRun).status, "failed");
});

test("inventory distinguishes metadata, incomplete downloaded coverage and unavailable domains", async t => {
  const client = await launch(t);
  await client.store.write(client.store.processedDirectory, "catalog", { access: "metadata_only", records: [{ shortName: "OMNO2d" }] });
  await client.store.write(join(client.store.rawDirectory, "power-grid"), "inventory", { complete: false, variables: { T2M: { status: "partial" } } });
  const inventory = await (await client.get("/v1/inventory")).json() as { globalData: { complete: boolean }; catalog: { access: string } };
  assert.equal(inventory.globalData.complete, false);
  assert.equal(inventory.catalog.access, "metadata_only");
  const domains = await (await client.get("/v1/domains")).json() as { domains: Array<{ id: string }> };
  assert.ok(domains.domains.some(domain => domain.id === "noise"));
  assert.ok(!domains.domains.some(domain => domain.id === "population" || domain.id === "household-bills"));
  const sources = await (await client.get("/v1/sources")).json() as { sources: Array<{ id: string; access: string }> };
  assert.equal(sources.sources.find(source => source.id === "giovanni")?.access, "earthdata_login_required");
});

test("unfinished saved runs are marked interrupted after restart", async t => {
  const client = await launch(t);
  const id = "00000000-0000-0000-0000-000000000001";
  await client.store.write(client.store.runsDirectory, id, { id, status: "running", progress: 20, stage: "sync:T2M", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", request: sample });
  await client.restart();
  const run = await (await client.get(`/v1/runs/${id}`)).json() as EnvironmentRun;
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "INTERRUPTED");
});

test("health and unknown-run behavior match the environmental API", async t => {
  const client = await launch(t);
  assert.equal((await (await client.get("/health")).json() as { mode: string }).mode, "environmental");
  assert.equal((await client.get("/v1/runs/00000000-0000-0000-0000-000000000000")).status, 404);
});

test("malformed WebSocket request-targets do not crash the API", async t => {
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
