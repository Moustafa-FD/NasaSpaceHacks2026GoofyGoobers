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
const { DATA, VARS, loadAll, analyzeOne, summarize } = require("../../scripts/summary.cjs");
const WEB = __dirname;

const PORT = +process.env.PORT || 8765;
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const LAYERS = {
  LST_Day: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", LST_Night: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night",
  NDVI: "MODIS_Terra_L3_NDVI_16Day", NO2: "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", NO2_OMI: "OMI_Nitrogen_Dioxide_Tropo_Column",
  HLS_L30: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", HLS_S30: "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", DIST: "OPERA_L3_DIST-ANN-HLS_Color_Index",
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".xml": "text/xml", ".csv": "text/csv", ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/markdown" };

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

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); const p = decodeURIComponent(u.pathname);
  try {
    if (p === "/api/health") return send(res, 200, { ok: true, sites: all.sites.length });
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
}).listen(PORT, () => console.log(`Cloud Shadow on http://localhost:${PORT}  (API: /api/sites, /api/analysis?site=colossus1&var=NO2, /api/layers/NO2?date=2025-07-15)`));
