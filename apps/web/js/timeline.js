// Cloud Shadow - timeline slider: past → present → future, in 3D.
//
// Dragging the slider changes, for the selected site:
//   1. the ground      - real cloud-free NASA HLS 30 m image for that year (cross-faded)
//   2. the heat dome   - translucent dome; height/colour = that year's night-heat signal (site − surroundings)
//   3. the impact ring - 3D bar per year around the site (selected variable's local signal);
//                        future years = ghost bars inside the 95% CI band
//   4. the plume       - (sites with on-site turbines) 3D smoke blowing in that year's NASA POWER wind
//   5. the wind field  - streaks drifting with that year's wind (speed/direction)
//   6. the data layer  - the NASA overlay picked in the top bar follows the year
// Future years (Phase = projected) get a "projection" grade + badge: they extend the measured trend, not a forecast.
//
// Data: data/hls_timeline.json, data/unreal/timeline/<site>.json (rows), produced by scripts/*.
// Hooks into app.js through window.CloudShadow + "cs:ready" / "cs:site" events.

import * as FX from "./fx.js";
import { attachFlow } from "./flowfield.js";

const FIRST = 2003, LAST = 2035;
const RING_RADIUS_M = 5200;
const RING_VARS = { LST_Night: "Night heat", NDVI: "Greenness", NO2_OMI: "NO₂ (20-yr)", LST_Day: "Day heat", AOD: "Particles" };
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + (+v).toFixed(d));

let CS, viewer, FLOW, hlsTimeline = {};
const T = {
  site: null, rows: new Map(), meta: null, year: 2025, ringVar: "LST_Night",
  layers: [], playing: false, playTimer: null,
  dome: null, ring: [], ringLabels: [], valueLabel: null, plume: null, wind: null,
  target: { domeH: 0, domeColor: null, plumeRate: 0, windDir: 0, windSpeed: 3 },
};

// ------------------------------------------------------------------ helpers
const rowFor = (y) => T.rows.get(y) || {};
const num = (v) => (v == null || v === "" ? null : +v);
const localOf = (row, v) => num(row[`${v}_Local`]);
const phaseOf = (y) => rowFor(y).Phase || (y > 2026 ? "projected" : "observed");
const lastObservedYear = () => T.meta?.lastObservedYear ?? 2026;

function enuAt(lat, lon, h = 0) { return Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, h)); }
function offsetLatLon(lat, lon, bearingDeg, distM) {
  const R = 6371000, b = Cesium.Math.toRadians(bearingDeg), φ1 = Cesium.Math.toRadians(lat), λ1 = Cesium.Math.toRadians(lon), δ = distM / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [Cesium.Math.toDegrees(φ2), Cesium.Math.toDegrees(λ2)];
}
function softDot(size = 64) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.4, "rgba(255,255,255,0.55)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, size, size); return c;
}
const SMOKE = softDot(64);

// ------------------------------------------------------------------ data
async function loadSite(site) {
  T.site = site; T.rows.clear(); T.meta = null;
  try {
    const d = await (await fetch(`data/unreal/timeline/${site.id}.json`)).json();
    T.meta = d; for (const r of d.rows) T.rows.set(+r.Year, r);
  } catch (e) { console.warn("timeline data missing for", site.id, e); }
  T.ringVar = site.effects?.ringVar || "LST_Night";
  if (!T.rows.size) return;
  $("#tlRingVar").value = T.ringVar;
  buildEffects();
}

