import { randomUUID } from "node:crypto";
import type { EnvironmentRequest, EnvironmentRun } from "../../../../packages/contracts/src/environment.ts";
import { EnvironmentStore } from "./store.ts";
import type { EnvironmentExecutor } from "./service.ts";

export class EnvironmentCapacityError extends Error {}

export class EnvironmentJobs {
  private records = new Map<string, EnvironmentRun>();
  private listeners = new Map<string, Set<(event: { type: "run.status"; run: EnvironmentRun }) => void>>();
  private writes = new Map<string, Promise<void>>();
  private queue: string[] = [];
  private pendingCreates = 0;
  private running = false;
  private closed = false;
  private abort = new AbortController();
  readonly store: EnvironmentStore;
  private execute: EnvironmentExecutor;

  constructor(store: EnvironmentStore, execute: EnvironmentExecutor) { this.store = store; this.execute = execute; }

  async init(): Promise<void> {
    await this.store.init();
    for (const id of await this.store.list(this.store.runsDirectory)) {
      const record = await this.store.read<EnvironmentRun>(this.store.runsDirectory, id);
      if (!record || record.id !== id || !record.request) continue;
      if (record.status === "queued" || record.status === "running") {
        record.status = "failed";
        record.stage = "interrupted";
        record.updatedAt = new Date().toISOString();
        record.error = { code: "INTERRUPTED", message: "Server stopped during this run. Submit a new sync to resume validated cached chunks." };
        await this.store.write(this.store.runsDirectory, id, record);
      }
      this.records.set(id, record);
    }
  }
  async create(request: EnvironmentRequest): Promise<EnvironmentRun> {
    if (this.closed || this.queue.length + this.pendingCreates >= 16 || this.records.size >= 1000) throw new EnvironmentCapacityError("Local job capacity reached; waiting limit 16, retained run limit 1000");
    // Reserve waiting capacity before the first await: concurrent HTTP requests
    // must not all pass the queue limit while their initial records are writing.
    this.pendingCreates++;
    let id: string | undefined;
    try {
      const now = new Date().toISOString();
      const record: EnvironmentRun = { id: randomUUID(), status: "queued", progress: 0, stage: "queued", createdAt: now, updatedAt: now, request: structuredClone(request) };
      id = record.id;
      this.records.set(record.id, record);
      await this.persist(record.id);
      if (this.closed) throw new EnvironmentCapacityError("Server stopped while creating this run; submit again after restart");
      this.queue.push(record.id);
      setImmediate(() => { void this.drain().catch(error => { console.error("Environmental queue stopped unexpectedly", error); }); });
      return structuredClone(record);
    } catch (error) {
      // A failed initial write never becomes an accepted/queued run. The caller
      // receives the failure and the reserved capacity is released below.
      if (id) { this.records.delete(id); this.writes.delete(id); }
      throw error;
    } finally { this.pendingCreates--; }
  }
  get(id: string): EnvironmentRun | undefined { const record = this.records.get(id); return record && structuredClone(record); }
  async result(id: string): Promise<unknown> { return this.store.read(this.store.processedDirectory, `run-${id}`); }
  subscribe(id: string, listener: (event: { type: "run.status"; run: EnvironmentRun }) => void): () => void {
    const callbacks = this.listeners.get(id) ?? new Set(); callbacks.add(listener); this.listeners.set(id, callbacks);
    return () => { callbacks.delete(listener); if (!callbacks.size) this.listeners.delete(id); };
  }
  private persist(id: string): Promise<void> {
    const snapshot = structuredClone(this.records.get(id)!);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(() => this.store.write(this.store.runsDirectory, id, snapshot));
    this.writes.set(id, write);
    return write;
  }
  private async update(id: string, changes: Partial<EnvironmentRun>): Promise<void> {
    const record = this.records.get(id)!;
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    await this.persist(id);
    this.notify(id);
  }
  private notify(id: string): void {
    const record = this.records.get(id)!;
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener({ type: "run.status", run: structuredClone(record) }); }
      catch (error) { console.error("Environmental status listener failed", error); }
    }
  }
  private async fail(id: string, error: unknown): Promise<void> {
    const record = this.records.get(id)!;
    const message = (error instanceof Error ? error.message : "Environmental operation failed").slice(0, 4500);
    Object.assign(record, { status: "failed", progress: 100, stage: "failed", updatedAt: new Date().toISOString(), error: { code: "DATA_ACQUISITION_FAILED", message } });
    delete record.resultUrl;
    try { await this.persist(id); }
    catch (persistenceError) {
      const reason = (persistenceError instanceof Error ? persistenceError.message : "Unknown persistence error").slice(0, 1000);
      // Disk failure can prevent durable reporting of the disk failure itself.
      // Keep an honest terminal state available to HTTP/events in this process.
      record.error = { code: "RUN_PERSISTENCE_FAILED", message: `${message}. Terminal status could not be saved: ${reason}. This failure status is available in memory only.` };
      record.details = { ...record.details, persistence: { status: "failed", reason } };
      record.updatedAt = new Date().toISOString();
      console.error("Environmental terminal status could not be persisted", persistenceError);
    }
    this.notify(id);
  }
  private async drain(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const id = this.queue.shift()!;
        const record = this.records.get(id)!;
        let progressWrite = Promise.resolve();
        try {
          await this.update(id, { status: "running", progress: 5, stage: "starting" });
          const result = await this.execute(structuredClone(record.request), this.abort.signal, (progress, stage, details) => {
            progressWrite = progressWrite.then(() => this.update(id, { progress, stage, details })).catch(error => { console.error("Progress persistence failed", error); });
          });
          await progressWrite;
          if (this.closed) break;
          await this.store.write(this.store.processedDirectory, `run-${id}`, result);
          await this.update(id, { status: "completed", progress: 100, stage: "completed", resultUrl: `/v1/runs/${id}/results` });
        } catch (error) {
          await progressWrite;
          await this.fail(id, error);
        }
      }
    } finally { this.running = false; }
  }
  async close(): Promise<void> { this.closed = true; this.abort.abort(); this.listeners.clear(); await Promise.allSettled(this.writes.values()); }
}
