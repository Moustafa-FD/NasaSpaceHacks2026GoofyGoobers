// Cloud Shadow - cinematic environment effects for the timeline (CesiumJS).
//
// Everything visual that isn't "the data itself" lives here so it can be tuned freely:
//   lighting (sun, golden hour / night, shadows), HDR + bloom, VIIRS night lights,
//   volumetric clouds + rain (NASA POWER wind & precipitation), subtle weather wisps,
//   atmosphere tint (regional air-temperature anomaly), illustrative server-hall massing,
//   year-change pulse, cinematic orbit, quality toggle.
// Data-driven effects take their inputs from the timeline row; they are VISUALIZATIONS,
// the numbers in the HUD/panel are the measurements.

import { attachFluid } from "./fluid-gpu.js";
import { getMotionSpeed } from "./motion.js";
import { AdaptiveQuality } from "./adaptive-quality.js";
import { globeSmokePolicy } from "./smoke-policy.js";

let viewer, scene, Q = "high";
let automaticQuality = true, qualityController, sampledFps = null;
const S = { site: null, rows: null, light: "golden", nightLights: null, clouds: null, cloudList: [], rain: null,
  massing: [], orbit: null, fluid: null, windDir: 0, windSpeed: 3, precip: 0, heat: 0, meanT2M: null, preRender: null,
  localScene: false, year: 2025, lastTick: 0, animationTime: 0, lastRow: null, phase: "observed" };
const QUALITY = {
  high: { hdr: true, bloom: true, shadows: true, clouds: 14, rainRate: 380, fluidTexEvery: 1, resolution: 1, shadowSize: 2048 },
  balanced: { hdr: false, bloom: false, shadows: true, clouds: 8, rainRate: 220, fluidTexEvery: 2, resolution: 0.85, shadowSize: 1024 },
  low: { hdr: false, bloom: false, shadows: false, clouds: 3, rainRate: 90, fluidTexEvery: 3, resolution: 0.65, shadowSize: 1024 },
};

const enuAt = (lat, lon, h = 0) => Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, h));
function streak() {
  const c = document.createElement("canvas"); c.width = 8; c.height = 64;
  const g = c.getContext("2d"), grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, "rgba(200,225,255,0)"); grd.addColorStop(1, "rgba(200,225,255,0.9)");
  g.fillStyle = grd; g.fillRect(3, 0, 2, 64); return c;
}
const RAIN = streak();

// ------------------------------------------------------------------ global scene look
export function init(v) {
  viewer = v; scene = v.scene;
  let mode = "auto";
  try { mode = localStorage.getItem("csQualityMode") || "auto"; } catch { /* Auto is the default. */ }
  const qp = new URLSearchParams(location.search).get("quality");
  if (["auto", "low", "high"].includes(qp)) mode = qp;
  automaticQuality = !["low", "high"].includes(mode); Q = mode === "low" ? "low" : "high";
  scene.globe.enableLighting = true;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.globe.dynamicAtmosphereLightingFromSun = true;
  scene.globe.atmosphereLightIntensity = 12;
  scene.skyAtmosphere.show = true;
  scene.fog.enabled = true; scene.fog.density = 1.6e-4;
  scene.postProcessStages.fxaa.enabled = true;
  const bloom = scene.postProcessStages.bloom;
  bloom.uniforms.glowOnly = false; bloom.uniforms.contrast = 128; bloom.uniforms.brightness = -0.32;
  bloom.uniforms.delta = 1.0; bloom.uniforms.sigma = 3.2; bloom.uniforms.stepSize = 1.0;
  viewer.shadowMap.softShadows = true; viewer.shadowMap.darkness = 0.45; viewer.shadowMap.size = 2048;
  viewer.terrainShadows = Cesium.ShadowMode.RECEIVE_ONLY;
  applyMotionSpeed(); // Particle systems advance on this shared, controllable clock.
  window.addEventListener("cs:motion-speed", applyMotionSpeed);

  // NASA VIIRS Black Marble: city lights that only show on the night side of the globe
  const gibs = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png";
  S.nightLights = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: gibs, maximumLevel: 8, credit: "NASA VIIRS Black Marble" }), 1);
  S.nightLights.dayAlpha = 0.0; S.nightLights.nightAlpha = 1.0; S.nightLights.brightness = 1.6;

  applyQuality();
  scene.preRender.addEventListener(tick);
  qualityController = new AdaptiveQuality({ quality: Q, now: performance.now(),
    onSample: ({ fps }) => { sampledFps = fps; },
    onChange: ({ quality: next, fps }) => { if (!automaticQuality) return; Q = next; sampledFps = fps; applyQuality(); },
  });
  scene.postRender.addEventListener(() => qualityController.sample(performance.now(), automaticQuality && document.visibilityState === "visible" && getMotionSpeed() > 0 && !window.CloudShadowNeighborhood?.pending));
  window.addEventListener("cs:site", () => qualityController.reset(performance.now()));
  document.addEventListener("visibilitychange", () => qualityController.reset(performance.now()));
}

