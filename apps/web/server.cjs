#!/usr/bin/env node
// Cloud Shadow backend: serves the web app + a small JSON API for Unreal.
// Zero dependencies.  Run:  npm run web   (node apps/web/server.cjs; PORT env var, default 8765)
//
//   GET /api/health
//   GET /api/sites                          all sites + headline results + ledger
//   GET /api/sites/:id                      one site
//   GET /api/analysis?site=colossus1&var=NO2  full stats + yearly/monthly series (for charts in UMG)
//   GET /api/layers                         list of NASA overlay layers
//   GET /api/layers/:var?date=2025-07-15    Cesium-ready URL template (date snapped to available data)
const http = require("http"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");
const { environmentGateway } = require('./environment-gateway.cjs');
const { nearbyWaterStations } = require('./water-stations.cjs');
const { DATA, VARS, loadAll, analyzeOne, summarize } = require("../../scripts/summary.cjs");
const WEB = __dirname;
const ROOT = path.resolve(WEB, "../.."), STREAM_CACHE = path.join(ROOT, "tmp", "streamed-neighborhoods");

const PORT = +process.env.PORT || 8765;
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const LAYERS = {
  LST_Day: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", LST_Night: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night",
  NDVI: "MODIS_Terra_L3_NDVI_16Day", NO2: "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", NO2_OMI: "OMI_Nitrogen_Dioxide_Tropo_Column",
  HLS_L30: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", HLS_S30: "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", DIST: "OPERA_L3_DIST-ANN-HLS_Color_Index",
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".xml": "text/xml", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".md": "text/markdown" };

let all = loadAll(), catalog = {};
const reload = () => { all = loadAll(); try { catalog = JSON.parse(fs.readFileSync(path.join(DATA, "gibs_layers.json"), "utf8")); } catch { catalog = {}; } };
reload();

function availableDates(layer) {
  const out = [];
  for (const iv of catalog[layer]?.intervals || []) {
    const [a, b, per] = iv.split("/"); let d = new Date(a.slice(0, 10) + "T00:00:00Z"); const end = new Date(b.slice(0, 10) + "T00:00:00Z");
    const n = parseInt(per.replace(/\D/g, ""), 10), u = per.slice(-1);
    while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d); if (u === "D") d.setUTCDate(d.getUTCDate() + n); else if (u === "M") d.setUTCMonth(d.getUTCMonth() + n); else d.setUTCFullYear(d.getUTCFullYear() + n); }
  }
  return out;
}
function layerInfo(key, date) {
  const layer = LAYERS[key]; const c = catalog[layer]; if (!c) return null;
  const ds = availableDates(layer); const want = Date.parse(date || new Date().toISOString().slice(0, 10));
  const snapped = ds.reduce((best, d) => (Math.abs(Date.parse(d) - want) < Math.abs(Date.parse(best) - want) ? d : best), ds[ds.length - 1]);
  return { key, layer, date: snapped, maximumLevel: c.z, projection: "WebMercator", tileSize: 256,
    templateUrl: `${GIBS}/${layer}/default/${snapped}/${c.tms}/{z}/{y}/{x}.png`,
    legendUrl: `https://gibs.earthdata.nasa.gov/legends/${layer}_H.svg`, firstDate: ds[0], lastDate: ds[ds.length - 1] };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
  res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body, null, 1));
}

function neighborhoodQuery(params) {
  const coordinate = (name, max) => {
    const values = params.getAll(name), raw = values[0]?.trim();
    if (values.length !== 1 || !raw || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) throw new Error(`one finite ${name} coordinate is required`);
    const value = Number(raw);
    if (!Number.isFinite(value) || Math.abs(value) > max) throw new Error(`${name} must be between ${-max} and ${max}`);
    return value;
  };
  const lat = coordinate("lat", 75), lon = coordinate("lon", 180);
  const north = Math.round(lat * 100) || 0, east = Math.round(lon * 100) || 0;
  return { id: `stream-${north < 0 ? "s" : "n"}${Math.abs(north)}-${east < 0 ? "w" : "e"}${Math.abs(east)}`,
    center: { lat: north / 100, lon: east / 100 }, requestedCenter: { lat, lon }, radiusM: 3300 };
}

