import { randomUUID } from "node:crypto";
import type { ResultManifest, RunEvent, RunSnapshot, Scenario } from "../../../packages/contracts/src/index.ts";
import type { ModelRunner } from "./model-worker.ts";

export class CapacityError extends Error {}

export class RunManager {
  private records = new Map<string, RunSnapshot>();
  private results = new Map<string, ResultManifest>();
  private subscribers = new Map<string, Set<(event: RunEvent) => void>>();
  private queue: string[] = [];
  private running = false;
  private closed = false;
  private controller = new AbortController();
  private runner: ModelRunner;
  private maxRuns: number;

  constructor(runner: ModelRunner, maxRuns = 200) { this.runner = runner; this.maxRuns = maxRuns; }

  create(scenario: Scenario): RunSnapshot {
    if (this.closed || this.records.size >= this.maxRuns || this.queue.length >= 32) throw new CapacityError("Demo capacity reached; completed runs stay in memory until restart");
    const now = new Date().toISOString();
    const record: RunSnapshot = { id: randomUUID(), status: "queued", progress: 0, createdAt: now, updatedAt: now, scenario: structuredClone(scenario) };
    this.records.set(record.id, record);
    this.queue.push(record.id);
    setImmediate(() => { void this.drain(); });
    return structuredClone(record);
  }

  get(id: string): RunSnapshot | undefined { const record = this.records.get(id); return record && structuredClone(record); }
  result(id: string): ResultManifest | undefined { const result = this.results.get(id); return result && structuredClone(result); }
  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    const listeners = this.subscribers.get(id) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.subscribers.delete(id); };
  }

  private update(id: string, changes: Partial<RunSnapshot>): void {
    const record = this.records.get(id)!;
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    for (const listener of this.subscribers.get(id) ?? []) listener({ type: "run.status", run: structuredClone(record) });
  }

  private async drain(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const id = this.queue.shift()!;
        const record = this.records.get(id)!;
        this.update(id, { status: "running", progress: 10 });
        try {
          const result = await this.runner(id, structuredClone(record.scenario), this.controller.signal);
          if (this.closed) break;
          this.results.set(id, result);
          this.update(id, { status: "completed", progress: 100, resultUrl: `/v1/runs/${id}/results` });
        } catch (error) {
          this.update(id, { status: "failed", progress: 100, error: { code: "MODEL_FAILED", message: error instanceof Error ? error.message : "Model execution failed" } });
        }
      }
    } finally { this.running = false; }
  }

  close(): void { this.closed = true; this.queue = []; this.controller.abort(); this.subscribers.clear(); }
}
