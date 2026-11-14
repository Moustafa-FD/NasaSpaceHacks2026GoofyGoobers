import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { EnvironmentRequest, EnvironmentRun } from "../packages/contracts/src/environment.ts";

// Explicit live integration check; requires the local API and a completed sync.
// This verifies data plumbing, not the scientific accuracy of the source model.
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
async function json(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
async function run(request: EnvironmentRequest): Promise<any> {
  const submitted = await json("/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const status: EnvironmentRun = await json(submitted.statusUrl);
    if (status.status === "failed") throw new Error(status.error?.message ?? "Run failed");
    if (status.status === "completed") return json(submitted.resultUrl);
    await delay(500);
  }
  throw new Error(`Verification wait expired; inspect ${submitted.statusUrl}`);
}

const inventory = await json("/v1/inventory");
assert.equal(inventory.globalData?.complete, true, "Complete a global sync first");
const variables = ["T2M", "PRECTOTCORR", "RH2M", "WS2M"] as const;
for (const variable of variables) assert.equal(inventory.globalData.variables[variable]?.status, "complete");
const latest = inventory.globalData.variables.T2M.lastValidDate as string;
const pointRequest: EnvironmentRequest = { schemaVersion: "1.0", kind: "series", source: "power-grid", variables: [...variables], point: { latitude: 43.65, longitude: -79.38 }, start: "1981-01", end: new Date().toISOString().slice(0, 7) };
console.log("Checking all-history point series and missing-month handling...");
const point = await run(pointRequest);
assert.equal(point.timeStandard, "UTC");
assert.equal(point.globalCacheComplete, true);
assert.deepEqual(point.metrics.map((metric: any) => metric.variable).sort(), [...variables].sort(), "Point results must contain each requested variable exactly once");
for (const metric of point.metrics) {
  assert.equal(metric.series[0].date, "1981-01");
  for (const item of metric.series) {
    if (item.date > inventory.globalData.variables[metric.variable].lastValidDate) {
      assert.equal(item.value, null);
      assert.equal(item.coverageFraction, 0);
    } else assert.equal(typeof item.value, "number");
  }
}
console.log(`Checking the global temperature grid for ${latest}...`);
const frame = await run({ schemaVersion: "1.0", kind: "grid", source: "power-grid", variables: ["T2M"], date: latest });
assert.deepEqual(frame.grid.shape, [361, 576]);
assert.equal(frame.grid.values.length, 361 * 576);
const sourcePoint = point.selection.sourcePoint;
const row = frame.grid.latitudes.indexOf(sourcePoint.latitude);
const column = frame.grid.longitudes.indexOf(sourcePoint.longitude);
assert.ok(row >= 0 && column >= 0);
const cell = frame.grid.values[row * frame.grid.shape[1] + column];
const seriesValue = point.metrics.find((metric: any) => metric.variable === "T2M").series.find((item: any) => item.date === latest).value;
assert.ok(Math.abs(cell - seriesValue) <= 0.000001, "Grid and point values must agree within grid JSON rounding");
const cached = await run(pointRequest);
assert.equal(cached.cache.hit, true);
const report = { verifiedAt: new Date().toISOString(), sourceUrl: point.sourceUrl, timeStandard: point.timeStandard, availableThrough: latest, variables, gridShape: frame.grid.shape, point: sourcePoint, checks: ["all-history point series", "unavailable months remain null", "global grid shape", "grid/point consistency", "derived cache hit"], scientificValidation: false };
await mkdir(new URL("../data/runs/environment/", import.meta.url), { recursive: true });
await writeFile(new URL("../data/runs/environment/live-verification.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
