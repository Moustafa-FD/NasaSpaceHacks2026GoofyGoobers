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

/** Resolve an inline series or a completed `series` run's variable, recording provenance and an input hash. */
export async function resolveTrendInput(store: EnvironmentStore, input: TrendSeriesInput, role: "target" | "control"): Promise<ResolvedSeries> {
  if ("series" in input) {
    const points = input.series.points.map(point => ({ date: point.date, value: point.value }));
    return { label: input.series.label, unit: input.series.unit, points, reference: { role, kind: "inline", source: input.series.source ?? null, inputSha256: sha256(points) } };
  }
  const run = await store.read<Record<string, any>>(store.processedDirectory, `run-${input.runId}`);
  if (!run) throw new Error(`${role}: run ${input.runId} has no completed result`);
  if (run.kind !== "series" || !Array.isArray(run.variables)) throw new Error(`${role}: run ${input.runId} is not a completed point-series run`);
  const variable = run.variables.find((item: Record<string, unknown>) => item.id === input.variable);
  if (!variable || !Array.isArray(variable.series)) throw new Error(`${role}: run ${input.runId} has no variable ${input.variable}`);
  const points = variable.series.map((item: { date: string; value: number | null }) => ({ date: item.date, value: item.value }));
  return {
    label: String(variable.label ?? input.variable), unit: String(variable.unit ?? ""), points,
    reference: { role, kind: "run", runId: input.runId, variable: input.variable, evidence: run.evidence ?? null, sourceUrl: run.sourceUrl ?? null,
      rawSha256: run.rawSha256 ?? null, retrievedAt: run.retrievedAt ?? null, inputSha256: sha256(points) },
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
