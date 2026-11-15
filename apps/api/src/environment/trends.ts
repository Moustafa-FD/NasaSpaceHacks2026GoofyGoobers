/** Part 2 bridge: `trend-analysis` jobs run the Python trend engine (services/models/trends/worker.py). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { TrendAnalysisRequest, TrendSeriesInput } from "../../../../packages/contracts/src/environment.ts";
import type { EnvironmentStore } from "./store.ts";
import { REPOSITORY_ROOT } from "./store.ts";
import { dataPythonExecutable, type ProgressReporter } from "./service.ts";

export interface ResolvedSeries {
  label: string;
  unit: string;
  points: Array<{ date: string; value: number | null }>;
  reference: Record<string, unknown>;
}

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Point = { date: string; value: number | null };
interface Extracted { label: string; unit: string; evidence: string; points: Point[]; model?: string }

/** Pull one variable out of any Part 1 result kind that carries a time series. */
export function extractVariable(run: Record<string, any>, runId: string, variable: string, model?: string): Extracted {
  const plain = (items: any[]) => items.map((item: any) => ({ date: String(item.date), value: typeof item.value === "number" && Number.isFinite(item.value) ? item.value : null }));
  switch (run.kind) {
    case "series":            // NASA POWER point series (monthly)
    case "air-quality": {     // CAMS hourly concentrations
      const found = (run.variables ?? run.metrics ?? []).find((item: any) => (item.id ?? item.variable) === variable);
      if (!found || !Array.isArray(found.series)) throw new Error(`run ${runId} (${run.kind}) has no variable ${variable}; available: ${(run.variables ?? []).map((v: any) => v.id).join(", ")}`);
      return { label: String(found.label ?? variable), unit: String(found.unit ?? found.units ?? ""), evidence: String(run.evidence ?? "model-derived"), points: plain(found.series) };
    }
    case "land-water":        // ERA5 daily history
    case "climate": {         // HighResMIP daily scenario
      const models: any[] = run.models ?? [];
      const chosen = model ? models.find(m => m.model === model) : models.length === 1 ? models[0] : undefined;
      if (!chosen) throw new Error(`run ${runId} (${run.kind}) needs model: one of ${models.map(m => m.model).join(", ")}`);
      const metric = (chosen.metrics ?? []).find((m: any) => m.id === variable);
      if (!metric) throw new Error(`run ${runId} model ${chosen.model} has no metric ${variable}; available: ${(chosen.metrics ?? []).map((m: any) => m.id).join(", ")}`);
      return { label: `${variable} (${chosen.model})`, unit: String(metric.units ?? ""), evidence: String(run.evidence ?? ""), points: plain(metric.series), model: chosen.model };
    }
    case "water-quality": {   // USGS station observations; variable = USGS parameter code
      const records = (run.records ?? []).filter((r: any) => r.parameterCode === variable);
      if (!records.length) throw new Error(`run ${runId} has no records for USGS parameter ${variable}`);
      const units = [...new Set(records.map((r: any) => r.unit).filter(Boolean))];
      if (units.length > 1) throw new Error(`run ${runId} parameter ${variable} mixes units ${units.join(", ")}`);
      return { label: String(records[0].parameterName ?? variable), unit: String(units[0] ?? ""), evidence: String(run.evidence ?? "ground-observation"),
        // Censored and non-numeric values stay missing: a censoring bound is not a measured value.
        points: records.map((r: any) => ({ date: String(r.sourceTime ?? r.date), value: r.valueStatus === "numeric" && typeof r.value === "number" ? r.value : null })) };
    }
    default:
      throw new Error(`run ${runId} is a ${run.kind} result, which has no time series to analyse`);
  }
}

/** Sub-daily samples become daily means (the engine works at day/month/year resolution). */
export function toDaily(points: Point[]): Point[] {
  if (points.every(p => p.date.length <= 10)) return points;
  const days = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    const iso = p.date.length > 10 ? new Date(p.date.endsWith("Z") || /[+-]\d\d:\d\d$/.test(p.date) ? p.date : `${p.date}Z`).toISOString().slice(0, 10) : p.date;
    const day = days.get(iso) ?? { sum: 0, n: 0 };
    if (p.value !== null) { day.sum += p.value; day.n += 1; }
    days.set(iso, day);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({ date, value: d.n ? d.sum / d.n : null }));
}

