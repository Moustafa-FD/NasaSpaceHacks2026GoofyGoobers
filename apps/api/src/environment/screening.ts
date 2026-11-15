/** Explicit-input environmental screening, added alongside the existing model workers. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCREENING_INPUTS, type EnvironmentScreeningRequest } from "../../../../packages/contracts/src/screening.ts";
import { REPOSITORY_ROOT } from "./store.ts";
import { dataPythonExecutable, type ProgressReporter } from "./service.ts";

export async function runEnvironmentScreening(request: EnvironmentScreeningRequest, signal: AbortSignal, report: ProgressReporter): Promise<Record<string, unknown>> {
  let site: Record<string, unknown>;
  if (request.siteId) {
    const items = JSON.parse(await readFile(join(REPOSITORY_ROOT, "data", "cloudshadow", "sites.json"), "utf8")).sites as Array<Record<string, unknown>>;
    const found = items.find(item => item.id === request.siteId);
    if (!found) throw new Error("Unknown screening study site");
    site = { id: found.id, name: found.name, lat: found.lat, lon: found.lon, neighbors: found.neighbors ?? [], prepared: true };
  } else site = { id: "point", name: "Selected point", lat: request.point!.latitude, lon: request.point!.longitude, neighbors: [], prepared: false };
  report(10, "screening:checking-sourced-inputs");
  return new Promise((resolve, reject) => {
    const child = spawn(dataPythonExecutable(), ["-m", "services.models.screening.worker"], { cwd: REPOSITORY_ROOT, shell: false, windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", stderr = "", result: Record<string, unknown> | undefined, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Screening worker timed out; no model result was substituted"); child.kill(); }, 300000);
    const line = (text: string) => {
      if (!text.trim()) return;
      const event = JSON.parse(text) as { type: string; result?: Record<string, unknown>; progress?: number; stage?: string };
      if (event.type === "result") result = event.result;
      else if (event.type === "progress") report(Math.min(95, Math.max(10, 10 + 85 * (event.progress ?? 0))), event.stage ?? "screening:running");
      else throw new Error("Unexpected screening worker output");
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 8000000) { failure = new Error("Screening result exceeded 8 MB"); child.kill(); return; }
      let index: number;
      try { while ((index = pending.indexOf("\n")) >= 0) { line(pending.slice(0, index)); pending = pending.slice(index + 1); } }
      catch (error) { failure = error instanceof Error ? error : new Error("Invalid screening worker output"); child.kill(); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-6000); });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) {
        let message = stderr.trim() || `Screening worker exited ${code}`;
        try { message = JSON.parse(stderr.trim().split("\n").at(-1) ?? "").error?.message ?? message; } catch { /* retain diagnostic */ }
        return reject(new Error(message));
      }
      try {
        if (pending.trim()) line(pending);
        if (!result || result.evidence !== "screening-scenario" || !Array.isArray(result.years)) throw new Error("Screening worker returned no valid result");
        resolve({ ...result, inputSchema: SCREENING_INPUTS });
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...request, site }));
  });
}
