import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { EnvironmentRun } from "../packages/contracts/src/environment.ts";

const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const example = process.argv.includes("--series") ? "environment-series.json" : "environment-sync.json";
const request = JSON.parse(await readFile(new URL(`../data/examples/${example}`, import.meta.url), "utf8"));
const response = await fetch(new URL("/v1/runs", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
if (!response.ok) throw new Error(`Submit failed (${response.status}): ${await response.text()}`);
const job = await response.json() as { id: string; statusUrl: string; resultUrl: string };
console.log(`Environmental run ${job.id}. Resume interrupted acquisition by submitting another sync.`);
let prior = "";
const deadline = Date.now() + 30 * 60_000;
let complete = false;
while (Date.now() < deadline) {
  const statusResponse = await fetch(new URL(job.statusUrl, base));
  if (!statusResponse.ok) throw new Error(`Status failed: ${statusResponse.status}`);
  const run = await statusResponse.json() as EnvironmentRun;
  const current = `${run.status}: ${run.stage} (${Math.round(run.progress)}%)`;
  if (current !== prior) { console.log(current); prior = current; }
  if (run.status === "failed") throw new Error(run.error?.message ?? "Data acquisition failed");
  if (run.status === "completed") { complete = true; break; }
  await delay(2000);
}
if (!complete) throw new Error("Client wait expired; inspect the saved run status before resubmitting");
const resultResponse = await fetch(new URL(job.resultUrl, base));
if (!resultResponse.ok) throw new Error(`Results failed: ${resultResponse.status}`);
console.log(JSON.stringify(await resultResponse.json(), null, 2));