/** Resolve an inline series or one/several completed Part 1 runs, recording provenance and an input hash. */
export async function resolveTrendInput(store: EnvironmentStore, input: TrendSeriesInput, role: "target" | "control"): Promise<ResolvedSeries> {
  if ("series" in input) {
    const points = input.series.points.map(point => ({ date: point.date, value: point.value }));
    return { label: input.series.label, unit: input.series.unit, points, reference: { role, kind: "inline", source: input.series.source ?? null, inputSha256: sha256(points) } };
  }
  const ids = "runIds" in input ? input.runIds : [input.runId];
  const parts: Array<Extracted & { runId: string; run: Record<string, any> }> = [];
  for (const runId of ids) {
    const run = await store.read<Record<string, any>>(store.processedDirectory, `run-${runId}`);
    if (!run) throw new Error(`${role}: run ${runId} has no completed result`);
    parts.push({ ...extractVariable(run, runId, input.variable, input.model), runId, run });
  }
  const evidence = [...new Set(parts.map(p => p.evidence))], units = [...new Set(parts.map(p => p.unit))];
  if (evidence.length > 1) throw new Error(`${role}: runs mix evidence types (${evidence.join(", ")}); observations, reanalysis and scenarios cannot be stitched into one trend`);
  if (units.length > 1) throw new Error(`${role}: runs report different units (${units.join(", ")})`);
  const merged = new Map<string, number | null>();
  for (const part of parts) for (const p of toDaily(part.points)) {
    if (merged.has(p.date) && merged.get(p.date) !== null && p.value !== null && Math.abs((merged.get(p.date) as number) - p.value) > 1e-9) throw new Error(`${role}: overlapping runs disagree on ${p.date}`);
    if (!merged.has(p.date) || merged.get(p.date) === null) merged.set(p.date, p.value);
  }
  const points = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  return {
    label: parts[0].label, unit: units[0], points,
    reference: { role, kind: "run", runIds: ids, variable: input.variable, model: parts[0].model ?? null, resultKind: [...new Set(parts.map(p => p.run.kind))].join(","),
      evidence: evidence[0], sources: parts.map(p => ({ runId: p.runId, sourceUrl: p.run.sourceUrl ?? p.run.station?.sourceUrl ?? null, rawSha256: p.run.rawSha256 ?? null, retrievedAt: p.run.retrievedAt ?? null })),
      inputSha256: sha256(points) },
  };
}

/** Spawn the stdlib Python trend worker: one JSON request in, one JSON result out. */
export function runTrendWorker(payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(dataPythonExecutable(), ["-m", "services.models.trends.worker"], { cwd: REPOSITORY_ROOT, shell: false, windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Trend worker timed out"); child.kill(); }, 120_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 16_000_000) { failure = new Error("Trend result exceeded 16 MB"); child.kill(); } });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-6000); });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) {
        let message = stderr.trim() || `Trend worker exited with code ${code}`;
        try { message = JSON.parse(stderr.trim().split("\n").pop() ?? "").error?.message ?? message; } catch { /* keep raw diagnostic */ }
        return reject(new Error(`Trend analysis failed: ${message}`));
      }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("Trend worker returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runTrendAnalysis(store: EnvironmentStore, request: TrendAnalysisRequest, signal: AbortSignal, report: ProgressReporter): Promise<Record<string, unknown>> {
  report(15, "trend:resolving-input");
  const target = await resolveTrendInput(store, request.input, "target");
  const control = request.control ? await resolveTrendInput(store, request.control, "control") : undefined;
  if (control && target.unit !== control.unit) throw new Error(`Target and control report different units (${target.unit}, ${control.unit}); convert to the same unit before comparing`);
  report(40, "trend:computing");
  const output = await runTrendWorker({
    target: { label: target.label, unit: target.unit, points: target.points },
    control: control ? { label: control.label, unit: control.unit, points: control.points } : null,
    cadence: request.cadence ?? "monthly", alpha: request.alpha ?? 0.05, minYears: request.minYears ?? 10, minCountPerMonth: request.minCountPerMonth ?? 1,
  }, signal);
  return {
    evidence: "statistical-analysis",
    method: {
      engine: output.engineVersion, cadence: output.cadence, alpha: request.alpha ?? 0.05, minYears: request.minYears ?? 10,
      tests: output.cadence === "annual" ? ["Mann-Kendall with Hamed-Rao variance correction (never narrows uncertainty)", "Sen's slope with Gilbert CI", "OLS t-test with lag-1 effective sample size"]
        : ["Seasonal Mann-Kendall (Hirsch-Slack-Smith)", "seasonal Sen's slope", "OLS t-test on monthly anomalies with lag-1 effective sample size"],
      note: "Use cadence 'annual' for persistent storage variables (groundwater, soil moisture): seasonal Mann-Kendall assumes years are independent.",
    },
    inputs: [target.reference, ...(control ? [control.reference] : [])],
    target: { label: target.label, unit: target.unit, points: target.points.length },
    ...(control ? { control: { label: control.label, unit: control.unit, points: control.points.length } } : {}),
    report: output.report,
    warnings: ["A trend shows change in the supplied series; it does not identify a cause or attribute it to a facility."],
  };
}
