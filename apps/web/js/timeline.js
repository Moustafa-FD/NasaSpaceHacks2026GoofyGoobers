// Cloud Shadow - timeline slider: past → present → future, in 3D.
//
// Dragging the slider changes, for the selected site:
//   1. the ground      - real cloud-free NASA HLS 30 m image for that year (cross-faded)
//   2. the heat value  - numerical HUD and trend strip, never floating fire/domes
//   3. the trend strip - annual local signal in the timeline; projected values are dashed
//   4. the wind field  - one GEOS-FP analysis trail layer and one wind readout
//   6. the data layer  - the NASA overlay picked in the top bar follows the year
// Site trend rows end in2035. Later selections request climate-period summaries,
// with no invented annual pollution, NDVI, weather or historical imagery.
//
// Data: data/hls_timeline.json, data/unreal/timeline/<site>.json (rows), produced by scripts/*.
// Hooks into app.js through window.CloudShadow + "cs:ready" / "cs:site" events.

import * as FX from "./fx.js";
import { attachFlow, resolveWindReadout } from "./flowfield.js";
import { getMotionSpeed, setMotionSpeed } from "./motion.js";

const FIRST = 2003, LAST = 2100, LAST_SITE = 2035;
const TREND_VARS = { LST_Night: "Night heat", NDVI: "Vegetation", NO2_OMI: "NO₂", LST_Day: "Day heat", AOD: "Particles" };
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + (+v).toFixed(d));

let CS, viewer, FLOW, hlsTimeline = {};
const T = {
  site: null, rows: new Map(), meta: null, year: 2025, ringVar: "LST_Night",
  layers: [], playing: false, playTimer: null, localScene: false, siteLoad: 0, mapBusy:false,
  plume: null, wind: null,
  analysedWind:null,
  target: { windDir: 0, windSpeed: 0 },
};

// ------------------------------------------------------------------ helpers
const rowFor = (y) => y>LAST_SITE?{}:T.rows.get(y) || {};
const num = (v) => (v == null || v === "" ? null : +v);
const localOf = (row, v) => num(row[`${v}_Local`]);
const phaseOf = (y) => y>LAST_SITE?'climate':rowFor(y).Phase || (y > lastObservedYear() ? "projected" : "observed");
const lastObservedYear = () => T.meta?.lastObservedYear ?? 2026;

function enuAt(lat, lon, h = 0) { return Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, h)); }

