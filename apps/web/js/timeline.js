// Cloud Shadow - timeline slider: past → present → future, in 3D.
//
// Dragging the slider changes, for the selected site:
//   1. the ground      - real cloud-free NASA HLS 30 m image for that year (cross-faded)
//   2. the heat value  - numerical HUD and trend strip, never floating fire/domes
//   3. the trend strip - annual local signal in the timeline; projected values are dashed
//   4. the plume       - subtle illustrative wisps for documented combustion only
//   5. the wind field  - streaks drifting with that year's wind (speed/direction)
//   6. the data layer  - the NASA overlay picked in the top bar follows the year
// Future years (Phase = projected) get a "projection" grade + badge: they extend the measured trend, not a forecast.
//
// Data: data/hls_timeline.json, data/unreal/timeline/<site>.json (rows), produced by scripts/*.
// Hooks into app.js through window.CloudShadow + "cs:ready" / "cs:site" events.

import * as FX from "./fx.js";
import { attachFlow } from "./flowfield.js";
import { getMotionSpeed, setMotionSpeed } from "./motion.js";
import { createSmokeSprite, globeSmokePolicy, plumeParticleAlpha } from "./smoke-policy.js";

const FIRST = 2003, LAST = 2035;
const TREND_VARS = { LST_Night: "Night heat", NDVI: "Vegetation", NO2_OMI: "NO₂", LST_Day: "Day heat", AOD: "Particles" };
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + (+v).toFixed(d));

let CS, viewer, FLOW, hlsTimeline = {};
const T = {
  site: null, rows: new Map(), meta: null, year: 2025, ringVar: "LST_Night",
  layers: [], playing: false, playTimer: null, localScene: false, siteLoad: 0,
  plume: null, wind: null,
  target: { windDir: 0, windSpeed: 0 },
};

// ------------------------------------------------------------------ helpers
const rowFor = (y) => T.rows.get(y) || {};
const num = (v) => (v == null || v === "" ? null : +v);
const localOf = (row, v) => num(row[`${v}_Local`]);
const phaseOf = (y) => rowFor(y).Phase || (y > 2026 ? "projected" : "observed");
const lastObservedYear = () => T.meta?.lastObservedYear ?? 2026;

function enuAt(lat, lon, h = 0) { return Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, h)); }
const SMOKE = createSmokeSprite(64);