function applyMotionSpeed() {
  if (!viewer) return;
  const speed = getMotionSpeed();
  viewer.clock.multiplier = speed;
  viewer.clock.shouldAnimate = speed > 0;
  S.lastTick = performance.now();
}
function applySceneVisibility() {
  const visible = !S.localScene;
  for (const object of [S.clouds, S.rain]) if (object) object.show = visible;
  for (const block of S.massing) block.show = visible && S.year >= block._startYear;
  S.fluid?.setVisible(visible);
}
window.addEventListener("cs:scene-mode", (event) => {
  S.localScene = !!event.detail?.active;
  applySceneVisibility();
  if (viewer) applyQuality();
  qualityController?.reset(performance.now());
  // Preserve the camera's close-up target when a playing timeline changes scene mode.
  if (S.orbit && viewer) orbit(true);
});

export function setQuality(q) {
  if (!["auto", "high", "balanced", "low"].includes(q)) return;
  automaticQuality = q === "auto";
  if (!automaticQuality) Q = q;
  try { localStorage.setItem("csQualityMode", automaticQuality ? "auto" : Q); } catch { /* Storage is optional. */ }
  qualityController?.setQuality(Q, performance.now());
  applyQuality();
}
export const quality = () => Q;
export const getQualityLabel = () => `${automaticQuality ? "Auto · " : ""}${({ high: "High", balanced: "Medium", low: "Low" })[Q]}`;
export function cycleQuality() { setQuality(automaticQuality ? "high" : Q === "high" ? "low" : "auto"); }
function applyQuality() {
  const qq = QUALITY[Q];
  scene.highDynamicRange = !S.localScene && qq.hdr && scene.highDynamicRangeSupported;
  scene.postProcessStages.bloom.enabled = !S.localScene && qq.bloom;
  viewer.shadows = qq.shadows;
  viewer.resolutionScale = qq.resolution;
  viewer.shadowMap.size = qq.shadowSize;
  viewer.shadowMap.softShadows = Q === "high";
  for (let i = 0; i < S.cloudList.length; i++) S.cloudList[i].c.show = i < qq.clouds;
  if (S.lastRow) applyParticleBudget(S.lastRow, S.phase);
  window.dispatchEvent(new CustomEvent("cs:quality", { detail: { quality: Q, automatic: automaticQuality, fps: sampledFps } }));
}

// Sun position: golden hour (low sun, long shadows) or night, on July 1 of `year`, local solar time
export function setLight(mode, year = 2025) {
  S.light = mode;
  if (!S.site) return;
  const localHour = mode === "night" ? 23.5 : 18.6;
  const utc = localHour - S.site.lon / 15;
  const d = new Date(Date.UTC(year, 6, 1, 0, 0, 0) + utc * 3600e3);
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(d);
  scene.globe.atmosphereLightIntensity = mode === "night" ? 6 : 12;
  S.nightLights.alpha = 1;
}
export const lightMode = () => S.light;

// ------------------------------------------------------------------ per-site effects
function clearSite() {
  for (const p of [S.clouds, S.rain]) if (p) scene.primitives.remove(p);
  for (const e of S.massing) viewer.entities.remove(e);
  S.fluid?.dispose();
  S.clouds = S.rain = S.fluid = null; S.cloudList = []; S.massing = [];
}

