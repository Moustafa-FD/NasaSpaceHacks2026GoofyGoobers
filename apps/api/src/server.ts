import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ENVIRONMENT_DOMAINS, validateEnvironmentRequest, type EnvironmentRequest } from "../../../packages/contracts/src/environment.ts";
import { EnvironmentStore } from "./environment/store.ts";
import { EnvironmentJobs, EnvironmentCapacityError } from "./environment/jobs.ts";
import { environmentExecutor, type EnvironmentExecutor } from "./environment/service.ts";
import { validateGroundEvidence } from "./environment/ground-evidence.ts";
import { libraryInventory, LibraryQueryError, queryLibrary } from "./environment/library.ts";

class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

/** Browser front ends (Part 3) allowed to call this loopback API. Override with API_CORS_ORIGINS (comma-separated). */
export function corsOrigins(env = process.env.API_CORS_ORIGINS): Set<string> {
  const defaults = ["http://localhost:8765", "http://127.0.0.1:8765", "http://localhost:8080", "http://127.0.0.1:8080", "https://moustafa-fd.github.io"];
  return new Set((env ? env.split(",") : defaults).map(origin => origin.trim()).filter(origin => /^https?:\/\/[^/\s]+$/.test(origin)));
}

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

export async function createApi(options: { store?: EnvironmentStore; executor?: EnvironmentExecutor } = {}) {
  const store = options.store ?? new EnvironmentStore();
  const runs = new EnvironmentJobs(store, options.executor ?? environmentExecutor(store));
  await runs.init();
  const allowedOrigins = corsOrigins();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      const origin = request.headers.origin;
      if (origin && allowedOrigins.has(origin)) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
      if (request.method === "OPTIONS") {
        if (!origin || !allowedOrigins.has(origin)) return send(response, 403, { error: { code: "CORS_ORIGIN_NOT_ALLOWED", message: "Origin not in API_CORS_ORIGINS" } });
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600" });
        return response.end();
      }
      if (request.method === "GET" && path === "/health") return send(response, 200, { status: "ok", schemaVersion: "1.0", mode: "environmental", persistence: "local-files" });
      if (request.method === "GET" && path === "/v1/domains") return send(response, 200, { schemaVersion: "1.0", domains: ENVIRONMENT_DOMAINS });
      if (request.method === "GET" && (path === "/v1/facilities" || path === "/v1/emissions")) return send(response, 200, await queryLibrary(store, url.searchParams, path.endsWith("facilities") ? "facilities" : "emissions"));
      if (request.method === "GET" && path === "/v1/catalog") {
        const catalog = await store.read(store.processedDirectory, "catalog");
        return send(response, 200, catalog ?? { schemaVersion: "1.0", status: "not_synced", access: "metadata_only", records: [], instruction: "Submit a sync run to discover the curated challenge collections" });
      }
      if (request.method === "GET" && path === "/v1/inventory") {
        return send(response, 200, {
          schemaVersion: "1.0", scope: "global_environmental_recent_priority",
          downloadedCacheBytes: await store.bytes(),
          globalData: await store.read(join(store.rawDirectory, "power-grid"), "inventory") ?? null,
          acquisition: await store.read(store.processedDirectory, "global-acquisition") ?? null,
          catalog: await store.read(store.processedDirectory, "catalog") ?? null,
          datasets: await libraryInventory(store),
          geographicPriority: ["CA", "US"],
          warnings: ["Source/catalog coverage is separate from actual downloaded coverage.", "An open-ended CMR metadata date is not verified latest-observation availability."]
        });
      }
      if (request.method === "GET" && path === "/v1/sources") return send(response, 200, {
        schemaVersion: "1.0",
        sources: [
          { id: "osm", provider: "OpenStreetMap contributors / Overpass API", access: "public", adapterStatus: "live_adapter", coverage: "global mapped elements, not a complete facility census", license: "ODbL-1.0", documentationUrl: "https://dev.overpass-api.de/overpass-doc/en/", note: "Attribution and share-alike obligations apply; distinct map elements can represent one campus. Country tags are incomplete." },
          { id: "npri", provider: "Environment and Climate Change Canada NPRI", access: "public", adapterStatus: "live_adapter", coverage: "Canadian reporting facilities in sector 518210", evidence: "facility_reported_release", documentationUrl: "https://www.canada.ca/en/environment-climate-change/services/national-pollutant-release-inventory/using-interpreting-data.html", note: "Sector candidates require facility verification. Missing values are not zero; reporting methods and preliminary years are retained." },
          { id: "epa-nei", provider: "US EPA National Emissions Inventory", access: "public", adapterStatus: "live_adapter", coverage: "US sector 518210 inventory summaries", evidence: "reported_emissions_inventory", documentationUrl: "https://www.epa.gov/air-emissions-inventories/national-emissions-inventory-nei", note: "Inventory estimates are not ambient measurements or permit limits; source sector coding does not independently confirm a data center." },
          { id: "cams", provider: "Copernicus CAMS via Open-Meteo", access: "public_noncommercial", adapterStatus: "live_model_adapter", coverage: "global point history from August 2022, actual valid dates vary", evidence: "model-derived", documentationUrl: "https://open-meteo.com/en/docs/air-quality-api", note: "PM2.5/PM10/NO2/O3/SO2 concentrations; not measured facility releases or automatic source attribution." },
          { id: "era5", provider: "Copernicus ERA5 via Open-Meteo", access: "public_noncommercial", adapterStatus: "live_model_adapter", coverage: "global point history from 1940; about five days publication delay", evidence: "model-derived", documentationUrl: "https://open-meteo.com/en/docs/historical-weather-api", note: "Daily rain, reference ET0, temperature and soil moisture at three depths; not water chemistry or facility consumption." },
          { id: "highresmip", provider: "CMIP6 HighResMIP via Open-Meteo", access: "public_noncommercial", adapterStatus: "live_climate_scenario_adapter", coverage: "point simulations 1950-01-01 through 2050-01-01", evidence: "climate-scenario", documentationUrl: "https://open-meteo.com/en/docs/climate-api", note: "Two high-forcing model simulations and agricultural climate-exposure screening; not daily weather forecasts, crop yields or local facility-impact predictions." },
          { id: "ground-evidence", access: "local_user_import", adapterStatus: "structural_validation_only", coverage: "water quality, noise, crop and vegetation records supplied with source references", note: "No ground measurements ship with this importer; records are not independently verified." },
          { id: "usgs", provider: "U.S. Geological Survey", access: "public_anonymous_bounded", adapterStatus: "live_ground_adapter", coverage: "USGS monitoring locations and available station-specific parameters", evidence: "ground-observation", documentationUrl: "https://api.waterdata.usgs.gov/docs/ogcapi/", note: "Water temperature, conductance, pH, dissolved oxygen and turbidity where recorded; provisional/qualifier/method metadata retained. No automatic data-center attribution." },
          { id: "power-grid", provider: "NASA POWER / MERRA-2", access: "public", format: "Zarr v2", coverage: "global", resolution: "0.5 degree latitude x 0.625 degree longitude", variables: ["T2M", "PRECTOTCORR", "RH2M", "WS2M"], evidence: "model-derived", documentationUrl: "https://power.larc.nasa.gov/docs/tutorials/service-data-request/aws/", note: "Supplementary NASA source; not one of the 13 challenge links. Actual valid dates and downloaded coverage are in inventory." },
          { id: "power-point", provider: "NASA POWER / MERRA-2", access: "public", coverage: "global point queries", evidence: "model-derived", documentationUrl: "https://power.larc.nasa.gov/docs/services/api/temporal/monthly/", note: "Point results do not mean every global grid cell has been downloaded." },
          { id: "giovanni", access: "earthdata_login_required", adapterStatus: "part2_local_downloader", resourceUrl: "https://giovanni.gsfc.nasa.gov/", note: "Area-averaged series via NASA Harmony with EARTHDATA_TOKEN (python -m services.models.trends.giovanni; account must accept the GES DISC licence). Downloads stay local; pass them to trend-analysis as inline series." },
          { id: "appeears", access: "earthdata_login_required_for_extraction", adapterStatus: "discovery_only", resourceUrl: "https://appeears.earthdatacloud.nasa.gov/", note: "Public product metadata is distinct from an authenticated extraction task." },
          { id: "gistemp", access: "public_host_unreachable_during_setup", adapterStatus: "optional_helpers_only", resourceUrl: "https://data.giss.nasa.gov/gistemp/data_v4.html", note: "Direct archive and CSV connections timed out on this laptop; no GISTEMP observations are claimed downloaded." }
        ]
      });
      if (request.method === "POST" && path === "/v1/runs") {
        const body = await readJson(request);
        const errors = validateEnvironmentRequest(body);
        if (body && typeof body === "object" && (body as { kind?: string }).kind === "ground-evidence") errors.push(...validateGroundEvidence(body));
        if (errors.length) return send(response, 422, { error: { code: "INVALID_ENVIRONMENT_REQUEST", message: "Environmental request validation failed", details: errors } });
        const run = await runs.create(body as EnvironmentRequest);
        return send(response, 202, { id: run.id, status: run.status, statusUrl: `/v1/runs/${run.id}`, resultUrl: `/v1/runs/${run.id}/results`, eventsUrl: `/v1/runs/${run.id}/events` });
      }
      const match = /^\/v1\/runs\/([0-9a-f-]{36})(\/results)?$/.exec(path);
      if (request.method === "GET" && match) {
        const run = runs.get(match[1]);
        if (!run) return send(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        if (!match[2]) return send(response, 200, run);
        if (run.status !== "completed") return send(response, 409, { error: { code: "RESULT_UNAVAILABLE", message: `Run is ${run.status}` } });
        return send(response, 200, await runs.result(run.id));
      }
      send(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    })().catch(error => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof RequestError) return send(response, error.status, { error: { code: "INVALID_REQUEST", message: error.message } });
      if (error instanceof LibraryQueryError) return send(response, 400, { error: { code: "INVALID_LIBRARY_QUERY", message: error.message } });
      if (error instanceof EnvironmentCapacityError) return send(response, 503, { error: { code: "CAPACITY_REACHED", message: error.message } });
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
      await runs.close();
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
  const api = await createApi();
  api.server.listen(port, "127.0.0.1", () => console.log(`Environmental API: http://127.0.0.1:${port} (global NASA data inventory and local cache)`));
  api.server.on("error", error => { console.error(error); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void api.close().then(() => process.exit(0)); });
}