// ------------------------------------------------------------------ data
async function loadSite(site) {
  const loadId = ++T.siteLoad;
  T.site = site; T.rows.clear(); T.meta = null;
  try {
    const d = await (await fetch(`data/unreal/timeline/${site.id}.json`)).json();
    if (loadId !== T.siteLoad) return;
    T.meta = d; for (const r of d.rows) T.rows.set(+r.Year, r);
  } catch (e) { console.warn("timeline data missing for", site.id, e); }
  if (loadId !== T.siteLoad) return;
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
  let last = performance.now(), elapsed = 0;
  const dur = 450;
  const step = (t) => {
    if (!viewer.imageryLayers.contains(layer)) return;
    const speed = getMotionSpeed();
    elapsed += Math.min(100, t - last) * speed; last = t;
    // Manual scrubbing remains responsive when environmental motion is paused.
    const k = speed === 0 ? 1 : Math.min(1, elapsed / dur);
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
  for (const ps of [T.plume, T.wind]) if (ps) viewer.scene.primitives.remove(ps);
  T.plume = T.wind = null;
}

function buildEffects() {
  clearEffects();
  const { lat, lon } = T.site;
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

  // wind field: streaks drifting across the site at ~1.5 km
  const enu = enuAt(lat, lon, 0);
  const windVec = new Cesium.Cartesian3();
  const updateWindVec = () => {
    const th = Cesium.Math.toRadians(T.target.windDir), sp = T.target.windSpeed * 6; // Gentle visual time-lapse; clock applies the speed slider.
    Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(Math.sin(th) * sp, Math.cos(th) * sp, 0), windVec);
  };
  updateWindVec(); T._updateWindVec = updateWindVec;
  T.wind = viewer.scene.primitives.add(new Cesium.ParticleSystem({
    image: SMOKE, startColor: Cesium.Color.WHITE.withAlpha(0.0), endColor: Cesium.Color.WHITE.withAlpha(0.0),
    startScale: 1, endScale: 1, minimumParticleLife: 6, maximumParticleLife: 9, minimumSpeed: 0, maximumSpeed: 1,
    imageSize: new Cesium.Cartesian2(180, 60), sizeInMeters: true, emissionRate: 18, lifetime: 16,
    emitter: new Cesium.BoxEmitter(new Cesium.Cartesian3(26000, 26000, 1400)),
    modelMatrix: enuAt(lat, lon, 1500),
    updateCallback: (p, dt) => {
      Cesium.Cartesian3.clone(windVec, p.velocity);
      const k = p.age / p.life, a = Math.sin(Math.PI * k) * 0.055;
      p.color = Cesium.Color.fromAlpha(Cesium.Color.fromCssColorString("#b1c4ce"), a, p.color);
    },
  }));

  // turbine plume (only where on-site combustion is documented)
  if (T.site.effects?.plume) {
    const up = Cesium.Cartesian3.normalize(center, new Cesium.Cartesian3());
    T.plume = viewer.scene.primitives.add(new Cesium.ParticleSystem({
      image: SMOKE, startColor: Cesium.Color.fromCssColorString("#899fac").withAlpha(0.16), endColor: Cesium.Color.fromCssColorString("#b0bec5").withAlpha(0.0),
      startScale: 0.5, endScale: 2.2, minimumParticleLife: 8, maximumParticleLife: 14, minimumSpeed: 3, maximumSpeed: 6,
      imageSize: new Cesium.Cartesian2(120, 70), sizeInMeters: true, emissionRate: 0, lifetime: 16,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(18)),
      modelMatrix: enuAt(lat, lon, 40),
      updateCallback: (p, dt) => {
        // rise + drift with the (time-lapsed) NASA POWER wind
        const target = Cesium.Cartesian3.add(windVec, Cesium.Cartesian3.multiplyByScalar(up, 8, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        Cesium.Cartesian3.lerp(p.velocity, target, Math.min(1, dt * 0.6), p.velocity);
        p.color.alpha = plumeParticleAlpha(p.age, p.life);
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
  // wind
  const wd = num(r.PlumeTowardDeg), ws = num(r.WS10M);
  if (wd != null) T.target.windDir = wd;
  T.target.windSpeed = wd != null && ws != null ? Math.max(0,ws) : 0;
  T._updateWindVec?.();
  // A fixed, bounded artistic trace; NO2 columns do not measure visible smoke.
  if (T.plume) {
    T.plume.emissionRate = globeSmokePolicy(T.site,year,r,phase).particleRate;
  }
  setGround(year);
  FX.applyYear(year, r, phase);
  FLOW?.setYear(T.site, year, phase); // real GEOS-FP wind (2018+) overrides the annual POWER arrow via "cs:wind"
  // data overlay follows the year (if one is selected and has data that year)
  const kind = CS.getMapLayer?.();
  if (kind && VARS[kind]) CS.setMapLayer(kind, `${Math.min(year, lastObservedYear())}-07-15`);
  renderHud(year, r, phase);
  renderTrendStrip();
  applySceneVisibility();
  const ndvi = num(r.NDVI_Site);
  const health = ndvi != null && Number.isFinite(ndvi) ? Math.max(0.05, Math.min(1, (ndvi - 0.1) / 0.45)) : null;
  // An illustrative visual response to source greenness, not an ecological mortality or yield model.
  window.dispatchEvent(new CustomEvent("cs:year", { detail: { siteId: T.site?.id, year, phase, row: r, health } }));
}

function applySceneVisibility() {
  const show = !T.localScene;
  for (const object of [T.wind, T.plume]) if (object) object.show = show;
}
window.addEventListener("cs:scene-mode", (event) => {
  T.localScene = !!event.detail?.active;
  applySceneVisibility();
});

// A small screen-space annual chart keeps geographic height free of data encodings.
function mountTrendStrip() {
  const strip = document.createElement("div"); strip.id = "tlTrendMini";
  strip.innerHTML = '<div class="tl-trend-select"></div><canvas id="tlTrendCanvas" role="img" aria-label="Annual local signal"></canvas><span id="tlTrendValue"></span><span class="tl-trend-key"><i></i>Observed <i class="projected"></i>Trend extension</span>';
  const label = $("#tlRingVar").closest("label");
  if (label.firstChild?.nodeType === Node.TEXT_NODE) label.firstChild.textContent = "Trend ";
  label.title = "Annual signal: site minus surroundings. Dashed values extend the observed trend.";
  strip.querySelector(".tl-trend-select").appendChild(label);
  $("#tlTrack").before(strip);
  const canvas = $("#tlTrendCanvas");
  const yearAt = (event) => Math.max(FIRST, Math.min(LAST, Math.round(FIRST + ((event.clientX - canvas.getBoundingClientRect().left - 8) / Math.max(1, canvas.getBoundingClientRect().width - 16)) * (LAST - FIRST))));
  canvas.addEventListener("pointerdown", (event) => setYear(yearAt(event)));
  canvas.addEventListener("pointermove", (event) => {
    const year = yearAt(event), v = VARS[T.ringVar], value = localOf(rowFor(year), T.ringVar);
    canvas.title = `${year} · ${TREND_VARS[T.ringVar]}: ${fmt(value, v?.digits ?? 2)} ${v?.unit || ""} · ${phaseOf(year) === "projected" ? "trend extension" : "observed"}`;
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => renderTrendStrip()).observe(canvas);
}
function renderTrendStrip() {
  const canvas = $("#tlTrendCanvas"); if (!canvas) return;
  const v = VARS[T.ringVar] || { digits: 2, unit: "" }, current = localOf(rowFor(T.year), T.ringVar);
  const points = Array.from({ length: LAST - FIRST + 1 }, (_, i) => {
    const year = FIRST + i, row = rowFor(year);
    return { year, value: localOf(row, T.ringVar), lo: num(row[`${T.ringVar}_LocalLo`]), hi: num(row[`${T.ringVar}_LocalHi`]), projected: phaseOf(year) === "projected" };
  });
  const values = points.flatMap((p) => [p.value, p.lo, p.hi]).filter(Number.isFinite);
  const valueText = `${T.year} · ${fmt(current, v.digits)}${v.unit ? " " + v.unit : ""}`;
  $("#tlTrendValue").textContent = valueText;
  $("#tlTrendValue").title = `${TREND_VARS[T.ringVar]}: ${valueText}; site minus surroundings`;
  canvas.setAttribute("aria-label", `${TREND_VARS[T.ringVar]}, annual site minus surroundings. ${valueText}. Solid: observed; dashed: trend extension. Missing years remain gaps.`);
  const w = Math.max(120, Math.round(canvas.getBoundingClientRect().width)), h = 30;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  if (!values.length) { g.fillStyle = "#79949d"; g.font = "9px Inter,sans-serif"; g.fillText("No annual data", 8, 18); return; }
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const pad = (hi - lo || 1) * 0.1; lo -= pad; hi += pad;
  const x = (year) => 8 + ((year - FIRST) / (LAST - FIRST)) * (w - 16);
  const y = (value) => 3 + (1 - (value - lo) / (hi - lo)) * (h - 6);
  const futureX = Math.min(w, x(lastObservedYear() + 0.5));
  g.fillStyle = "#729eb510"; g.fillRect(futureX, 0, w - futureX, h);
  g.strokeStyle = "#718c9455"; g.lineWidth = 1; g.setLineDash([2, 3]);
  g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke(); g.setLineDash([]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b.projected && [a.lo, a.hi, b.lo, b.hi].every(Number.isFinite)) {
      g.fillStyle = "#8cb8d21a"; g.beginPath(); g.moveTo(x(a.year), y(a.lo)); g.lineTo(x(b.year), y(b.lo)); g.lineTo(x(b.year), y(b.hi)); g.lineTo(x(a.year), y(a.hi)); g.closePath(); g.fill();
    }
    if (![a.value, b.value].every(Number.isFinite)) continue;
    g.strokeStyle = b.projected ? "#8db9cd" : "#80d9c0"; g.lineWidth = 1.6; g.setLineDash(b.projected ? [3, 3] : []);
    g.beginPath(); g.moveTo(x(a.year), y(a.value)); g.lineTo(x(b.year), y(b.value)); g.stroke();
  }
  g.setLineDash([]); g.strokeStyle = "#dce9e655"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x(T.year), 0); g.lineTo(x(T.year), h); g.stroke();
  if (Number.isFinite(current)) { g.fillStyle = "#e4fff5"; g.beginPath(); g.arc(x(T.year), y(current), 2.8, 0, Math.PI * 2); g.fill(); }
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
function schedulePlayback() {
  clearTimeout(T.playTimer); T.playTimer = null;
  const speed = getMotionSpeed();
  if (!T.playing || speed === 0) return;
  T.playTimer = setTimeout(() => {
    if (!T.playing || getMotionSpeed() === 0) return;
    if (T.year >= LAST) { togglePlay(); return; }
    setYear(T.year + 1); schedulePlayback();
  }, 1500 / speed);
}
function paintPlayback() {
  const button = $("#tlPlay");
  button.textContent = T.playing ? "❚❚" : "▶";
  button.setAttribute("aria-label", T.playing ? "Pause timeline" : "Play timeline");
  button.title = T.playing && getMotionSpeed() === 0 ? "Timeline is waiting: increase motion speed to resume" : T.playing ? "Pause timeline" : "Play through the years";
}
function togglePlay() {
  T.playing = !T.playing;
  if (T.playing && T.year >= LAST) setYear(FIRST);
  paintPlayback(); FX.orbit(T.playing); schedulePlayback();
}
function wireUi() {
  const s = $("#tlSlider");
  s.min = FIRST; s.max = LAST; s.value = T.year;
  const nowPct = ((lastObservedYear() - FIRST) / (LAST - FIRST)) * 100;
  $("#tlTrack").style.setProperty("--now", nowPct + "%");
  s.addEventListener("input", () => setYear(+s.value));
  $("#tlPlay").addEventListener("click", togglePlay);
  const speedSlider = $("#motionSpeed"), speedOutput = $("#motionValue");
  const paintSpeed = () => {
    const speed = getMotionSpeed();
    speedSlider.value = speed; speedOutput.textContent = speed === 0 ? "Paused" : `${speed.toFixed(2).replace(/0$/, "")}×`;
    speedSlider.setAttribute("aria-valuetext", speed === 0 ? "All motion paused" : `${speed} times animation speed`);
    paintPlayback();
  };
  speedSlider.addEventListener("input", () => setMotionSpeed(+speedSlider.value));
  window.addEventListener("cs:motion-speed", () => { paintSpeed(); schedulePlayback(); });
  paintSpeed();
  $("#tlRingVar").innerHTML = Object.entries(TREND_VARS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  $("#tlRingVar").addEventListener("change", (e) => { T.ringVar = e.target.value; renderTrendStrip(); });
  mountTrendStrip();
  const lightBtn = $("#tlLight"), qBtn = $("#tlQuality");
  const paintLight = () => (lightBtn.textContent = FX.lightMode() === "night" ? "☾ Night" : "☀ Golden hour");
  const paintQ = () => {
    qBtn.textContent = FX.getQualityLabel();
    qBtn.title = "Graphics: Auto adapts to frame rate. Click to cycle Auto → High → Low → Auto.";
  };
  lightBtn.addEventListener("click", () => { FX.setLight(FX.lightMode() === "night" ? "golden" : "night", T.year); paintLight(); });
  qBtn.addEventListener("click", () => { FX.cycleQuality(); paintQ(); });
  window.addEventListener("cs:quality", paintQ);
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
    if (fly && T.site?.id === site.id && !T.localScene) cs.flyTo(site.lat, site.lon, 21, -40, 20, 2.5);
  });
  if (cs.state.site) {
    await loadSite(cs.state.site);
    if (!q.get("tour") && !q.get("embed") && q.get("view") !== "3d" && !T.localScene) cs.flyTo(cs.state.site.lat, cs.state.site.lon, 21, -40, 20, 0.1);
  }
  window.CloudShadowTimeline = { setYear, get year() { return T.year; }, togglePlay };
  if (q.get("debug")) setTimeout(() => {
    console.log("CSDEBUG trend", T.ringVar, "annualRows", T.rows.size,
      "entities", viewer.entities.values.length, "prims", viewer.scene.primitives.length, "plumeRate", T.plume?.emissionRate,
      "globeTiles", viewer.scene.globe.tilesLoaded, "hdr", viewer.scene.highDynamicRange);
  }, 8000);
  window.addEventListener("error", (e) => console.log("CSDEBUG error", e.message));
}

if (window.CloudShadow) init(window.CloudShadow);
else window.addEventListener("cs:ready", (e) => init(e.detail), { once: true });
