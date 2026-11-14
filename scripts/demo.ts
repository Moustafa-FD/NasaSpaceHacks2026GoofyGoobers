import { readFile } from "node:fs/promises";
import type { ResultManifest, RunSnapshot } from "../packages/contracts/src/index.ts";

const base = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const scenario = JSON.parse(await readFile(new URL("../data/examples/scenario.json", import.meta.url), "utf8"));
const response = await fetch(new URL("/v1/runs", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scenario) });
if (!response.ok) throw new Error(`Submit failed (${response.status}): ${await response.text()}`);
const job = await response.json() as { id: string; statusUrl: string; resultUrl: string; eventsUrl: string };
console.log(`Run ${job.id}: synthetic inputs, illustrative accounting only.`);
const streamUrl = new URL(job.eventsUrl, base);
streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(streamUrl);
socket.addEventListener("message", event => console.log(`Event: ${event.data}`));
socket.addEventListener("error", () => console.log("Progress stream unavailable; HTTP status polling remains authoritative."));

try {
  const deadline = Date.now() + 60_000;
  let completed = false;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(new URL(job.statusUrl, base));
    if (!statusResponse.ok) throw new Error(`Status request failed: ${statusResponse.status}`);
    const run = await statusResponse.json() as RunSnapshot;
    if (run.status === "failed") throw new Error(run.error?.message ?? "Run failed");
    if (run.status === "completed") { completed = true; break; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  if (!completed) throw new Error("Demo timed out waiting for results");
  const resultResponse = await fetch(new URL(job.resultUrl, base));
  if (!resultResponse.ok) throw new Error(`Result request failed: ${resultResponse.status}`);
  const result = await resultResponse.json() as ResultManifest;
  console.log(JSON.stringify(result, null, 2));
} finally { socket.close(); }