function validNeighborhoodResult(result) {
  const snapshot = result?.snapshot, center = snapshot?.center;
  if (snapshot?.status !== "ready" || !Number.isFinite(center?.lat) || !Number.isFinite(center?.lon)
    || Math.abs(center.lat) > 75 || Math.abs(center.lon) > 180 || !Array.isArray(snapshot.buildings)
    || !Array.isArray(snapshot.roads) || !Array.isArray(snapshot.areas)) throw new Error("map acquisition did not return a ready mapped snapshot");
  const elevation = result.elevation;
  if (elevation != null && (!["ready", "partial", "unknown"].includes(elevation.status)
    || !Number.isInteger(elevation.width) || !Number.isInteger(elevation.height)
    || elevation.width < 1 || elevation.height < 1 || elevation.width * elevation.height > 4096
    || !Array.isArray(elevation.heights) || elevation.heights.length !== elevation.width * elevation.height
    || elevation.heights.some((height) => height !== null && !Number.isFinite(height)))) throw new Error("invalid elevation result; missing ground must remain unknown");
  const recreation=result.recreation;
  const validRecreation=recreation&&["ready","unknown","failed"].includes(recreation.status)&&Array.isArray(recreation.features)&&recreation.features.length<=10000
    &&recreation.center?.lat===center.lat&&recreation.center?.lon===center.lon;
  return { status: "ready", snapshot, elevation: elevation ?? null, urban: result.urban ?? null, recreation:validRecreation?recreation:null };
}

async function readStreamCache(query) {
  const file = path.join(STREAM_CACHE, `bundle-${query.id}.json`);
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > 64 * 1024 * 1024) return null;
    const result = validNeighborhoodResult(JSON.parse(await fs.promises.readFile(file, "utf8")));
    if (result.snapshot.center.lat !== query.center.lat || result.snapshot.center.lon !== query.center.lon) return null;
    return result;
  } catch { return null; }
}

// Existing study snapshots may satisfy an almost-identical request, but keep
// their original center/extent. They never stand in for new territory after a pan.
async function readNearbyStudy(query) {
  const site = all.sites.find((site) => Math.hypot((site.lat - query.requestedCenter.lat) * 111320,
    (site.lon - query.requestedCenter.lon) * 111320 * Math.cos(site.lat * Math.PI / 180)) <= 300);
  if (!site) return null;
  const read = async (prefix) => { try { return JSON.parse(await fs.promises.readFile(path.join(DATA, "neighborhoods", `${prefix}${site.id}.json`), "utf8")); } catch { return null; } };
  const [snapshot, elevation, urban,recreation] = await Promise.all([read(""), read("elevation-"), read("urban-"),read("recreation-")]);
  try { return validNeighborhoodResult({ snapshot, elevation, urban,recreation }); } catch { return null; }
}

function pythonNeighborhoodRunner(query, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error("map acquisition was stopped before it started"));
  return new Promise((resolve, reject) => {
    // Only validated numeric coordinates are passed as separate argv values.
    // The executable/script/cache directory cannot be supplied by HTTP callers.
    const child = spawn(process.env.DATA_PYTHON_EXECUTABLE || process.env.PYTHON || "python", [path.join(ROOT, "scripts", "stream-neighborhood.py"),
      "--lat", String(query.center.lat), "--lon", String(query.center.lon)], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "", settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill(); finish(new Error("map acquisition timed out or was stopped")); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { tail = (tail + chunk.toString()).slice(-4096); });
    child.on("error", (error) => finish(new Error(`map worker could not start: ${error.message}`)));
    child.on("close", async (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`map acquisition failed${tail.trim() ? `: ${tail.trim().slice(-600)}` : ""}`));
      const result = await readStreamCache(query);
      finish(result ? null : new Error("map worker returned no valid cached snapshot"), result);
    });
  });
}

