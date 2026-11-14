#!/usr/bin/env node
// Cloud Shadow - export analysis results in Unreal-friendly formats.
//   npm run data:unreal   (node scripts/export_unreal.cjs)
// Writes:
//   data/cloudshadow/unreal/CloudShadowSites.csv    -> import as a DataTable (row struct S_CloudShadowSite, see UNREAL.md)
//   data/cloudshadow/unreal/CloudShadowSites.json   -> same data, nested
//   data/cloudshadow/unreal/series/<site>_<var>.csv -> yearly series (Year,Site,Surroundings,LocalAnomaly)
const fs = require("fs"), path = require("path");
const { DATA, VARS, loadAll, analyzeOne, summarize } = require("./summary.cjs");

const all = loadAll();
const outDir = path.join(DATA, "unreal"); fs.mkdirSync(path.join(outDir, "series"), { recursive: true });
const r = (x, d = 4) => (x == null || !isFinite(x) ? "" : +x.toFixed(d));
const q = (s) => `"${String(s ?? "").replace(/"/g, "'")}"`;

const sites = summarize(all);
for (const s of sites) for (const v of VARS) {
  const a = analyzeOne(all, s.id, v); if (!a) continue;
  const byYear = new Map();
  for (const k of ["site", "surroundings", "localAnomaly"]) for (const { year, value } of a.yearly[k]) (byYear.get(year) || byYear.set(year, {}).get(year))[k] = value;
  const lines = ["Year,Site,Surroundings,LocalAnomaly", ...[...byYear].sort((x, y) => x[0] - y[0]).map(([y, o]) => [y, r(o.site), r(o.surroundings), r(o.localAnomaly)].join(","))];
  fs.writeFileSync(path.join(outDir, "series", `${s.id}_${v}.csv`), lines.join("\n") + "\n");
}

// DataTables dislike blanks: missing change -> 0, missing p -> 1 (= "no evidence")
const ch = (s, v) => r(s.results[v]?.beforeAfter?.change) || 0;
const pv = (s, v) => { const x = r(s.results[v]?.beforeAfter?.p); return x === "" ? 1 : x; };
const header = "Name,DisplayName,Place,Latitude,Longitude,Onset,PowerMW,NO2Change,NO2P,AODChange,AODP,LSTDayChange,LSTDayP,LSTNightChange,LSTNightP,AirTempChange,AirTempP,NDVIChange,NDVIP,Headline";
const rows = sites.map((s) => [s.id, q(s.name), q(s.place), s.lat, s.lon, q(s.onset), s.powerMW ?? 0,
  ...["NO2", "AOD", "LST_Day", "LST_Night", "AirTemp", "NDVI"].flatMap((v) => [ch(s, v), pv(s, v)]), q(s.headline)].join(","));
fs.writeFileSync(path.join(outDir, "CloudShadowSites.csv"), [header, ...rows].join("\n") + "\n");
fs.writeFileSync(path.join(outDir, "CloudShadowSites.json"), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), sites }, null, 2));
console.log("wrote", rows.length, "sites to data/cloudshadow/unreal/");
