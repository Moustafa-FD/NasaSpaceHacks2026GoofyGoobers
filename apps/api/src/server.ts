import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { DOMAINS, type Scenario } from "../../../packages/contracts/src/index.ts";
import { pythonRunner, type ModelRunner } from "./model-worker.ts";
import { RunManager, CapacityError } from "./run-manager.ts";
import { scenarioErrors } from "./validation.ts";

class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        if (!tooLarge) reject(new RequestError(413, "Request exceeds 64 KiB"));
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RequestError(400, "Request body must be valid JSON")); }
    });
    request.on("error", reject);
    request.on("aborted", () => reject(new RequestError(400, "Request was aborted")));
  });
}

export function createApi(options: { runner?: ModelRunner; maxRuns?: number } = {}) {
  const timeout = Number(process.env.WORKER_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300_000) throw new Error("WORKER_TIMEOUT_MS must be an integer from 100 to 300000");
  const runs = new RunManager(options.runner ?? pythonRunner(process.env.PYTHON_EXECUTABLE ?? "python", timeout), options.maxRuns);
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/health") return send(response, 200, { status: "ok", schemaVersion: "1.0", mode: "illustrative" });
      if (request.method === "GET" && path === "/v1/domains") return send(response, 200, { schemaVersion: "1.0", domains: DOMAINS });
      if (request.method === "POST" && path === "/v1/runs") {
        const body = await readJson(request);
        const errors = scenarioErrors(body);
        if (errors.length) return send(response, 422, { error: { code: "INVALID_SCENARIO", message: "Scenario validation failed", details: errors } });
        const run = runs.create(body as Scenario);
        return send(response, 202, { id: run.id, status: run.status, statusUrl: `/v1/runs/${run.id}`, resultUrl: `/v1/runs/${run.id}/results`, eventsUrl: `/v1/runs/${run.id}/events` });
      }
      const match = /^\/v1\/runs\/([0-9a-f-]{36})(\/results)?$/.exec(path);
      if (request.method === "GET" && match) {
        const run = runs.get(match[1]);
        if (!run) return send(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        if (!match[2]) return send(response, 200, run);
        if (run.status !== "completed") return send(response, 409, { error: { code: "RESULT_UNAVAILABLE", message: `Run is ${run.status}` } });
        return send(response, 200, runs.result(run.id));
      }
      send(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    })().catch(error => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof RequestError) return send(response, error.status, { error: { code: "INVALID_REQUEST", message: error.message } });
      if (error instanceof CapacityError) return send(response, 503, { error: { code: "CAPACITY_REACHED", message: error.message } });
      console.error(error);
      send(response, 500, { error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
    });
  });
  server.requestTimeout = 15_000;
  const events = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    let path: string;
    try { path = new URL(request.url ?? "/", "http://localhost").pathname; }
    catch { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const match = /^\/v1\/runs\/([0-9a-f-]{36})\/events$/.exec(path);
    if (!match || !runs.get(match[1])) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    if (events.clients.size >= 64) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    events.handleUpgrade(request, socket, head, connection => {
      const push = (event: unknown) => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(event)); };
      const unsubscribe = runs.subscribe(match[1], push);
      connection.on("close", unsubscribe);
      connection.on("error", unsubscribe);
      connection.on("message", () => connection.close(1008, "Read-only event stream"));
      push({ type: "run.status", run: runs.get(match[1]) });
    });
  });

  return {
    server,
    async close(): Promise<void> {
      runs.close();
      for (const connection of events.clients) connection.terminate();
      events.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  const api = createApi();
  api.server.listen(port, "127.0.0.1", () => console.log(`Illustrative API: http://127.0.0.1:${port} (no live data adapters)`));
  api.server.on("error", error => { console.error(error); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void api.close().then(() => process.exit(0)); });
}
