import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { EnvironmentCapacityError, EnvironmentJobs } from "../apps/api/src/environment/jobs.ts";
import { EnvironmentStore } from "../apps/api/src/environment/store.ts";
import type { EnvironmentRequest, EnvironmentRun } from "../packages/contracts/src/environment.ts";

const request: EnvironmentRequest = { schemaVersion: "1.0", kind: "series", source: "power-grid", variables: ["T2M"], start: "2024-01", end: "2024-12", bbox: [-180, -90, 180, 90] };

class MemoryStore extends EnvironmentStore {
  values = new Map<string, unknown>();
  beforeWrite: (directory: string, key: string, value: unknown) => Promise<void> = async () => {};
  constructor() { super(tmpdir()); }
  override async init(): Promise<void> {}
  override async list(_directory: string): Promise<string[]> { return []; }
  override async read<T>(directory: string, key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(`${directory}/${key}`)) as T | undefined;
  }
  override async write(directory: string, key: string, value: unknown): Promise<void> {
    await this.beforeWrite(directory, key, value);
    this.values.set(`${directory}/${key}`, structuredClone(value));
  }
}

async function terminal(jobs: EnvironmentJobs, id: string): Promise<EnvironmentRun> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const run = jobs.get(id)!;
    if (run.status === "completed" || run.status === "failed") return run;
    await delay(2);
  }
  throw new Error("Run did not finish");
}

test("concurrent initial persistence cannot exceed the 16 waiting-job limit", async t => {
  const store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pendingInitialWrites = 0;
  store.beforeWrite = async (_directory, _key, value) => {
    if ((value as EnvironmentRun).status === "queued") { pendingInitialWrites++; await gate; }
  };
  const jobs = new EnvironmentJobs(store, async () => ({ fixture: true }));
  await jobs.init();
  t.after(() => jobs.close());
  const submissions = Array.from({ length: 17 }, () => jobs.create(request));
  const settled = Promise.allSettled(submissions);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pendingInitialWrites, 16);
  release();
  const results = await settled;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 16);
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof EnvironmentCapacityError);
  for (const result of results) if (result.status === "fulfilled") assert.equal((await terminal(jobs, result.value.id)).status, "completed");
});

test("a failed initial write rejects creation and releases reserved capacity", async t => {
  const store = new MemoryStore();
  let failOnce = true;
  store.beforeWrite = async (_directory, _key, value) => {
    if ((value as EnvironmentRun).status === "queued" && failOnce) { failOnce = false; throw new Error("Initial write unavailable"); }
  };
  const jobs = new EnvironmentJobs(store, async () => ({ fixture: true }));
  await jobs.init();
  t.after(() => jobs.close());
  await assert.rejects(jobs.create(request), /Initial write unavailable/);
  const accepted = await Promise.all(Array.from({ length: 16 }, () => jobs.create(request)));
  assert.equal(accepted.length, 16);
  for (const run of accepted) assert.equal((await terminal(jobs, run.id)).status, "completed");
});

test("persistent disk failures leave terminal HTTP/event state in memory and do not stop later jobs", async t => {
  t.mock.method(console, "error", () => {});
  const store = new MemoryStore();
  store.beforeWrite = async (_directory, _key, value) => {
    if (["running", "failed", "completed"].includes((value as EnvironmentRun).status)) throw new Error("ENOSPC simulated disk full");
  };
  let executions = 0;
  const jobs = new EnvironmentJobs(store, async () => { executions++; return { fixture: true }; });
  await jobs.init();
  t.after(() => jobs.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = await jobs.create(request);
    const eventRun = await new Promise<EnvironmentRun>(resolve => {
      jobs.subscribe(created.id, () => { throw new Error("Broken fixture listener"); });
      jobs.subscribe(created.id, event => { if (event.run.status === "failed") resolve(event.run); });
    });
    assert.equal(eventRun.error?.code, "RUN_PERSISTENCE_FAILED");
    assert.match(eventRun.error!.message, /memory only/);
    assert.match(eventRun.error!.message, /ENOSPC/);
    assert.equal(eventRun.resultUrl, undefined);
    assert.equal(jobs.get(created.id)!.status, "failed");
    const saved = await store.read<EnvironmentRun>(store.runsDirectory, created.id);
    assert.equal(saved!.status, "queued", "The API must not pretend the terminal state was persisted");
  }
  assert.equal(executions, 0, "Work should not start after its running state cannot be saved");
});

test("result-storage failure is persisted as failure instead of reporting a completed run", async t => {
  const store = new MemoryStore();
  store.beforeWrite = async directory => { if (directory === store.processedDirectory) throw new Error("Result storage unavailable"); };
  const jobs = new EnvironmentJobs(store, async () => ({ fixture: true }));
  await jobs.init();
  t.after(() => jobs.close());
  const created = await jobs.create(request);
  const failed = await terminal(jobs, created.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "DATA_ACQUISITION_FAILED");
  assert.match(failed.error!.message, /Result storage unavailable/);
  assert.equal(failed.resultUrl, undefined);
  const saved = await store.read<EnvironmentRun>(store.runsDirectory, created.id);
  assert.equal(saved!.status, "failed");
  assert.equal(await jobs.result(created.id), undefined);
});