export function buildSite(site, rows) {
  clearSite();
  S.site = site; S.rows = rows;
  const { lat, lon } = site, qq = QUALITY[Q];
  const t2m = [...rows.values()].filter((r) => r.Phase !== "projected" && r.T2M != null).map((r) => +r.T2M);
  S.meanT2M = t2m.length ? t2m.reduce((a, b) => a + b, 0) / t2m.length : null;

  // volumetric clouds drifting with the wind
  S.clouds = scene.primitives.add(new Cesium.CloudCollection({ noiseDetail: 16.0 }));
  for (let i = 0; i < QUALITY.high.clouds; i++) {
    const e = (Math.random() - 0.5) * 40000, n = (Math.random() - 0.5) * 40000, h = 2200 + Math.random() * 1400;
    const c = S.clouds.add({
      position: Cesium.Matrix4.multiplyByPoint(enuAt(lat, lon), new Cesium.Cartesian3(e, n, h), new Cesium.Cartesian3()),
      scale: new Cesium.Cartesian2(2600 + Math.random() * 2600, 900 + Math.random() * 700),
      maximumSize: new Cesium.Cartesian3(50, 16, 14), slice: 0.33 + Math.random() * 0.1, brightness: 1.0,
    });
    c.show = i < qq.clouds;
    S.cloudList.push({ c, e, n, h });
  }

  // rain (shown when that year's precipitation is above the site's typical level)
  const enu = enuAt(lat, lon), wind = new Cesium.Cartesian3();
  S.rain = scene.primitives.add(new Cesium.ParticleSystem({
    image: RAIN, startColor: Cesium.Color.fromCssColorString("#d8ecff").withAlpha(0.32), endColor: Cesium.Color.fromCssColorString("#d8ecff").withAlpha(0.08),
    imageSize: new Cesium.Cartesian2(5, 140), sizeInMeters: true, minimumParticleLife: 2.2, maximumParticleLife: 2.8,
    minimumSpeed: 35, maximumSpeed: 50, emissionRate: 0, lifetime: 16,
    emitter: new Cesium.BoxEmitter(new Cesium.Cartesian3(22000, 22000, 800)), modelMatrix: enuAt(lat, lon, 1500),
    updateCallback: (p) => {
      const th = Cesium.Math.toRadians(S.windDir), sp = S.windSpeed * 4;
      Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(Math.sin(th) * sp, Math.cos(th) * sp, -45), wind);
      Cesium.Cartesian3.clone(wind, p.velocity);
    },
  }));

  // illustrative server-hall massing: blocks rise after the site's start year
  const onset = +String(site.onset).slice(0, 4);
  const count = site.id === "ashburn" ? 16 : 6;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + (i % 2) * 0.4, rad = (site.id === "ashburn" ? 1700 : 650) * (0.35 + ((i * 37) % 10) / 14);
    const pos = Cesium.Matrix4.multiplyByPoint(enuAt(lat, lon), new Cesium.Cartesian3(Math.cos(ang) * rad, Math.sin(ang) * rad, 0), new Cesium.Cartesian3());
    const carto = Cesium.Cartographic.fromCartesian(pos);
    const startYear = site.id === "ashburn" ? onset - 4 + Math.round((i / count) * 16) : onset + (i % 3 === 0 ? 1 : 0);
    const st = { h: 1, target: 0 };
    const block = viewer.entities.add({
      position: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0),
      orientation: Cesium.Transforms.headingPitchRollQuaternion(pos, new Cesium.HeadingPitchRoll(ang, 0, 0)),
      box: {
        dimensions: new Cesium.CallbackProperty(() => new Cesium.Cartesian3(320, 140, Math.max(1, st.h)), false),
        material: Cesium.Color.fromCssColorString("#dfe7f2").withAlpha(0.92), outline: true, outlineColor: Cesium.Color.fromCssColorString("#9fe8ff"),
        shadows: Cesium.ShadowMode.ENABLED, heightReference: Cesium.HeightReference.NONE,
      },
      show: false,
    });
    block._startYear = startYear; block._st = st;
    S.massing.push(block);
  }
  // Qualitative blue-gray wind wisps; only documented combustion gets a source.
  if (new URLSearchParams(location.search).get("fluid") !== "off") S.fluid = attachFluid(viewer, site, { texEvery: QUALITY[Q].fluidTexEvery });
  setLight(S.light);
  applySceneVisibility();
}

// ------------------------------------------------------------------ real wind (GEOS-FP, from flowfield.js)
// Time-varying analysed wind at the site replaces the single annual POWER arrow for clouds + fluid.
window.addEventListener("cs:wind", (e) => {
  const w = e.detail; if (!w || !S.site || w.siteId !== S.site.id) return;
  S.windDir = w.towardDeg; S.windSpeed = w.speed;
  S.fluid?.setWind?.(w.towardDeg, w.speed);
});

