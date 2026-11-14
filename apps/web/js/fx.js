// Cloud Shadow - cinematic environment effects for the timeline (CesiumJS).
//
// Everything visual that isn't "the data itself" lives here so it can be tuned freely:
//   lighting (sun, golden hour / night, shadows), HDR + bloom, VIIRS night lights,
//   volumetric clouds + rain (NASA POWER wind & precipitation), heat embers (night-heat signal),
//   atmosphere tint (regional air-temperature anomaly), illustrative server-hall massing,
//   year-change pulse, cinematic orbit, quality toggle.
// Data-driven effects take their inputs from the timeline row; they are VISUALIZATIONS,
// the numbers in the HUD/panel are the measurements.

import { attachFluid } from "./fluid-gpu.js";

let viewer, scene, Q = "high";
const S = { site: null, rows: null, light: "golden", nightLights: null, clouds: null, cloudList: [], rain: null, embers: null,
  massing: [], orbit: null, fluid: null, windDir: 0, windSpeed: 3, precip: 0, heat: 0, meanT2M: null, preRender: null };
const QUALITY = {
  high: { hdr: true, bloom: true, shadows: true, clouds: 14, rainRate: 380, emberMax: 160, fluidTexEvery: 1 },
  low: { hdr: false, bloom: false, shadows: false, clouds: 6, rainRate: 150, emberMax: 60, fluidTexEvery: 2 },
};

const enuAt = (lat, lon, h = 0) => Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, h));
function dot(size, stops) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => grd.addColorStop(o, col)); g.fillStyle = grd; g.fillRect(0, 0, size, size); return c;
}
function streak() {
  const c = document.createElement("canvas"); c.width = 8; c.height = 64;
  const g = c.getContext("2d"), grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, "rgba(200,225,255,0)"); grd.addColorStop(1, "rgba(200,225,255,0.9)");
  g.fillStyle = grd; g.fillRect(3, 0, 2, 64); return c;
}
const EMBER = dot(32, [[0, "rgba(255,240,200,1)"], [0.35, "rgba(255,150,60,0.9)"], [1, "rgba(255,80,20,0)"]]);
const RAIN = streak();

// ------------------------------------------------------------------ global scene look
export function init(v) {
  viewer = v; scene = v.scene;
  try { Q = localStorage.getItem("csQuality") || "high"; } catch { Q = "high"; }
  const qp = new URLSearchParams(location.search).get("quality"); if (qp === "low" || qp === "high") Q = qp;
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
  viewer.clock.shouldAnimate = true;   // particle systems advance on the Cesium clock
  viewer.clock.multiplier = 1;

  // NASA VIIRS Black Marble: city lights that only show on the night side of the globe
  const gibs = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png";
  S.nightLights = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: gibs, maximumLevel: 8, credit: "NASA VIIRS Black Marble" }), 1);
  S.nightLights.dayAlpha = 0.0; S.nightLights.nightAlpha = 1.0; S.nightLights.brightness = 1.6;

  applyQuality();
  scene.preRender.addEventListener(tick);
}

export function setQuality(q) { Q = q; try { localStorage.setItem("csQuality", q); } catch {} applyQuality(); if (S.site) buildSite(S.site, S.rows); }
export const quality = () => Q;
function applyQuality() {
  const qq = QUALITY[Q];
  scene.highDynamicRange = qq.hdr && scene.highDynamicRangeSupported;
  scene.postProcessStages.bloom.enabled = qq.bloom;
  viewer.shadows = qq.shadows;
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
  for (const p of [S.clouds, S.rain, S.embers]) if (p) scene.primitives.remove(p);
  for (const e of S.massing) viewer.entities.remove(e);
  S.fluid?.dispose();
  S.clouds = S.rain = S.embers = S.fluid = null; S.cloudList = []; S.massing = [];
}

