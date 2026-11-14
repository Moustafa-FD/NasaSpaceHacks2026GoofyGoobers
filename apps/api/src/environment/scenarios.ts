/** Part 2 bridge: `plume-scenario` and `climate-projection` jobs run services/models/projections/worker.py. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClimateProjectionRequest, PlumeScenarioRequest } from "../../../../packages/contracts/src/environment.ts";
import { REPOSITORY_ROOT } from "./store.ts";
import { dataPythonExecutable, type ProgressReporter } from "./service.ts";

/** Line protocol: {"type":"progress",...}* then one {"type":"result","result":...}. */
export function runScenarioWorker(payload: Record<string, unknown>, signal: AbortSignal, report: ProgressReporter, timeoutMs = 1_200_000): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(dataPythonExecutable(), ["-m", "services.models.projections.worker"], { cwd: REPOSITORY_ROOT, shell: false, windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", stderr = "", failure: Error | undefined, result: Record<string, unknown> | undefined;
    const timer = setTimeout(() => { failure = new Error("Scenario worker timed out"); child.kill(); }, timeoutMs);
    const line = (text: string) => {
      if (!text.trim()) return;
      const event = JSON.parse(text) as { type: string; progress?: number; stage?: string; result?: Record<string, unknown> };
      if (event.type === "result") result = event.result;
      else if (event.type === "progress") report(Math.min(95, 15 + 80 * (event.progress ?? 0)), event.stage ?? "scenario:running");
      else throw new Error("Unexpected scenario worker event");
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 16_000_000) { failure = new Error("Scenario result exceeded 16 MB"); child.kill(); return; }
      let newline: number;
      try { while ((newline = pending.indexOf("\n")) >= 0) { line(pending.slice(0, newline)); pending = pending.slice(newline + 1); } }
      catch (error) { failure = error instanceof Error ? error : new Error("Invalid scenario worker output"); child.kill(); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-6000); });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) {
        let message = stderr.trim() || `Scenario worker exited with code ${code}`;
        try { message = JSON.parse(stderr.trim().split("\n").pop() ?? "").error?.message ?? message; } catch { /* keep raw */ }
        return reject(new Error(`Scenario failed: ${message}`));
      }
      try { if (pending.trim()) line(pending); if (!result) throw new Error("Scenario worker returned no result"); resolveResult(result); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function caseStudySite(id: string): Promise<Record<string, unknown>> {
  const sites = JSON.parse(await readFile(join(REPOSITORY_ROOT, "data", "cloudshadow", "sites.json"), "utf8")).sites as Array<Record<string, unknown>>;
  const site = sites.find(item => item.id === id);
  if (!site) throw new Error(`Unknown case-study site ${id}`);
  return { id: site.id, name: site.name, lat: site.lat, lon: site.lon, neighbors: site.neighbors ?? [], prepared: true };
}

export async function runPlumeScenario(request: PlumeScenarioRequest, signal: AbortSignal, report: ProgressReporter): Promise<Record<string, unknown>> {
  report(10, "plume:resolving-site");
  const site = request.siteId ? await caseStudySite(request.siteId)
    : { id: "point", name: `${request.point!.latitude.toFixed(4)}, ${request.point!.longitude.toFixed(4)}`, lat: request.point!.latitude, lon: request.point!.longitude, neighbors: request.receptors ?? [] };
  return runScenarioWorker({ model: "plume", site, heightM: request.effectiveHeightM, landUse: request.landUse ?? "urban", emission: request.emission ?? null }, signal, report);
}

export async function runClimateProjection(request: ClimateProjectionRequest, signal: AbortSignal, report: ProgressReporter): Promise<Record<string, unknown>> {
  report(10, "climate:listing-nex-gddp-cmip6");
  return runScenarioWorker({ model: "climate", point: request.point, perWindow: request.perWindow ?? 2 }, signal, report);
}