// ------------------------------------------------------------------ per-year update
export function applyYear(year, row, phase) {
  S.year = year; S.lastRow = row; S.phase = phase;
  const num = (v) => (v == null || v === "" ? null : +v);
  const projected = phase === "projected";
  if (num(row.PlumeTowardDeg) != null) S.windDir = num(row.PlumeTowardDeg);
  if (num(row.WS10M) != null) S.windSpeed = num(row.WS10M);
  // rain: wetter-than-usual years rain harder
  const pr = num(row.PrecipMMDay);
  if (S.rain) S.rain.emissionRate = pr == null ? 0 : Math.max(0, pr - 2.6) * QUALITY[Q].rainRate * (projected ? 0.5 : 1);
  // atmosphere tint from regional air-temperature anomaly
  const t = num(row.T2M);
  if (t != null && S.meanT2M != null) {
    const a = t - S.meanT2M;
    scene.skyAtmosphere.hueShift = Cesium.Math.clamp(-a * 0.035, -0.1, 0.1);
    scene.skyAtmosphere.saturationShift = Cesium.Math.clamp(a * 0.1, -0.2, 0.35);
    scene.skyAtmosphere.brightnessShift = projected ? -0.1 : 0;
  }
  // massing blocks: rise after their start year (ghosted in the future)
  for (const b of S.massing) {
    b.show = !S.localScene && year >= b._startYear;
    b._st.target = year >= b._startYear ? 28 + Math.min(3, year - b._startYear) * 8 : 1;
    b.box.material = projected ? Cesium.Color.fromCssColorString("#9fe8ff").withAlpha(0.35) : Cesium.Color.fromCssColorString("#dfe7f2").withAlpha(0.92);
  }
  // fluid weather field
  if (S.fluid) {
    const policy = globeSmokePolicy(S.site, year, row, phase);
    S.fluid.setWeather({
      windTowardDeg: policy.windTowardDeg, windSpeed: policy.windSpeedMs,
      heat: policy.heat, pollution: policy.fluidPollution, moisture: policy.moisture,
      projected,
    });
  }
  // sun follows the year (same date & hour each year → consistent look)
  setLight(S.light, Math.min(year, 2026));
  pulse();
  applySceneVisibility();
}

function applyParticleBudget(row, phase) {
  const qq = QUALITY[Q], projected = phase === "projected";
  const pr = row.PrecipMMDay == null || row.PrecipMMDay === "" ? null : +row.PrecipMMDay;
  if (S.rain) S.rain.emissionRate = pr == null ? 0 : Math.max(0, pr - 2.6) * qq.rainRate * (projected ? 0.5 : 1);
}

// ------------------------------------------------------------------ animation
let pulseT = 0;
function pulse() { pulseT = S.animationTime; }
function tick() {
  const now = performance.now();
  const speed = getMotionSpeed();
  const dt = Math.min(0.05, Math.max(0, (now - (S.lastTick || now)) / 1000)) * speed;
  S.lastTick = now;
  if (dt === 0) return;
  S.animationTime += dt;
  // bloom pulse on year change
  const k = Math.max(0, 1 - (S.animationTime - pulseT) / 0.45);
  scene.postProcessStages.bloom.uniforms.brightness = -0.32 + 0.22 * k;
  // massing growth easing
  if (!S.localScene) for (const b of S.massing) b._st.h += (b._st.target - b._st.h) * (1 - Math.exp(-3.6 * dt));
  // clouds drift with the wind (time-lapse), wrapping around the site
  if (!S.localScene && S.site && S.cloudList.length) {
    const th = Cesium.Math.toRadians(S.windDir), sp = S.windSpeed * 2;
    const enu = enuAt(S.site.lat, S.site.lon);
    for (const cl of S.cloudList) {
      cl.e += Math.sin(th) * sp * dt; cl.n += Math.cos(th) * sp * dt;
      if (Math.abs(cl.e) > 22000) cl.e = -Math.sign(cl.e) * 22000;
      if (Math.abs(cl.n) > 22000) cl.n = -Math.sign(cl.n) * 22000;
      cl.c.position = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(cl.e, cl.n, cl.h), new Cesium.Cartesian3());
    }
  }
  // cinematic orbit
  if (S.orbit) {
    S.orbit.heading += 0.055 * dt;
    viewer.camera.lookAt(S.orbit.center, new Cesium.HeadingPitchRange(S.orbit.heading, S.orbit.pitch, S.orbit.range));
  }
}

export function orbit(on) {
  if (on && S.site) {
    let center = Cesium.Cartesian3.fromDegrees(S.site.lon, S.site.lat, 0), range = 19000, pitch = Cesium.Math.toRadians(-32);
    if (S.localScene) {
      const screenCenter = new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2);
      const ray = viewer.camera.getPickRay(screenCenter);
      const target = ray && scene.globe.pick(ray, scene) || viewer.camera.pickEllipsoid(screenCenter, scene.globe.ellipsoid);
      if (target) center = target;
      range = Cesium.Cartesian3.distance(viewer.camera.positionWC, center);
      pitch = Math.min(-0.05, viewer.camera.pitch);
    }
    S.orbit = { center, heading: viewer.camera.heading, pitch, range };
  } else if (S.orbit) {
    S.orbit = null;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
}
