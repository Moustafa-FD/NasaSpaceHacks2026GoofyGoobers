// Shared by server.js (API) and export_unreal.js (CSV/JSON for Unreal).
// Runs the same statistics as the web app (js/stats.js) on the precomputed series.
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data", "cloudshadow");

const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "apps/web/js/stats.js"), "utf8") + ";this.Stats = Stats;", ctx);
const Stats = ctx.Stats;

const VARS = ["NO2", "NO2_OMI", "AOD", "LST_Day", "LST_Night", "AirTemp", "NDVI"];
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8")); } catch { return fallback; } };

function loadAll() {
  const doc = readJson("sites.json", { sites: [], context: {} });
  const hls = readJson("hls_dates.json", {});
  const series = Object.fromEntries(doc.sites.map((s) => [s.id, readJson(`series/${s.id}.json`, { vars: {} }).vars]));
  return { ...doc, hls, series };
}

function analyzeOne(all, siteId, varId) {
  const s = all.sites.find((x) => x.id === siteId); const ser = all.series[siteId]?.[varId];
  if (!s || !ser) return null;
  const a = Stats.analyze(ser, s.onset);
  const ann = (vals) => { const r = Stats.annual(a.t, vals); return r.years.map((y, i) => ({ year: y, value: r.y[i] })); };
  return {
    site: siteId, variable: varId, onset: s.onset,
    beforeAfter: a.ba ? { change: a.ba.diff, ci95: [a.ba.lo, a.ba.hi], p: a.ba.p, monthsBefore: a.ba.nA, monthsAfter: a.ba.nB, significant: a.ba.p < 0.05 } : null,
    trendPerDecade: {
      site: { slope: a.trendSite.slope * 10, p: a.trendSite.p },
      surroundings: { slope: a.trendRef.slope * 10, p: a.trendRef.p },
      local: { slope: a.trendDiff.slope * 10, p: a.trendDiff.p, significant: a.trendDiff.p < 0.05 },
    },
    yearly: { site: ann(a.site), surroundings: ann(a.ref), localAnomaly: a.trendDiff.annual.years.map((y, i) => ({ year: y, value: a.trendDiff.annual.y[i] })) },
    monthly: { t: a.t, site: a.site, surroundings: a.ref },
  };
}

function summarize(all) {
  return all.sites.map((s) => {
    const L = s.ledger || {}, results = {};
    for (const v of VARS) { const r = analyzeOne(all, s.id, v); if (r) results[v] = { beforeAfter: r.beforeAfter, trendPerDecade: r.trendPerDecade }; }
    return { id: s.id, name: s.name, place: s.place, lat: s.lat, lon: s.lon, onset: s.onset, headline: s.headline,
      powerMW: L.power?.mw ?? null, results, hls: all.hls[s.id] || null, ledger: L, sources: s.sources || [], neighbors: s.neighbors || [] };
  });
}

module.exports = { ROOT, DATA, Stats, VARS, loadAll, analyzeOne, summarize };