// ------------------------------------------------------------------ 1. ground imagery (cross-fade)
function imageryFor(year) {
  const tl = hlsTimeline[T.site?.id] || {};
  const years = Object.keys(tl).map(Number).sort((a, b) => a - b);
  if (!years.length) return null;
  const shown = years.filter((y) => y <= year).pop() ?? years[0];
  return { ...tl[String(shown)], shownYear: shown };
}
function setGround(year) {
  const im = imageryFor(year); if (!im) return;
  const projected = phaseOf(year) === "projected";
  const key = im.templateUrl + (projected ? "#p" : "");
  const top = T.layers[T.layers.length - 1];
  if (top && top._csKey === key) return;
  const layer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: im.templateUrl, maximumLevel: 12, credit: "NASA HLS via GIBS" }), 1);
  layer._csKey = key; layer.alpha = 0;
  if (projected) { layer.saturation = 0.25; layer.brightness = 0.85; layer.hue = 0.35; layer.contrast = 1.15; }
  T.layers.push(layer);
  const start = performance.now(), dur = 450;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur);
    layer.alpha = k;
    for (const old of T.layers) if (old !== layer) old.alpha = Math.min(old.alpha, 1 - k);
    if (k < 1) requestAnimationFrame(step);
    else for (const old of T.layers.splice(0, T.layers.length - 1)) viewer.imageryLayers.remove(old, true);
  };
  requestAnimationFrame(step);
  $("#tlImagery").textContent = `NASA HLS 30 m · ${im.date}${im.shownYear !== year ? ` (latest image for ${year})` : ""}`;
}

// ------------------------------------------------------------------ 2–5. 3D effects
function clearEffects() {
  if (T.dome) viewer.entities.remove(T.dome);
  for (const e of [...T.ring, ...T.ringLabels]) viewer.entities.remove(e);
  if (T.valueLabel) viewer.entities.remove(T.valueLabel);
  for (const ps of [T.plume, T.wind]) if (ps) viewer.scene.primitives.remove(ps);
  T.dome = T.valueLabel = T.plume = T.wind = null; T.ring = []; T.ringLabels = [];
}

