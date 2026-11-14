#!/usr/bin/env node
// Cloud Shadow - year-by-year timeline for the Unreal slider (past -> present -> future).
//   npm run data:timeline   (node scripts/export_timeline.cjs)
//
// Writes data/cloudshadow/unreal/timeline/<site>.csv  (+ <site>.json with metadata)
//   One row per year, FIRST_YEAR..LAST_PROJECTED_YEAR.
//   Phase = observed | present | projected
//   For each variable V:  V_Site, V_Surround (annual means), V_SiteLo, V_SiteHi (projected band only)
//   Weather (NASA POWER): T2M, WS10M, PlumeTowardDeg, PrecipMMDay (projected years = last-10-year climatology)
//   Imagery: ImageryLayer, ImageryDate, ImageryUrl (cloud-free 30 m HLS for that year, if any)
//
// Projection = "if the measured trend continues": Sen's slope through the median point, with the band from the
// slope's 95% CI (Gilbert 1987). Only for variables with >= 10 observed years. It is NOT a forecast.
const fs = require("fs"), path = require("path");
const { DATA, Stats, loadAll } = require("./summary.cjs");

const FIRST = 2003, LAST_PROJ = 2035;
const VARS = ["LST_Night", "LST_Day", "NDVI", "AOD", "NO2_OMI", "NO2", "AirTemp"];
const MIN_YEARS_FOR_PROJECTION = 10;
const all = loadAll();
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8")); } catch { return f; } };
const hlsTimeline = readJson("hls_timeline.json", {});
const outDir = path.join(DATA, "unreal", "timeline"); fs.mkdirSync(outDir, { recursive: true });
const r = (x, d = 4) => (x == null || !isFinite(x) ? "" : +x.toFixed(d));

for (const s of all.sites) {
  const ser = all.series[s.id] || {};
  const meta = { site: s.id, generated: new Date().toISOString().slice(0, 10), projections: {}, note:
    "Projected rows extend the observed Sen's-slope trend (95% CI band). They show where the trend points, not a forecast." };
  const perVar = {};
  let lastObserved = FIRST;
  for (const v of VARS) {
    const d = ser[v]; if (!d) continue;
    // Annual values from de-seasonalized monthly anomalies + the long-term mean, so a partial year
    // (e.g. the current one, missing winter months) isn't season-biased.
    const level = (vals) => { const a = vals.filter(Stats.isNum); return a.length ? Stats.mean(a) : 0; };
    const annual = (vals, minM) => { const an = Stats.annual(d.t, Stats.deseasonalize(d.t, vals), minM); const L = level(vals); return { ...an, y: an.y.map((y) => y + L) }; };
    const annS = annual(d.site, 6), annR = annual(d.ref, 6);
    const site = new Map(annS.years.map((y, i) => [y, annS.y[i]])), ref = new Map(annR.years.map((y, i) => [y, annR.y[i]]));
    let proj = null;
    if (annS.years.length >= MIN_YEARS_FOR_PROJECTION) {
      const mk = Stats.mannKendall(annS.x, annS.y);
      proj = mk;
      meta.projections[v] = { slopePerDecade: mk.slope * 10, ci95PerDecade: [mk.slopeLo * 10, mk.slopeHi * 10], p: mk.p, years: annS.years.length };
    }
    perVar[v] = { site, ref, proj, lastYear: annS.years[annS.years.length - 1] };
    if (annS.years.length) lastObserved = Math.max(lastObserved, annS.years[annS.years.length - 1]);
  }
  // NASA POWER weather by year (observed) + climatology of the last 10 years for projected rows
  const w = readJson(`weather/${s.id}.json`, { rows: [] }).rows;
  const wy = new Map();
  for (const row of w) { const a = wy.get(row.year) || []; a.push(row); wy.set(row.year, a); }
  const wAnnual = (rows) => {
    if (!rows || rows.length < 10) return null;
    const m = (k) => rows.reduce((t, x) => t + x[k], 0) / rows.length;
    const u = rows.reduce((t, x) => t - x.WS10M * Math.sin(x.WD10M * Math.PI / 180), 0) / rows.length;
    const vv = rows.reduce((t, x) => t - x.WS10M * Math.cos(x.WD10M * Math.PI / 180), 0) / rows.length;
    return { T2M: m("T2M"), WS10M: m("WS10M"), Plume: ((Math.atan2(u, vv) * 180 / Math.PI) + 360) % 360, Precip: m("PRECTOTCORR") };
  };
  const wYears = [...wy.keys()].sort();
  const clim = wAnnual(wYears.slice(-10).flatMap((y) => wy.get(y)));

  const header = ["Year", "Phase", ...VARS.flatMap((v) => [`${v}_Site`, `${v}_Surround`, `${v}_SiteLo`, `${v}_SiteHi`]),
    "T2M", "WS10M", "PlumeTowardDeg", "PrecipMMDay", "ImageryLayer", "ImageryDate", "ImageryUrl"];
  const lines = [header.join(",")];
  meta.rows = [];
  for (let y = FIRST; y <= LAST_PROJ; y++) {
    const phase = y < lastObserved ? "observed" : y === lastObserved ? "present" : "projected";
    const cols = [y, phase];
    for (const v of VARS) {
      const pv = perVar[v];
      if (!pv) { cols.push("", "", "", ""); continue; }
      if (y <= pv.lastYear) { cols.push(r(pv.site.get(y)), r(pv.ref.get(y)), "", ""); continue; }
      if (pv.proj && phase === "projected") {
        const { slope, slopeLo, slopeHi, pivotX, pivotY } = pv.proj, x = y + 0.5;
        const c = pivotY + slope * (x - pivotX), lo = pivotY + slopeLo * (x - pivotX), hi = pivotY + slopeHi * (x - pivotX);
        cols.push(r(c), "", r(Math.min(lo, hi)), r(Math.max(lo, hi)));
      } else cols.push("", "", "", "");
    }
    const wa = phase === "projected" ? clim : (wAnnual(wy.get(y)) || (phase === "present" ? clim : null));
    cols.push(r(wa?.T2M, 2), r(wa?.WS10M, 2), r(wa?.Plume, 1), r(wa?.Precip, 2));
    const im = hlsTimeline[s.id]?.[String(y)];
    cols.push(im?.layer || "", im?.date || "", im?.templateUrl || "");
    lines.push(cols.join(","));
    meta.rows.push(Object.fromEntries(header.map((h, i) => [h, cols[i] === "" ? null : cols[i]])));
  }
  meta.lastObservedYear = lastObserved;
  fs.writeFileSync(path.join(outDir, `${s.id}.csv`), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, `${s.id}.json`), JSON.stringify(meta, null, 1));
  console.log(`  ${s.id.padEnd(10)} ${FIRST}-${LAST_PROJ}, present=${lastObserved}, projected vars: ${Object.keys(meta.projections).join(", ")}`);
}
