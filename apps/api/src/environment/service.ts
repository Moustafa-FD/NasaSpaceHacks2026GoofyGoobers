import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { EnvironmentRequest } from "../../../../packages/contracts/src/environment.ts";
import { discoverCollections } from "./catalog.ts";
import { fetchPowerSeries } from "./power.ts";
import { EnvironmentStore, REPOSITORY_ROOT } from "./store.ts";
import { fetchFacilities } from "./facilities.ts";
import { fetchNpriEmissions } from "./emissions.ts";
import { fetchAirQuality } from "./air-quality.ts";
import { fetchLandClimate, type DailyPointQuery, type LandClimateResult } from "./land-climate.ts";
import { compareAgriculture } from "./agriculture.ts";
import { normalizeGroundEvidence } from "./ground-evidence.ts";
import { fetchUsEmissions } from "./us-emissions.ts";
import { fetchWaterQuality } from "./water-quality.ts";
import { shouldReplaceNpriCanonical } from "./library.ts";
import { runTrendAnalysis } from "./trends.ts";
import { runClimateProjection, runPlumeScenario } from "./scenarios.ts";

export type ProgressReporter = (progress: number, stage: string, details?: Record<string, unknown>) => void;
export type EnvironmentExecutor = (request: EnvironmentRequest, signal: AbortSignal, report: ProgressReporter) => Promise<unknown>;
let nextLargeSourceRequestAt = 0;