function buildEffects() {
  clearEffects();
  const { lat, lon } = T.site;
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

  // heat dome (animated toward target each frame)
  let domeH = 600, domeCol = Cesium.Color.ORANGE.withAlpha(0.1);
  T.dome = viewer.entities.add({
    position: center,
    ellipsoid: {
      radii: new Cesium.CallbackProperty(() => {
        domeH += (T.target.domeH - domeH) * 0.08;
        return new Cesium.Cartesian3(2200, 2200, Math.max(150, domeH));
      }, false),
      material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => {
        if (T.target.domeColor) domeCol = Cesium.Color.lerp(domeCol, T.target.domeColor, 0.08, new Cesium.Color());
        return domeCol;
      }, false)),
      outline: false,
    },
  });

  // impact ring: one bar per year, clockwise from north
  const rows = [...T.rows.values()];
  const v = T.ringVar, vdef = VARS[v] || { higherIsWorse: true, digits: 2, unit: "" };
  const vals = rows.map((r) => [localOf(r, v), num(r[`${v}_LocalLo`]), num(r[`${v}_LocalHi`])]).flat().filter((x) => x != null);
  const maxAbs = Math.max(1e-6, ...vals.map(Math.abs));
  const years = LAST - FIRST + 1;
  for (let y = FIRST; y <= LAST; y++) {
    const r = rowFor(y), val = localOf(r, v);
    const ang = ((y - FIRST) / years) * 360;
    const [blat, blon] = offsetLatLon(lat, lon, ang, RING_RADIUS_M);
    const h = val == null ? 0 : 150 + (Math.abs(val) / maxAbs) * 2600;
    const worse = val != null && (val > 0) === vdef.higherIsWorse;
    const projected = r.Phase === "projected";
    const base = worse ? Cesium.Color.fromCssColorString("#ff7a2e") : Cesium.Color.fromCssColorString("#3d8fef");
    const bar = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(blon, blat, h / 2),
      cylinder: { length: Math.max(h, 1), topRadius: 170, bottomRadius: 170, material: projected ? base.withAlpha(0.28) : base.withAlpha(0.9), outline: projected, outlineColor: Cesium.Color.fromCssColorString("#9fe8ff").withAlpha(0.8), shadows: Cesium.ShadowMode.ENABLED },
      show: false,
    });
    bar._csYear = y; bar._csVal = val; bar._csH = h; bar._csPos = [blat, blon];
    T.ring.push(bar);
    if ((y - FIRST) % 5 === 2 || y === LAST) {
      const [llat, llon] = offsetLatLon(lat, lon, ang, RING_RADIUS_M + 900);
      T.ringLabels.push(viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(llon, llat, 30),
        label: { text: String(y), font: "600 13px Inter, sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60000) },
      }));
    }
  }
  T.valueLabel = viewer.entities.add({
    position: center,
    label: { text: "", font: "700 15px Inter, sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: Cesium.Color.fromCssColorString("#0b0e13").withAlpha(0.75), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 80000) },
  });

  // wind field: streaks drifting across the site at ~1.5 km
  const enu = enuAt(lat, lon, 0);
  const windVec = new Cesium.Cartesian3();
  const updateWindVec = () => {
    const th = Cesium.Math.toRadians(T.target.windDir), sp = T.target.windSpeed * 60; // time-lapse ×60
    Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(Math.sin(th) * sp, Math.cos(th) * sp, 0), windVec);
  };
  updateWindVec(); T._updateWindVec = updateWindVec;
  T.wind = viewer.scene.primitives.add(new Cesium.ParticleSystem({
    image: SMOKE, startColor: Cesium.Color.WHITE.withAlpha(0.0), endColor: Cesium.Color.WHITE.withAlpha(0.0),
    startScale: 1, endScale: 1, minimumParticleLife: 6, maximumParticleLife: 9, minimumSpeed: 0, maximumSpeed: 1,
    imageSize: new Cesium.Cartesian2(260, 260), sizeInMeters: true, emissionRate: 90, lifetime: 16,
    emitter: new Cesium.BoxEmitter(new Cesium.Cartesian3(26000, 26000, 1400)),
    modelMatrix: enuAt(lat, lon, 1500),
    updateCallback: (p, dt) => {
      Cesium.Cartesian3.clone(windVec, p.velocity);
      const k = p.age / p.life, a = Math.sin(Math.PI * k) * 0.22;
      p.color = Cesium.Color.fromAlpha(Cesium.Color.WHITE, a, p.color);
    },
  }));

  // turbine plume (only where on-site combustion is documented)
  if (T.site.effects?.plume) {
    const up = Cesium.Cartesian3.normalize(center, new Cesium.Cartesian3());
    T.plume = viewer.scene.primitives.add(new Cesium.ParticleSystem({
      image: SMOKE, startColor: Cesium.Color.fromCssColorString("#ffd27a").withAlpha(0.75), endColor: Cesium.Color.fromCssColorString("#a33a1e").withAlpha(0.0),
      startScale: 1.0, endScale: 7.0, minimumParticleLife: 8, maximumParticleLife: 14, minimumSpeed: 20, maximumSpeed: 45,
      imageSize: new Cesium.Cartesian2(140, 140), sizeInMeters: true, emissionRate: 0, lifetime: 16,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(18)),
      modelMatrix: enuAt(lat, lon, 40),
      updateCallback: (p, dt) => {
        // rise + drift with the (time-lapsed) NASA POWER wind
        const target = Cesium.Cartesian3.add(windVec, Cesium.Cartesian3.multiplyByScalar(up, 25, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        Cesium.Cartesian3.lerp(p.velocity, target, Math.min(1, dt * 0.6), p.velocity);
      },
    }));
  }
  T._updateWindVec();
  FX.buildSite(T.site, T.rows);
  applyYear(T.year, { instant: true });
}