export function buildSite(site, rows) {
  clearSite();
  S.site = site; S.rows = rows;
  const { lat, lon } = site, qq = QUALITY[Q];
  const t2m = [...rows.values()].filter((r) => r.Phase !== "projected" && r.T2M != null).map((r) => +r.T2M);
  S.meanT2M = t2m.length ? t2m.reduce((a, b) => a + b, 0) / t2m.length : null;

  // volumetric clouds drifting with the wind
  S.clouds = scene.primitives.add(new Cesium.CloudCollection({ noiseDetail: 16.0 }));
  for (let i = 0; i < qq.clouds; i++) {
    const e = (Math.random() - 0.5) * 40000, n = (Math.random() - 0.5) * 40000, h = 2200 + Math.random() * 1400;
    const c = S.clouds.add({
      position: Cesium.Matrix4.multiplyByPoint(enuAt(lat, lon), new Cesium.Cartesian3(e, n, h), new Cesium.Cartesian3()),
      scale: new Cesium.Cartesian2(2600 + Math.random() * 2600, 900 + Math.random() * 700),
      maximumSize: new Cesium.Cartesian3(50, 16, 14), slice: 0.33 + Math.random() * 0.1, brightness: 1.0,
    });
    S.cloudList.push({ c, e, n, h });
  }

  // rain (shown when that year's precipitation is above the site's typical level)
  const enu = enuAt(lat, lon), down = new Cesium.Cartesian3(), wind = new Cesium.Cartesian3();
  S.rain = scene.primitives.add(new Cesium.ParticleSystem({
    image: RAIN, startColor: Cesium.Color.fromCssColorString("#d8ecff").withAlpha(0.32), endColor: Cesium.Color.fromCssColorString("#d8ecff").withAlpha(0.08),
    imageSize: new Cesium.Cartesian2(5, 140), sizeInMeters: true, minimumParticleLife: 2.2, maximumParticleLife: 2.8,
    minimumSpeed: 900, maximumSpeed: 1100, emissionRate: 0, lifetime: 16,
    emitter: new Cesium.BoxEmitter(new Cesium.Cartesian3(22000, 22000, 200)), modelMatrix: enuAt(lat, lon, 2600),
    updateCallback: (p) => {
      const th = Cesium.Math.toRadians(S.windDir), sp = S.windSpeed * 40;
      Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(Math.sin(th) * sp, Math.cos(th) * sp, -1000), wind);
      Cesium.Cartesian3.clone(wind, p.velocity);
    },
  }));

  // heat embers rising from the site (rate follows the night-heat signal)
  const up = Cesium.Cartesian3.normalize(Cesium.Cartesian3.fromDegrees(lon, lat), new Cesium.Cartesian3());
  S.embers = scene.primitives.add(new Cesium.ParticleSystem({
    image: EMBER, startColor: Cesium.Color.WHITE, endColor: Cesium.Color.fromCssColorString("#ff4d1a").withAlpha(0),
    imageSize: new Cesium.Cartesian2(55, 55), sizeInMeters: true, startScale: 1, endScale: 0.3,
    minimumParticleLife: 4, maximumParticleLife: 8, minimumSpeed: 40, maximumSpeed: 120, emissionRate: 0, lifetime: 16,
    emitter: new Cesium.CircleEmitter(1900), modelMatrix: enuAt(lat, lon, 20),
    updateCallback: (p, dt) => {
      const sway = Math.sin(p.age * 2 + (p._seed ??= Math.random() * 10)) * 8;
      Cesium.Cartesian3.add(p.velocity, Cesium.Cartesian3.multiplyByScalar(up, 6 * dt, down), p.velocity);
      p.velocity.x += sway * dt; p.velocity.y -= sway * dt;
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
  // fluid weather field draped on the ground (NASA wind + heat/pollution/moisture dyes)
  if (new URLSearchParams(location.search).get("fluid") !== "off") S.fluid = attachFluid(viewer, site, { texEvery: QUALITY[Q].fluidTexEvery });
  setLight(S.light);
}

// ------------------------------------------------------------------ per-year update
export function applyYear(year, row, phase) {
  const num = (v) => (v == null || v === "" ? null : +v);
  const projected = phase === "projected";
  if (num(row.PlumeTowardDeg) != null) S.windDir = num(row.PlumeTowardDeg);
  if (num(row.WS10M) != null) S.windSpeed = num(row.WS10M);
  // rain: wetter-than-usual years rain harder
  const pr = num(row.PrecipMMDay);
  if (S.rain) S.rain.emissionRate = pr == null ? 0 : Math.max(0, pr - 2.6) * QUALITY[Q].rainRate * (projected ? 0.5 : 1);
  // embers from night-heat local signal
  const heat = num(row.LST_Night_Local);
  if (S.embers) S.embers.emissionRate = heat == null ? 0 : Math.min(QUALITY[Q].emberMax, Math.max(0, heat + 0.3) * 110);
  if (S.embers) S.embers.startColor = projected ? Cesium.Color.fromCssColorString("#bff3ff") : Cesium.Color.WHITE;
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
    b.show = year >= b._startYear;
    b._st.target = year >= b._startYear ? 28 + Math.min(3, year - b._startYear) * 8 : 1;
    b.box.material = projected ? Cesium.Color.fromCssColorString("#9fe8ff").withAlpha(0.35) : Cesium.Color.fromCssColorString("#dfe7f2").withAlpha(0.92);
  }
  // fluid weather field
  if (S.fluid) {
    const onset = +String(S.site.onset).slice(0, 4);
    const no2 = num(row.NO2_Local);
    const pollution = S.site.effects?.plume && year >= onset ? Math.max(0.35, no2 ?? S._lastNo2 ?? 0.4) : 0;
    if (no2 != null) S._lastNo2 = no2;
    S.fluid.setWeather({
      windTowardDeg: S.windDir, windSpeed: S.windSpeed,
      heat: heat == null ? 0 : (heat + 0.4) * 1.2,
      pollution,
      moisture: pr == null ? 0.3 : Math.max(0.15, (pr - 2.2) * 0.5),
      projected,
    });
  }
  // sun follows the year (same date & hour each year → consistent look)
  setLight(S.light, Math.min(year, 2026));
  pulse();
}

// ------------------------------------------------------------------ animation
let pulseT = 0;
function pulse() { pulseT = performance.now(); }
function tick() {
  const now = performance.now();
  // bloom pulse on year change
  const k = Math.max(0, 1 - (now - pulseT) / 450);
  scene.postProcessStages.bloom.uniforms.brightness = -0.32 + 0.22 * k;
  // massing growth easing
  for (const b of S.massing) b._st.h += (b._st.target - b._st.h) * 0.06;
  // clouds drift with the wind (time-lapse), wrapping around the site
  if (S.site && S.cloudList.length) {
    const th = Cesium.Math.toRadians(S.windDir), sp = S.windSpeed * 25, dt = 1 / 60;
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
    S.orbit.heading += 0.0016;
    viewer.camera.lookAt(S.orbit.center, new Cesium.HeadingPitchRange(S.orbit.heading, S.orbit.pitch, S.orbit.range));
  }
}

export function orbit(on) {
  if (on && S.site) {
    const center = Cesium.Cartesian3.fromDegrees(S.site.lon, S.site.lat, 0);
    S.orbit = { center, heading: viewer.camera.heading, pitch: Cesium.Math.toRadians(-32), range: 19000 };
  } else if (S.orbit) {
    S.orbit = null;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
}
