import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

// Live data-plumbing checks; these do not validate causal or predictive skill.
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
async function json(path: string): Promise<any> {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`); return response.json();
}
const expansion = JSON.parse(await readFile(new URL("../data/runs/environment/expansion-report.json", import.meta.url), "utf8"));
const activeJobs = expansion.activeRequestKeys ? expansion.jobs.filter((entry: any) => expansion.activeRequestKeys.includes(entry.key)) : expansion.jobs;
assert.ok(activeJobs.length >= 17, "Run npm run data:expand first");
const summaries = [];
for (const entry of activeJobs) {
  const status = await json(`/v1/runs/${entry.id}`);
  assert.equal(status.status, "completed", `${entry.label}: ${status.error?.message ?? status.status}`);
  const result = await json(entry.resultUrl);
  if (entry.request.kind === "air-quality") { assert.equal(result.variables.length, 5); assert.ok(result.variables.every((value: any) => value.validSampleCount > 0)); }
  if (entry.request.kind === "land-water") { assert.equal(result.models[0].model, "era5"); assert.ok(result.models[0].metrics.every((value: any) => value.validDays > 0)); }
  if (entry.request.kind === "climate") { assert.equal(result.evidence, "climate-scenario"); assert.equal(result.models.length, 2); }
  if (entry.request.kind === "agriculture") {
    assert.equal(result.evidence, "conditional-climate-screening"); assert.equal(result.comparisons.length, 2);
    assert.ok(result.comparisons.every((model: any) => model.indicators.meanTemperatureC.change !== null));
    assert.ok(result.unavailable.some((metric: any) => metric.metric === "crop_yield_prediction"));
  }
  if (entry.request.kind === "water-quality") { assert.equal(result.evidence, "ground-observation"); assert.equal(result.complete, true); assert.equal(result.parameters.length, 5); assert.ok(result.records.length > 0); }
  summaries.push({ label: entry.label, id: entry.id, kind: entry.request.kind, sourceId: result.sourceId ?? null, records: result.records?.length ?? null });
}
const mapped = await json("/v1/facilities?source=osm&bbox=-170,5,-50,85&limit=5");
assert.ok(mapped.total > 0); assert.equal(mapped.records.length, 5);
for (const year of [2008, 2011, 2014, 2017, 2020, 2023]) { const data = await json(`/v1/emissions?source=epa-nei&year=${year}&limit=1`); assert.ok(data.total > 0); assert.equal(data.records[0].year, year); }
const canada = await json("/v1/emissions?source=npri&facilityId=npri%3A35136&year=2024&medium=air&limit=100");
assert.ok(canada.records.some((record: any) => record.amount !== null && record.estimationBasis.classification === "estimate_based"));
assert.ok(canada.records.every((record: any) => record.isPermitLimit === false));
const inventory = await json("/v1/inventory");
assert.ok(inventory.datasets.every((source: any) => source.status === "downloaded_snapshot"));
const report = { verifiedAt: new Date().toISOString(), datasetInventory: inventory.datasets, northAmericanMappedElementsInExampleExtent: mapped.total, jobs: summaries, scientificValidation: false, note: "Source coding and proximity do not prove data-center identity, emissions causation or future agricultural damage." };
await writeFile(new URL("../data/runs/environment/expanded-verification.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ verified: true, jobs: summaries.length, datasets: inventory.datasets, northAmericanMappedElementsInExampleExtent: mapped.total }, null, 2));