// ------------------------------------------------------------------ apply a year
function applyYear(year, { instant = false } = {}) {
  T.year = year;
  const r = rowFor(year), phase = phaseOf(year), projected = phase === "projected";
  // heat dome from night-heat local signal
  const heat = localOf(r, "LST_Night");
  if (heat != null) {
    T.target.domeH = 300 + Math.max(0, heat + 0.6) * 1800;
    T.target.domeColor = (heat > 0 ? Cesium.Color.fromCssColorString("#ff6a1f") : Cesium.Color.fromCssColorString("#3d8fef")).withAlpha(projected ? 0.07 : 0.11);
  }
  // wind
  const wd = num(r.PlumeTowardDeg), ws = num(r.WS10M);
  if (wd != null) T.target.windDir = wd;
  if (ws != null) T.target.windSpeed = ws;
  T._updateWindVec?.();
  // plume: zero before onset; density follows the NO2 local signal (relative), last known for projected
  if (T.plume) {
    const onsetYear = +String(T.site.onset).slice(0, 4);
    let rate = 0;
    if (year >= onsetYear) {
      const ys = [...T.rows.keys()].filter((y) => y <= Math.min(year, lastObservedYear()) && localOf(rowFor(y), "NO2") != null);
      const n = ys.length ? localOf(rowFor(ys[ys.length - 1]), "NO2") : null;
      rate = 25 + Math.max(0, (n ?? 0.3)) * 90;
      if (projected) rate *= 0.6;
    }
    T.plume.emissionRate = Math.min(140, rate);
  }
  // ring bars up to this year; label on the current bar
  for (const bar of T.ring) bar.show = bar._csYear <= year && bar._csH > 0;
  const cur = T.ring.find((b) => b._csYear === year);
  const vdef = VARS[T.ringVar] || { digits: 2, unit: "" };
  if (cur && T.valueLabel) {
    T.valueLabel.position = Cesium.Cartesian3.fromDegrees(cur._csPos[1], cur._csPos[0], cur._csH + 250);
    const lo = num(r[`${T.ringVar}_LocalLo`]), hi = num(r[`${T.ringVar}_LocalHi`]);
    T.valueLabel.label.text = cur._csVal == null ? `${year}` : `${year}: ${fmt(cur._csVal, vdef.digits)} ${vdef.unit}${projected && lo != null ? `\n95% CI ${fmt(lo, vdef.digits)} … ${fmt(hi, vdef.digits)}` : ""}`;
  }
  setGround(year);
  FX.applyYear(year, r, phase);
  FLOW?.setYear(T.site, year, phase); // real GEOS-FP wind (2018+) overrides the annual POWER arrow via "cs:wind"
  // data overlay follows the year (if one is selected and has data that year)
  const kind = CS.getMapLayer?.();
  if (kind && VARS[kind]) CS.setMapLayer(kind, `${Math.min(year, lastObservedYear())}-07-15`);
  renderHud(year, r, phase);
}

// ------------------------------------------------------------------ HUD
function chip(label, v, digits, unit, worseIfPositive, note = "") {
  if (v == null) return `<span class="tl-chip muted">${label} –</span>`;
  const worse = (v > 0) === worseIfPositive;
  return `<span class="tl-chip ${worse ? "bad" : "good"}" title="${note}">${label} <b>${fmt(v, digits)}</b>${unit ? " " + unit : ""}</span>`;
}
function renderHud(year, r, phase) {
  $("#tlYear").textContent = year;
  $("#tlSlider").value = year;
  const badge = $("#tlPhase");
  badge.textContent = phase === "projected" ? "PROJECTED · IF THE TREND CONTINUES" : phase === "present" ? "NOW" : "OBSERVED";
  badge.className = "tl-phase " + phase;
  document.body.classList.toggle("tl-future", phase === "projected");
  const no2 = localOf(r, "NO2") ?? null;
  $("#tlChips").innerHTML =
    chip("Night heat", localOf(r, "LST_Night"), 2, "°C", true, "Site minus surroundings, MODIS night land-surface temperature") +
    chip("Greenness", localOf(r, "NDVI"), 3, "", false, "Site minus surroundings, MODIS NDVI") +
    chip("NO₂", no2 ?? localOf(r, "NO2_OMI"), 2, "×10¹⁵", true, no2 != null ? "TROPOMI, site minus surroundings" : "OMI 20-yr record, site minus surroundings") +
    (num(r.WS10M) != null ? `<span class="tl-chip wind" title="NASA POWER (MERRA-2) wind${phase === "projected" ? ", recent climatology" : ""}"><span class="arrow" style="transform:rotate(${num(r.PlumeTowardDeg)}deg)">↑</span> ${(+r.WS10M).toFixed(1)} m/s</span>` : "") +
    (num(r.T2M) != null ? `<span class="tl-chip muted" title="NASA POWER regional air temperature">Air ${(+r.T2M).toFixed(1)} °C</span>` : "");
}