function createNeighborhoodService({ runner = pythonNeighborhoodRunner,
  lookupCached = async (query) => await readStreamCache(query) || await readNearbyStudy(query),
  maxConcurrent = 1, maxQueued = 4, maxRecords = 12, maxReady = 2, timeoutMs = 180000, cooldownMs = 60000, now = Date.now } = {}) {
  // Production serializes public-provider requests. The service also supports
  // at most two injected/local workers; HTTP callers cannot raise these limits.
  maxConcurrent = Math.max(1, Math.min(2, Math.floor(maxConcurrent)));
  maxQueued = Math.max(0, Math.min(8, Math.floor(maxQueued)));
  const jobs = new Map(), queue = [];
  let running = 0, closed = false;
  const trim = () => {
    const terminal = [...jobs.values()].filter((job) => ["ready", "failed"].includes(job.status)).sort((a, b) => a.updatedAt - b.updatedAt);
    let ready = terminal.filter((job) => job.status === "ready").length;
    for (const job of terminal) if ((job.status !== "failed" || now() - job.updatedAt >= cooldownMs)
      && (jobs.size > maxRecords || (job.status === "ready" && ready > maxReady))) {
      jobs.delete(job.query.id); if (job.status === "ready") ready--;
    }
  };
  function drain() {
    while (!closed && running < maxConcurrent && queue.length) {
      const job = queue.shift(); job.status = "loading"; running++;
      const controller = new AbortController(); job.controller = controller;
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("map acquisition exceeded its 180-second time budget")); }, timeoutMs); timer.unref?.(); });
      Promise.race([Promise.resolve().then(() => runner(job.query, { signal: controller.signal })), deadline])
        .then((result) => { job.result = validNeighborhoodResult(result); job.status = "ready"; })
        .catch((error) => { job.status = "failed"; job.error = String(error?.message || error).slice(0, 1200); })
        .finally(() => { clearTimeout(timer); job.updatedAt = now(); job.controller = null; running--; trim(); drain(); });
    }
  }
  const response = (job) => {
    if (job.status === "ready") return { code: 200, body: { ...job.result, id: job.query.id } };
    if (job.status === "failed") return { code: 503, body: { status: "failed", error: job.error,
      retryAfterMs: Math.max(0, cooldownMs - (now() - job.updatedAt)), id: job.query.id } };
    return { code: 202, body: { status: job.status, retryAfterMs: 2000, id: job.query.id, center: job.query.center } };
  };
  return {
    async get(params) {
      let query;
      try { query = neighborhoodQuery(params); } catch (error) { return { code: 400, body: { status: "failed", error: error.message } }; }
      if (closed) return { code: 503, body: { status: "failed", error: "map service is stopping", retryAfterMs: 60000 } };
      let job = jobs.get(query.id);
      if (job && !(job.status === "failed" && now() - job.updatedAt >= cooldownMs)) return response(job);
      if (job) jobs.delete(query.id);
      let cached;
      try { cached = await lookupCached(query); if (cached) cached = validNeighborhoodResult(cached); } catch { cached = null; }
      if (closed) return { code: 503, body: { status: "failed", error: "map service is stopping", retryAfterMs: 60000 } };
      // Two simultaneous requests may have awaited the same cache read.
      job = jobs.get(query.id); if (job) return response(job);
      if (cached) {
        job = { query, status: "ready", result: cached, updatedAt: now() }; jobs.set(query.id, job); trim(); return response(job);
      }
      // Preserve recent failure records so evicting a cache entry cannot bypass
      // provider cooldown. Pressure rejects new work instead of growing the map.
      if (jobs.size >= maxRecords) {
        const disposable = [...jobs.values()].filter((record) => record.status === "ready" || (record.status === "failed" && now() - record.updatedAt >= cooldownMs))
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (disposable) jobs.delete(disposable.query.id);
        else return { code: 503, body: { status: "failed", error: "map service is cooling down; keep the current area and retry later", retryAfterMs: cooldownMs } };
      }
      if (running >= maxConcurrent && queue.length >= maxQueued) return { code: 503, body: { status: "failed", error: "map request queue is full; keep the current area and retry later", retryAfterMs: 5000 } };
      job = { query, status: "pending", updatedAt: now() }; jobs.set(query.id, job); queue.push(job); drain();
      return response(job);
    },
    get stats() { return { running, queued: queue.length, records: jobs.size }; },
    close() { closed = true; queue.length = 0; for (const job of jobs.values()) job.controller?.abort(); },
  };
}

