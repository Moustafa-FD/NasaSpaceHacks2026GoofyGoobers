import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ResultManifest, Scenario } from "../../../packages/contracts/src/index.ts";
import { assertResult } from "./validation.ts";

export type ModelRunner = (runId: string, scenario: Scenario, signal: AbortSignal) => Promise<ResultManifest>;

export function pythonRunner(executable = "python", timeoutMs = 30_000): ModelRunner {
  return (runId, scenario, signal) => new Promise((resolve, reject) => {
    const child = spawn(executable, [fileURLToPath(new URL("../../../services/models/worker.py", import.meta.url))], {
      shell: false, windowsHide: true, signal, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Model worker timed out"); child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) { failure = new Error("Worker result exceeds demo size limit"); child.kill(); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on("error", () => { /* close/error handlers report worker failure */ });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Model worker exited with code ${code}: ${stderr.trim() || "no diagnostic"}`));
      try {
        const result: unknown = JSON.parse(stdout);
        assertResult(result, runId, scenario);
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ runId, scenario }));
  });
}
