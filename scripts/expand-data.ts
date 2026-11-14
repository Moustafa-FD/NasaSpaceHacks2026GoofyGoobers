import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { EnvironmentRequest, EnvironmentRun } from "../packages/contracts/src/environment.ts";

const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const reportPath = new URL("../data/runs/environment/expansion-report.json", import.meta.url);
const temporaryPath = new URL("../data/runs/environment/expansion-report.json.part", import.meta.url);
type Entry = { key: string; label: string; request: EnvironmentRequest; id?: string; status: string; error?: string; resultUrl?: string };
let previous: { jobs: Entry[] } = { jobs: [] };
try { previous = JSON.parse(await readFile(reportPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const jobs = previous.jobs;
async function save() {
  await mkdir(new URL("../data/runs/environment/", import.meta.url), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify({ updatedAt: new Date().toISOString(), focus: ["Canada", "USA"], scope: "Global facility map plus bounded North American regulatory/history/scenario examples; not a complete global environmental archive", activeRequestKeys: plan.map(item => createHash("sha256").update(JSON.stringify(item.request)).digest("hex")), jobs }, null, 2) + "\n");
  await rename(temporaryPath, reportPath);
}
async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  return response.json();
}
const plan: Array<{ label: string; request: EnvironmentRequest }> = [
  { label: "Global OSM facility-map snapshot", request: { schemaVersion: "1.0", kind: "facilities-sync" } },
  { label: "Canada NPRI available sector-report history", request: { schemaVersion: "1.0", kind: "emissions-sync", source: "npri", maxReports: 100 } },
  ...[2008, 2011, 2014, 2017, 2020, 2023].map(year => ({ label: `US EPA NEI sector inventory ${year}`, request: { schemaVersion: "1.0", kind: "emissions-sync", source: "epa-nei", year } as EnvironmentRequest }))
];
const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), start = new Date(Date.parse(end) - 6 * 86_400_000).toISOString().slice(0, 10);
for (const region of [
  { label: "Canada: Varennes reporting-facility area", point: { latitude: 45.62415, longitude: -73.38208 } },
  { label: "USA: Northern Virginia regional example", point: { latitude: 39, longitude: -77.5 } }
]) {
  plan.push({ label: `${region.label} — recent modeled air quality`, request: { schemaVersion: "1.0", kind: "air-quality", point: region.point, start, end } });
  plan.push({ label: `${region.label} — recent soil/water/heat history`, request: { schemaVersion: "1.0", kind: "land-water", point: region.point, start: "2024-01-01", end: "2025-12-31" } });
  plan.push({ label: `${region.label} — two-model future climate`, request: { schemaVersion: "1.0", kind: "climate", point: region.point, start: "2040-01-01", end: "2049-12-31" } });
  plan.push({ label: `${region.label} — illustrative agricultural climate-exposure comparison`, request: { schemaVersion: "1.0", kind: "agriculture", point: region.point, baseline: { start: "1991-01-01", end: "2000-12-31" }, future: { start: "2040-01-01", end: "2049-12-31" }, growingMonths: [4, 5, 6, 7, 8, 9], baseTemperatureC: 10, heatThresholdC: 30, dryDayThresholdMm: 1 } });
}
plan.push({ label: "USA: Potomac station water-quality observations", request: { schemaVersion: "1.0", kind: "water-quality", stationId: "USGS-01646500", start: "2026-11-01", end: "2026-11-01" } });
let failures = 0;
for (const item of plan) {
  const key = createHash("sha256").update(JSON.stringify(item.request)).digest("hex");
  let entry = jobs.find(job => job.key === key);
  if (entry?.id && !process.argv.includes("--refresh")) {
    const response = await fetch(new URL(`/v1/runs/${entry.id}`, base), { signal: AbortSignal.timeout(20_000) });
    if (!response.ok && response.status !== 404) throw new Error(`Cannot establish the prior run's status (HTTP ${response.status}); no duplicate acquisition was submitted`);
    const status = response.status === 404 ? undefined : await response.json() as EnvironmentRun;
    if (status?.status === "completed") { entry.status = "completed"; delete entry.error; await save(); console.log(`Reused completed run: ${item.label}`); continue; }
    if (status?.status === "running" || status?.status === "queued") throw new Error(`A prior expansion run is still active (${entry.id}); inspect it before resubmitting`);
  }
  if (!entry) { entry = { ...item, key, status: "requested" }; jobs.push(entry); }
  try {
    console.log(`Starting: ${item.label}`);
    const submitted = await fetchJson("/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.request) });
    Object.assign(entry, { id: submitted.id, status: "queued", error: undefined, resultUrl: submitted.resultUrl }); await save();
    const deadline = Date.now() + 30 * 60_000; let last = "";
    while (true) {
      if (Date.now() > deadline) throw new Error(`Client wait expired; inspect ${submitted.statusUrl} before retrying`);
      const status = await fetchJson(submitted.statusUrl) as EnvironmentRun;
      const progress = `${status.status}: ${status.stage} (${Math.round(status.progress)}%)`;
      if (progress !== last) { console.log(progress); last = progress; }
      if (status.status === "failed") throw new Error(status.error?.message ?? "Acquisition failed");
      if (status.status === "completed") { entry.status = "completed"; await save(); break; }
      await delay(1000);
    }
  } catch (error) { failures++; entry.status = "failed"; entry.error = error instanceof Error ? error.message : String(error); console.error(`${item.label}: ${entry.error}`); await save(); }
}
console.log(JSON.stringify({ planned: plan.length, failed: failures, reportPath: reportPath.pathname, note: "Ground noise/crop-yield measurements are not invented or imported; the USGS job requests source monitoring observations." }, null, 2));
if (failures) process.exitCode = 1;