export function dataPythonExecutable(): string {
  if (process.env.DATA_PYTHON_EXECUTABLE) return process.env.DATA_PYTHON_EXECUTABLE;
  const local = join(REPOSITORY_ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return existsSync(local) ? local : (process.env.PYTHON_EXECUTABLE ?? "python");
}

export function runGridWorker(request: Record<string, unknown>, signal: AbortSignal, report: ProgressReporter): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(dataPythonExecutable(), [join(REPOSITORY_ROOT, "services/data/power_grid.py")], { shell: false, windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "";
    let stderr = "";
    let result: unknown;
    let failure: Error | undefined;
    const timeout = Number(process.env.DATA_WORKER_TIMEOUT_MS ?? 1_200_000);
    const timer = setTimeout(() => { failure = new Error("Environmental data worker timed out; rerun sync to resume cached chunks"); child.kill(); }, Number.isFinite(timeout) && timeout >= 1000 && timeout <= 1_800_000 ? timeout : 1_200_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const line = (text: string) => {
      if (!text.trim()) return;
      const event = JSON.parse(text) as { type: string; result?: unknown; stage?: string; completedChunks?: number; totalChunks?: number; [key: string]: unknown };
      if (event.type === "result") result = event.result;
      else if (event.type === "progress") {
        const fraction = event.totalChunks && typeof event.completedChunks === "number" ? event.completedChunks / event.totalChunks : 0;
        report(Math.min(95, Math.max(10, 10 + fraction * 85)), event.stage ?? "acquiring-data", event);
      } else throw new Error("Unexpected environmental worker event");
    };
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 32_000_000) { failure = new Error("Worker response exceeded 32 MB"); child.kill(); return; }
      let newline: number;
      try { while ((newline = pending.indexOf("\n")) >= 0) { line(pending.slice(0, newline)); pending = pending.slice(newline + 1); } }
      catch (error) { failure = error instanceof Error ? error : new Error("Invalid worker output"); child.kill(); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-6000); });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Data worker failed (${code}): ${stderr.trim() || "No diagnostic; run npm run data:setup to install the data dependencies"}`));
      try { if (pending.trim()) line(pending); if (result === undefined) throw new Error("Data worker did not return a result"); resolveResult(result); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function environmentExecutor(store: EnvironmentStore): EnvironmentExecutor {
  return async (request, signal, report) => {
    if (request.kind !== "sync" && request.kind !== "series" && request.kind !== "grid") {
      const key = store.key({ request, adapterVersion: "environment-extension-1", defaultAirPeriodDay: request.kind === "air-quality" && request.start === undefined ? new Date().toISOString().slice(0, 10) : undefined });
      const isSync = request.kind === "facilities-sync" || request.kind === "emissions-sync";
      const cached = !isSync && request.kind !== "ground-evidence" ? await store.read<Record<string, unknown>>(store.processedDirectory, key) : undefined;
      if (cached && typeof cached.cachedAt === "string" && Date.now() - Date.parse(cached.cachedAt) < 24 * 60 * 60_000) return { ...cached, cache: { hit: true, key } };
      async function saveSource<T extends object>(data: T): Promise<Record<string, unknown>> {
        const { raw, ...normalized } = data as T & { raw?: unknown };
        if (raw === undefined) return normalized;
        const rawKey = store.key(raw);
        await store.write(store.rawDirectory, rawKey, raw);
        return { ...normalized, rawRecord: rawKey, rawSha256: rawKey };
      }
      async function landSource(query: DailyPointQuery, climate = false): Promise<LandClimateResult> {
        const sourceKey = `source-${store.key({ query, climate, adapterVersion: "land-climate-1" })}`;
        const saved = await store.read<Record<string, unknown>>(store.processedDirectory, sourceKey);
        if (saved && typeof saved.cachedAt === "string" && Date.now() - Date.parse(saved.cachedAt) < 24 * 60 * 60_000) return { ...saved, raw: undefined } as unknown as LandClimateResult;
        // Long date ranges consume more provider quota than a simple point call.
        // Space them after the live provider returned 429 during bulk examples.
        if (Date.parse(query.end) - Date.parse(query.start) > 365 * 86_400_000) {
          const waitMs = Math.max(0, nextLargeSourceRequestAt - Date.now());
          if (waitMs) { report(50, "source-rate-cooldown", { waitSeconds: Math.ceil(waitMs / 1000), reason: "Spacing large public-source requests after observed rate limiting" }); await delay(waitMs, undefined, { signal }); }
          nextLargeSourceRequestAt = Date.now() + 65_000;
        }
        const downloaded = await fetchLandClimate(query, { signal, climate });
        await store.write(store.processedDirectory, sourceKey, { ...await saveSource(downloaded), cachedAt: new Date().toISOString() });
        return downloaded;
      }
      report(10, `acquiring:${request.kind}`);
      let data: Record<string, unknown>;
      switch (request.kind) {
        case "facilities-sync": {
          data = await saveSource(await fetchFacilities({ bbox: request.bbox }, { signal }));
          // A regional query must not replace a previously acquired global registry.
          await store.write(store.processedDirectory, request.bbox ? `facilities-region-${store.key(request.bbox)}` : "facilities-osm", data);
          break;
        }
        case "emissions-sync": {
          if (request.source === "npri") data = await saveSource(await fetchNpriEmissions({ startYear: request.startYear, endYear: request.endYear, maxReports: request.maxReports }, { signal, onProgress: progress => report(10 + 80 * progress.completedReports / Math.max(1, progress.totalReports), progress.stage, { ...progress }) }));
          else data = await saveSource(await fetchUsEmissions({ year: request.year, state: request.state }, { signal }));
          if (request.source === "npri") {
            await store.write(store.processedDirectory, `emissions-npri-scope-${store.key(request)}`, data);
            const previous = await store.read<Record<string, unknown>>(store.processedDirectory, "emissions-npri");
            if (shouldReplaceNpriCanonical(previous, data)) await store.write(store.processedDirectory, "emissions-npri", data);
          } else if (!request.state) {
            await store.write(store.processedDirectory, `emissions-epa-nei-year-${request.year ?? 2023}`, data);
            const latest = await store.read<{ reportingYear: number }>(store.processedDirectory, "emissions-epa-nei");
            if (!latest || latest.reportingYear <= (request.year ?? 2023)) await store.write(store.processedDirectory, "emissions-epa-nei", data);
          } else await store.write(store.processedDirectory, `emissions-epa-nei-state-${request.state.toUpperCase()}-${request.year ?? 2023}`, data);
          break;
        }
        case "air-quality": data = await saveSource(await fetchAirQuality({ ...request.point, start: request.start, end: request.end, variables: request.variables }, { signal })); break;
        case "water-quality": data = await saveSource(await fetchWaterQuality({ stationId: request.stationId, start: request.start, end: request.end, parameters: request.parameters }, { signal })); break;
        case "land-water": data = await saveSource(await landSource({ ...request.point, start: request.start, end: request.end })); break;
        case "climate": data = await saveSource(await landSource({ ...request.point, start: request.start, end: request.end, models: request.models }, true)); break;
        case "agriculture": {
          const baseline = await landSource({ ...request.point, ...request.baseline, models: request.models }, true);
          await saveSource(baseline);
          report(50, "agriculture:future-climate");
          const future = await landSource({ ...request.point, ...request.future, models: request.models }, true);
          await saveSource(future);
          data = { ...compareAgriculture(baseline, future, request), requestedPoint: request.point, sourceMetadata: { scenario: future.scenario, models: future.models.map(model => model.model), spatialResolution: future.spatialResolution, license: future.license, warnings: future.warnings } };
          break;
        }
        case "trend-analysis": data = await runTrendAnalysis(store, request, signal, report); break;
        case "plume-scenario": data = await runPlumeScenario(request, signal, report); break;
        case "climate-projection": data = await runClimateProjection(request, signal, report); break;
        case "ground-evidence": {
          data = await saveSource(normalizeGroundEvidence(request));
          await store.write(store.processedDirectory, `evidence-${key}`, data);
          break;
        }
      }
      const result = { schemaVersion: "1.0", ...data, kind: request.kind, cachedAt: new Date().toISOString(), cache: { hit: false, key } };
      await store.write(store.processedDirectory, key, result);
      return result;
    }
    if (request.kind === "sync") {
      report(5, "discovering-collections");
      let catalog = !request.refreshCatalog ? await store.read(store.processedDirectory, "catalog") : undefined;
      if (!catalog) { catalog = await discoverCollections({ signal }); await store.write(store.processedDirectory, "catalog", catalog); }
      report(10, "acquiring-global-history");
      const acquisition = await runGridWorker({ action: "sync", cacheDir: join(store.rawDirectory, "power-grid"), variables: request.variables ?? ["T2M", "PRECTOTCORR", "RH2M", "WS2M"], maxBytes: (request.maxCacheMiB ?? 768) * 1024 * 1024 }, signal, report);
      await store.write(store.processedDirectory, "global-acquisition", acquisition);
      return { schemaVersion: "1.0", kind: "sync", evidence: "model-derived", catalog, acquisition, warnings: ["CMR collection records are metadata, not downloaded satellite observations.", "This is a curated environmental inventory, not every NASA archive.", "OMI/IMERG/MODIS/GLDAS observations are not downloaded by the public POWER acquisition."] };
    }
    const sourceInventory = request.source === "power-grid" ? await store.read(join(store.rawDirectory, "power-grid"), "inventory") : undefined;
    const key = store.key({ request, sourceInventory });
    const cached = await store.read<Record<string, unknown>>(store.processedDirectory, key);
    const cachedAt = cached && typeof cached.cachedAt === "string" ? Date.parse(cached.cachedAt) : 0;
    if (cached && Date.now() - cachedAt < 24 * 60 * 60_000) return { ...cached, cache: { hit: true, key } };
    report(10, "reading-environmental-series");
    let result: Record<string, unknown>;
    if (request.source === "power-point") {
      const data = await fetchPowerSeries({ ...request.point!, start: request.start!, end: request.end!, variables: request.variables ?? ["T2M", "PRECTOTCORR", "RH2M", "WS2M"] }, { signal });
      const rawKey = store.key({ sourceUrl: data.sourceUrl, retrievedAt: data.retrievedAt });
      await store.write(store.rawDirectory, rawKey, data.raw);
      const { raw: _raw, ...normalized } = data;
      result = { schemaVersion: "1.0", kind: "series", ...normalized, rawRecord: rawKey, rawSha256: store.key(data.raw) };
    } else {
      const data = await runGridWorker({ action: request.kind, cacheDir: join(store.rawDirectory, "power-grid"), variables: request.variables ?? ["T2M"], start: request.start, end: request.end, point: request.point, bbox: request.bbox, date: request.date }, signal, report);
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("Data worker returned an invalid result");
      result = { schemaVersion: "1.0", kind: request.kind, ...data as Record<string, unknown> };
    }
    result.cachedAt = new Date().toISOString();
    result.cache = { hit: false, key };
    await store.write(store.processedDirectory, key, result);
    return result;
  };
}