// ------------------------------------------------------------------ UI wiring
function setYear(y) { applyYear(Math.max(FIRST, Math.min(LAST, Math.round(y)))); }
function togglePlay() {
  T.playing = !T.playing; $("#tlPlay").textContent = T.playing ? "❚❚" : "▶";
  FX.orbit(T.playing);
  clearInterval(T.playTimer);
  if (T.playing) {
    if (T.year >= LAST) setYear(FIRST);
    T.playTimer = setInterval(() => { if (T.year >= LAST) return togglePlay(); setYear(T.year + 1); }, 900);
  }
}
function wireUi() {
  const s = $("#tlSlider");
  s.min = FIRST; s.max = LAST; s.value = T.year;
  const nowPct = ((lastObservedYear() - FIRST) / (LAST - FIRST)) * 100;
  $("#tlTrack").style.setProperty("--now", nowPct + "%");
  s.addEventListener("input", () => setYear(+s.value));
  $("#tlPlay").addEventListener("click", togglePlay);
  $("#tlRingVar").innerHTML = Object.entries(RING_VARS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  $("#tlRingVar").addEventListener("change", (e) => { T.ringVar = e.target.value; buildEffects(); });
  const lightBtn = $("#tlLight"), qBtn = $("#tlQuality");
  const paintLight = () => (lightBtn.textContent = FX.lightMode() === "night" ? "☾ Night" : "☀ Golden hour");
  const paintQ = () => (qBtn.textContent = FX.quality() === "high" ? "HQ" : "LQ");
  lightBtn.addEventListener("click", () => { FX.setLight(FX.lightMode() === "night" ? "golden" : "night", T.year); paintLight(); });
  qBtn.addEventListener("click", () => { FX.setQuality(FX.quality() === "high" ? "low" : "high"); paintQ(); });
  paintLight(); paintQ();
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target !== s) return;
    if (!$("#tourCard").hidden) return;
    if (e.key === "[") setYear(T.year - 1);
    if (e.key === "]") setYear(T.year + 1);
  });
}

async function init(cs) {
  CS = cs; viewer = cs.viewer;
  FX.init(viewer);
  FLOW = attachFlow(viewer);
  window.addEventListener("cs:wind", (e) => {
    const w = e.detail; if (!w || w.siteId !== T.site?.id) return;
    T.target.windDir = w.towardDeg; T.target.windSpeed = w.speed; T._updateWindVec?.();
  });
  if (new URLSearchParams(location.search).get("light") === "night") FX.setLight("night");
  try { hlsTimeline = await (await fetch("data/hls_timeline.json")).json(); } catch { hlsTimeline = {}; }
  const q = new URLSearchParams(location.search);
  if (q.get("year")) T.year = +q.get("year");
  wireUi();
  window.addEventListener("cs:site", async (e) => {
    const { site, fly } = e.detail || {};
    if (!site) return;
    await loadSite(site);
    if (fly) cs.flyTo(site.lat, site.lon, 21, -40, 20, 2.5);
  });
  if (cs.state.site) {
    await loadSite(cs.state.site);
    if (!q.get("tour") && !q.get("embed")) cs.flyTo(cs.state.site.lat, cs.state.site.lon, 21, -40, 20, 0.1);
  }
  window.CloudShadowTimeline = { setYear, get year() { return T.year; }, togglePlay };
  if (q.get("debug")) setTimeout(() => {
    const shown = T.ring.filter((b) => b.show);
    console.log("CSDEBUG ring", T.ring.length, "shown", shown.length, "h", shown.slice(0, 3).map((b) => b._csH | 0).join("/"),
      "entities", viewer.entities.values.length, "prims", viewer.scene.primitives.length, "plumeRate", T.plume?.emissionRate,
      "globeTiles", viewer.scene.globe.tilesLoaded, "hdr", viewer.scene.highDynamicRange);
  }, 8000);
  window.addEventListener("error", (e) => console.log("CSDEBUG error", e.message));
}

if (window.CloudShadow) init(window.CloudShadow);
else window.addEventListener("cs:ready", (e) => init(e.detail), { once: true });
