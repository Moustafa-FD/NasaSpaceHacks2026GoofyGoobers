import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createApi } from "../apps/api/src/server.ts";
import { EnvironmentStore } from "../apps/api/src/environment/store.ts";
import { runEnvironmentScreening } from "../apps/api/src/environment/screening.ts";
import { validateEnvironmentRequest } from "../packages/contracts/src/environment.ts";
import { SCREENING_INPUTS, type EnvironmentScreeningRequest } from "../packages/contracts/src/screening.ts";

const source = { evidence: "assumed", citation: "Explicit test scenario only; no real facility parameters", url: "https://www.epa.gov/npdes/npdes-permit-writers-manual" } as const;
const base: EnvironmentScreeningRequest = { schemaVersion: "1.0", kind: "environment-screening", siteId: "colossus1", years: [{ year: 2030 }] };

test("screening API accepts missing-input requests and requires provenance on every supplied annual record", () => {
  assert.deepEqual(validateEnvironmentRequest(base), []);
  const full = { ...base, years: [{ year: 2030, source, heatMw: 10, emissionRateGs: 1, pollutant: "inert tracer", withdrawalM3s: .1, returnM3s: .08, riverFlowM3s: 9, upstreamTempC: 10, dischargeTempC: 30, upstreamMgL: 2, dischargeMgL: 12, soundPowerDbA: 100 }],
    dispersion: { effectiveHeightM: 20, landUse: "urban", airDensityKgM3: 1.2, specificHeatJkgK: 1005, source }, receptors: [{ name: "Example receptor", distanceM: 100 }], noiseContourLevelsDbA: [40, 50, 60], backgroundNoise: { dbA: 35, source } };
  assert.deepEqual(validateEnvironmentRequest(full), []);
  assert.deepEqual(validateEnvironmentRequest({ ...base, siteId: undefined, point: { latitude: 39, longitude: -77 } }), []);
  for (const value of [
    { ...base, years: [{ year: 2030, heatMw: 1 }] },
    { ...base, years: [{ year: 2030, source, heatMw: true }] },
    { ...base, years: [{ year: 2030, source, heatMw: NaN }] },
    { ...base, years: [{ year: 2030 }, { year: 2030 }] },
    { ...base, years: [{ year: 2101 }] },
    { ...base, years: [{ year: 2030, source, withdrawalM3s: 1, returnM3s: 2 }] },
    { ...base, years: [{ year: 2030, source: { ...source, url: "https://user:password@example.com" }, soundPowerDbA: 100 }] },
    { ...base, point: { latitude: 39, longitude: -77 } },
    { ...base, siteId: "../../private" },
    { ...full, dispersion: { ...full.dispersion, effectiveHeightM: 0 } },
    { ...full, noiseContourLevelsDbA: [40, 40] },
    { ...full, noiseContourLevelsDbA: [40, 50, 60, 70, 80, 90] },
    { ...full, receptors: [{ name: "bad", distanceM: 0 }] },
    { ...full, backgroundNoise: { dbA: 30 } },
  ]) assert.notDeepEqual(validateEnvironmentRequest(value), [], JSON.stringify(value));
  assert.match(SCREENING_INPUTS.noise.description, /not legal\/health limits/);
});

test("actual Node job runs the additive Python worker and returns sourced water/noise values and missing-input guidance", async t => {
  const directory = await mkdtemp(join(tmpdir(), "spaceapps-screening-"));
  const api = await createApi({ store: new EnvironmentStore(directory) });
  await new Promise<void>(done => api.server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await api.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("spaceapps-screening-")) throw new Error("Refusing unexpected temporary cleanup");
    await rm(directory, { recursive: true, force: true });
  });
  const payload = { ...base, years: [{ year: 2030, source, withdrawalM3s: 1, returnM3s: .25, riverFlowM3s: 9, upstreamTempC: 10, dischargeTempC: 30, soundPowerDbA: 100 }], receptors: [{ name: "Explicit test distance", distanceM: 100 }], noiseContourLevelsDbA: [50, 60] };
  const accepted = await fetch(`${url}/v1/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json() as { id: string };
  const deadline = Date.now() + 30000;
  let status: Record<string, any> = {};
  while (Date.now() < deadline) {
    status = await (await fetch(`${url}/v1/runs/${receipt.id}`)).json() as Record<string, any>;
    if (["completed", "failed"].includes(status.status)) break;
    await delay(50);
  }
  assert.equal(status.status, "completed", JSON.stringify(status.error));
  const result = await (await fetch(`${url}/v1/runs/${receipt.id}/results`)).json() as Record<string, any>;
  assert.equal(result.evidence, "screening-scenario");
  assert.equal(result.kind, "environment-screening");
  assert.equal(result.inputEvidence, "contains-assumptions");
  assert.equal(result.site.id, "colossus1");
  assert.deepEqual(result.inputSchema, SCREENING_INPUTS);
  const metrics = new Map(result.years[0].metrics.map((metric: any) => [metric.id, metric]));
  assert.equal((metrics.get("water_balance") as any).value, .75 * 365 * 86400);
  assert.ok((metrics.get("noise_source_db_a") as any).value < 100);
  assert.equal(result.years[0].noiseContours.length, 2);
  assert.ok(result.requiredInputs.some((input: any) => input.domain === "heat" && input.fields.includes("heatMw")));
  assert.equal(result.spatial, null);
  assert.match(result.limitations.join(" "), /not calibrated/);
});

test("heat and air scenarios scale the retained real NASA wind footprint without modifying the existing plume model", async () => {
  const result = await runEnvironmentScreening({ ...base,
    years: [{ year: 2030, source, heatMw: 10, emissionRateGs: 1, pollutant: "primary test tracer" }, { year: 2032, source, heatMw: 20, emissionRateGs: 0, pollutant: "primary test tracer" }],
    dispersion: { effectiveHeightM: 20, landUse: "urban", airDensityKgM3: 1.2, specificHeatJkgK: 1005, source } }, new AbortController().signal, () => {});
  const spatial = result.spatial as any, rows = result.years as any[];
  assert.ok(spatial.dispersion.frames.used >= 100);
  assert.equal(spatial.dispersion.evidence, "scenario");
  assert.equal(spatial.dispersion.grid.units, "s/m^3");
  const first = new Map(rows[0].metrics.map((m: any) => [m.id, m.value]));
  const second = new Map(rows[1].metrics.map((m: any) => [m.id, m.value]));
  assert.equal(first.get("air_peak_source_contribution"), spatial.dispersion.peak.chiOverQ * 1e6);
  assert.equal(second.get("air_peak_source_contribution"), 0);
  assert.equal(second.get("heat_peak_temperature_rise"), (first.get("heat_peak_temperature_rise") as number) * 2);
  assert.deepEqual(rows.map(row => row.year), [2030, 2032]);
  assert.equal(spatial.scales[0].heatMultiplier, 10e6 / (1.2 * 1005));
});