// ------------------------------------------------------------------ data
async function loadSite(site) {
  const loadId = ++T.siteLoad;
  T.site = site; T.rows.clear(); T.meta = null;
  clearGround();
  T.analysedWind=null;FLOW?.reset(site,T.year);
  try {
    const d = await (await fetch(`data/unreal/timeline/${site.id}.json`)).json();
    if (loadId !== T.siteLoad) return;
    T.meta = d; for (const r of d.rows) T.rows.set(+r.Year, r);
  } catch (e) { console.warn("timeline data missing for", site.id, e); }
  if (loadId !== T.siteLoad) return;
  const selectedMap=CS.getMapLayer?.();
  T.ringVar = TREND_VARS[selectedMap]?selectedMap:site.effects?.ringVar || "LST_Night";
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
// HLS scenes contain orbital swaths far beyond the case study. This is a small
// display window, not an assertion that every pixel inside it is cloud-free.
function groundBounds(site){return [site.lon-.2,Math.max(-85,site.lat-.15),site.lon+.2,Math.min(85,site.lat+.15)];}
function groundVisibility(height){
  if(!Number.isFinite(height))return 0;
  const t=Math.max(0,Math.min(1,(height-80000)/40000));return 1-t*t*(3-2*t);
}
function syncGroundVisibility(){
  const visibility=groundVisibility(viewer?.camera.positionCartographic.height);
  for(const layer of T.layers){
    layer.alpha=(layer._csFade??1)*visibility;
    layer.show=layer.alpha>.001;
  }
}
function clearGround(){
  for(const layer of T.layers)if(viewer?.imageryLayers.contains(layer))viewer.imageryLayers.remove(layer,true);
  T.layers=[];
}
function setGround(year) {
  const im = imageryFor(year); if (!im) {clearGround();$('#tlImagery').textContent='Reference basemap · no HLS snapshot for this location';return;}
  const key = `${T.site.id}:${T.site.lat}:${T.site.lon}:${im.templateUrl}`;
  const top = T.layers[T.layers.length - 1];
  $('#tlImagery').textContent=`NASA HLS reference imagery · ${im.date}${im.shownYear!==year?' · not imagery from the selected year':''}`;
  if (top && top._csKey === key) {syncGroundVisibility();return;}
  const rectangle=Cesium.Rectangle.fromDegrees(...groundBounds(T.site));
  const layer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: im.templateUrl,rectangle,maximumLevel: 12, credit: "NASA HLS via GIBS",enablePickFeatures:false }), 1);
  layer._csKey = key; layer._csFade=0;layer.alpha = 0;layer.show=false;
  T.layers.push(layer);
  let last = performance.now(), elapsed = 0;
  const dur = 450;
  const step = (t) => {
    if (!viewer.imageryLayers.contains(layer)) return;
    const speed = getMotionSpeed();
    elapsed += Math.min(100, t - last) * speed; last = t;
    // Manual scrubbing remains responsive when environmental motion is paused.
    const k = speed === 0 ? 1 : Math.min(1, elapsed / dur);
    layer._csFade = k;
    for (const old of T.layers) if (old !== layer) old._csFade = Math.min(old._csFade??1, 1 - k);
    syncGroundVisibility();
    if (k < 1) requestAnimationFrame(step);
    else for (const old of T.layers.splice(0, T.layers.length - 1)) viewer.imageryLayers.remove(old, true);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ 2–5. 3D effects
function clearEffects() {
  for (const ps of [T.plume, T.wind]) if (ps) viewer.scene.primitives.remove(ps);
  T.plume = T.wind = null;
}

function buildEffects() {
  clearEffects();
  // GEOS-FP owns the only globe wind trails. No duplicate annual-mean streaks,
  // giant site plume, heat dome or invented building-massing animation.
  T.analysedWind=null;
  FX.buildSite(T.site, T.rows);
  applyYear(T.year, { instant: true });
}

// ------------------------------------------------------------------ apply a year
function applyYear(year, { instant = false } = {}) {
  if(T.year!==year)T.analysedWind=null;
  T.year = year;
  const r = rowFor(year), phase = phaseOf(year), projected = phase === "projected";
  // wind
  const wd = num(r.PlumeTowardDeg), ws = num(r.WS10M);
  if (wd != null) T.target.windDir = wd;
  T.target.windSpeed = wd != null && ws != null ? Math.max(0,ws) : 0;
  T._updateWindVec?.();
  setGround(year);
  FX.applyYear(year, r, phase);
  FLOW?.setYear(T.site, year, phase);
  // The app's cs:year listener owns scientific maps; avoid duplicate yearly loads.
  renderHud(year, r, phase);
  renderTrendStrip();
  applySceneVisibility();
  const ndvi = num(r.NDVI_Site);
  const health = phase==='climate'?1:ndvi != null && Number.isFinite(ndvi) ? Math.max(0.05, Math.min(1, (ndvi - 0.1) / 0.45)) : null;
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
  const yearAt = (event) => Math.max(FIRST, Math.min(LAST_SITE, Math.round(FIRST + ((event.clientX - canvas.getBoundingClientRect().left - 8) / Math.max(1, canvas.getBoundingClientRect().width - 16)) * (LAST_SITE - FIRST))));
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
  const points = Array.from({ length: LAST_SITE - FIRST + 1 }, (_, i) => {
    const year = FIRST + i, row = rowFor(year);
    return { year, value: localOf(row, T.ringVar), lo: num(row[`${T.ringVar}_LocalLo`]), hi: num(row[`${T.ringVar}_LocalHi`]), projected: phaseOf(year) === "projected" };
  });
  const values = points.flatMap((p) => [p.value, p.lo, p.hi]).filter(Number.isFinite);
  const valueText = T.year>LAST_SITE?`${T.year} · climate period, no annual site signal`:`${T.year} · ${fmt(current, v.digits)}${v.unit ? " " + v.unit : ""}`;
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
  const x = (year) => 8 + ((year - FIRST) / (LAST_SITE - FIRST)) * (w - 16);
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
  if(T.year<=LAST_SITE){g.beginPath(); g.moveTo(x(T.year), 0); g.lineTo(x(T.year), h); g.stroke();}
  if (Number.isFinite(current)) { g.fillStyle = "#e4fff5"; g.beginPath(); g.arc(x(T.year), y(current), 2.8, 0, Math.PI * 2); g.fill(); }
}

// ------------------------------------------------------------------ HUD
function chip(label, v, digits, unit, worseIfPositive, note = "") {
  if (v == null) return `<span class="tl-chip muted">${label} –</span>`;
  const worse = (v > 0) === worseIfPositive;
  return `<span class="tl-chip ${worse ? "bad" : "good"}" title="${note}">${label} <b>${fmt(v, digits)}</b>${unit ? " " + unit : ""}</span>`;
}
function windMarkup(row,phase){
  const wind=resolveWindReadout(row,phase,T.analysedWind);
  if(!wind)return '<span id="tlWind" class="tl-chip muted">Wind unavailable</span>';
  const time=typeof wind.time==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(wind.time)?` · ${wind.time.slice(0,16).replace('T',' ')}Z`:'';
  return `<span id="tlWind" class="tl-chip wind" title="${wind.title}"><span class="arrow" style="transform:rotate(${wind.towardDeg.toFixed(1)}deg)">↑</span> ${wind.label} · ${wind.speed.toFixed(1)} m/s${time}</span>`;
}
function renderWind(){const element=$('#tlWind');if(element)element.outerHTML=windMarkup(rowFor(T.year),phaseOf(T.year));}
function renderHud(year, r, phase) {
  $("#tlYear").textContent = year;
  $("#tlSlider").value = year;
  const badge = $("#tlPhase");
  badge.textContent = phase==='climate'?'CLIMATE SCENARIO · PERIOD SUMMARY':phase === "projected" ? "PROJECTED · IF THE TREND CONTINUES" : phase === "present" ? "NOW" : "OBSERVED";
  badge.className = "tl-phase " + phase;
  document.body.classList.toggle("tl-future", phase === "projected");
  $('#tlSlider').setAttribute('aria-valuetext',`${year}${phase==='climate'?', climate scenario period summary; annual site signals unavailable':''}`);
  const no2 = localOf(r, "NO2") ?? null;
  $("#tlChips").innerHTML =
    chip("Night heat", localOf(r, "LST_Night"), 2, "°C", true, "Site minus surroundings, MODIS night land-surface temperature") +
    chip("Greenness", localOf(r, "NDVI"), 3, "", false, "Site minus surroundings, MODIS NDVI") +
    chip("NO₂", no2 ?? localOf(r, "NO2_OMI"), 2, "×10¹⁵", true, no2 != null ? "TROPOMI, site minus surroundings" : "OMI 20-yr record, site minus surroundings") +
    windMarkup(r,phase) +
    (num(r.T2M) != null ? `<span class="tl-chip muted" title="${phase==='projected'?'Illustrative projected air temperature; not a NASA observation':'NASA POWER annual regional air temperature'}">Air ${(+r.T2M).toFixed(1)} °C</span>` : "");
}

// ------------------------------------------------------------------ UI wiring
function setYear(y) { applyYear(Math.max(FIRST, Math.min(LAST, Math.round(y)))); }
function schedulePlayback() {
  clearTimeout(T.playTimer); T.playTimer = null;
  const speed = getMotionSpeed();
  if (!T.playing || speed === 0) return;
  T.playTimer = setTimeout(() => {
    if (!T.playing || getMotionSpeed() === 0) return;
    if (T.mapBusy) { schedulePlayback(); return; }
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
  // Playback changes time, not the user's study-area camera or close-up mode.
  paintPlayback(); FX.orbit(false); schedulePlayback();
}
function wireUi() {
  const s = $("#tlSlider");
  s.min = FIRST; s.max = LAST; s.value = T.year;
  const futureZone=document.querySelector('.tl-zones span:last-child');if(futureZone)futureZone.textContent='Future · climate periods after 2035';
  const tint=$('#tlFutureTint');if(tint)tint.hidden=true;
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
  window.addEventListener('cs:map-state',({detail})=>{
    T.mapBusy=['loading','transitioning'].includes(detail?.state);
    $('#tlPlay').dataset.waiting=String(T.mapBusy);
    $('#tlPlay').title=T.playing&&T.mapBusy?'Waiting for the dated map to finish loading and blending':T.playing?'Pause timeline':'Play through the years';
  });
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
  viewer.scene.preRender.addEventListener(syncGroundVisibility);
  FLOW = attachFlow(viewer,{quality:FX.quality()});
  window.addEventListener("cs:wind", (e) => {
    const w = e.detail; if (!w || w.siteId !== T.site?.id || w.year!==T.year || phaseOf(T.year)==='projected') return;
    T.analysedWind=w;
    T.target.windDir = w.towardDeg; T.target.windSpeed = w.speed;
    renderWind();
  });
  window.addEventListener('cs:wind-state',({detail})=>{
    if(detail?.siteId!==T.site?.id||detail.year!==T.year||detail.active)return;
    T.analysedWind=null;renderWind();
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