function createWebServer({ neighborhoodService = createNeighborhoodService(), gateway = environmentGateway() } = {}) {
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"); const p = decodeURIComponent(u.pathname);
    if (gateway(req, res, u)) return;
    if(p === '/api/water-stations'){
      if(req.method!=='GET')return send(res,405,{error:'Use GET'});
      try{return send(res,200,await nearbyWaterStations(u.searchParams));}catch(error){return send(res,503,{stations:[],error:error.message});}
    }
    if (p === "/api/neighborhood") {
      if (req.method !== "GET") return send(res, 405, { status: "failed", error: "use GET for neighborhood acquisition" });
      const result = await neighborhoodService.get(u.searchParams);
      if (result.body.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(result.body.retryAfterMs / 1000)));
      return send(res, result.code, JSON.stringify(result.body));
    }
    if (p === "/api/health") return send(res, 200, { ok: true, sites: all.sites.length, capabilities: { neighborhoodStreaming: true } });
    if (p === "/api/reload") { reload(); return send(res, 200, { ok: true }); }
    if (p === "/api/sites") return send(res, 200, { sites: summarize(all) });
    if (p.startsWith("/api/sites/")) { const s = summarize(all).find((x) => x.id === p.split("/")[3]); return s ? send(res, 200, s) : send(res, 404, { error: "unknown site" }); }
    if (p === "/api/analysis") {
      const a = analyzeOne(all, u.searchParams.get("site"), u.searchParams.get("var") || "NO2");
      return a ? send(res, 200, a) : send(res, 404, { error: "no data for that site/var", vars: VARS });
    }
    if (p === "/api/layers") return send(res, 200, { layers: Object.keys(LAYERS).map((k) => layerInfo(k)).filter(Boolean) });
    if (p.startsWith("/api/layers/")) { const l = layerInfo(p.split("/")[3], u.searchParams.get("date")); return l ? send(res, 200, l) : send(res, 404, { error: "unknown layer", layers: Object.keys(LAYERS) }); }
    // static files
    // /data/* -> data/cloudshadow/*, everything else -> apps/web/*
    const base = p.startsWith("/data/") ? DATA : WEB;
    const rel = p.startsWith("/data/") ? p.slice("/data/".length) : (p === "/" ? "index.html" : p.slice(1));
    const f = path.normalize(path.join(base, rel));
    if (!f.startsWith(base + path.sep) || f.includes(`${path.sep}.`) || f.endsWith(".cjs")) return send(res, 403, "forbidden", "text/plain");
    fs.readFile(f, (err, buf) => err ? send(res, 404, "not found", "text/plain") : send(res, 200, buf, MIME[path.extname(f)] || "application/octet-stream"));
  } catch (e) { send(res, 500, { error: String(e) }); }
});
server.on("close", () => neighborhoodService.close?.());
return server;
}

module.exports = { createWebServer, createNeighborhoodService, neighborhoodQuery, pythonNeighborhoodRunner, validNeighborhoodResult };
if (require.main === module) {
  (async () => {
    let apiPort = Number(process.env.ENVIRONMENT_API_PORT || 3000);
    if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535)throw new Error('Invalid ENVIRONMENT_API_PORT');
    let api;
    if (process.env.ENVIRONMENT_API_AUTOSTART !== '0') {
      try {
        const { createApi } = await import('../api/src/server.ts');
        api = await createApi();
        const listenApi = port => new Promise((resolve, reject) => { const error=e=>{api.server.off('listening',ready);reject(e);};const ready=()=>{api.server.off('error',error);resolve();};api.server.once('error',error);api.server.once('listening',ready);api.server.listen(port,'127.0.0.1'); });
        try{await listenApi(apiPort);}catch(error){if(error.code!=='EADDRINUSE')throw error;await listenApi(0);apiPort=api.server.address().port;}
        console.log(`Environmental models connected on loopback:${apiPort}`);
      } catch (error) {
        if (api) await api.close(); api = null;
        console.warn(`Live environmental jobs unavailable: ${error.message}`);
      }
    }
    const server = createWebServer({gateway:environmentGateway({port:apiPort})});
    server.listen(PORT, '127.0.0.1', () => console.log(`Footprint Atlas on http://localhost:${PORT} · environmental gateway /api/environment`));
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { server.close(); void api?.close().finally(()=>process.exit(0)); if(!api)process.exit(0); });
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
