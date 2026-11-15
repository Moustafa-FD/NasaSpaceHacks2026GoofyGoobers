// Footprint Atlas - one 3D effect per theme, sized by the selected year so BEFORE and AFTER look clearly different.
//   Air: violet haze (NO₂ above nearby) · Heat: orange/blue ground glow · Greenery: green band = surroundings, site disc green→brown
//   Water: blue ripples (reported households' use) · Power: glowing power lines flowing in (reported MW). Water and Power show nothing before the start year.
// Deliberately exaggerated visualizations of the numbers in the panel (the help card says so), not measured concentrations. Driven by "cs:theme" (ui-shell.js) and "cs:year" (timeline.js).
import { sceneGround } from "./fluid-gpu.js";
import { projectRow } from "./ui-facts.js";
const V = { local: false, ground: 0, viewer: null, theme: null, site: null, facts: null, row: null, year: null, ents: [], t0: performance.now() };
const num = (x) => (x == null || x === "" ? null : +x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pulse = (s = 1) => 0.5 + 0.5 * Math.sin(((performance.now() - V.t0) / 1000) * s);

function radial(stops) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256); return c;
}
// Soft glow with an organic, patchy edge (3 octaves of value noise) so ground effects don't read as flat discs.
function glow(rgb) {
  const N = 256, c = document.createElement("canvas"); c.width = c.height = N;
  const g = c.getContext("2d"), img = g.createImageData(N, N), [r, gg, b] = rgb.split(",").map(Number);
  const hash = (x, y) => { const h = Math.sin(x * 127.1 + y * 311.7 + r) * 43758.5453; return h - Math.floor(h); };
  const vnoise = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), bb = hash(xi + 1, yi), cc = hash(xi, yi + 1), d = hash(xi + 1, yi + 1); return a + (bb - a) * u + (cc - a) * v + (a - bb - cc + d) * u * v; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x / N - 0.5, dy = y / N - 0.5, d = Math.hypot(dx, dy) * 2, ang = Math.atan2(dy, dx);
    const n = 0.5 * vnoise(x / 32, y / 32) + 0.3 * vnoise(x / 14, y / 14) + 0.2 * vnoise(x / 6, y / 6);
    const edge = d * (0.82 + 0.36 * vnoise(Math.cos(ang) * 3 + 9, Math.sin(ang) * 3 + 9)); // wobbly outline
    const a = Math.max(0, 1 - edge) ** 1.4 * (0.72 + 0.28 * n);
    const i = (y * N + x) * 4; img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = Math.round(255 * Math.min(1, a * 1.15));
  }
  g.putImageData(img, 0, 0); return c;
}
// thin soft ring (ripples, heat waves) and a soft sprite (sparks)
const ring = (rgb) => radial([[0, `rgba(${rgb},0)`], [0.8, `rgba(${rgb},0)`], [0.92, `rgba(${rgb},.9)`], [0.97, `rgba(${rgb},.35)`], [1, `rgba(${rgb},0)`]]);
const IMG = { spark: radial([[0, "rgba(255,248,220,1)"], [0.25, "rgba(255,210,110,.85)"], [1, "rgba(242,184,75,0)"]]),
  band: radial([[0, "rgba(60,165,75,0)"], [0.74, "rgba(60,165,75,0)"], [0.87, "rgba(60,165,75,.85)"], [1, "rgba(60,165,75,0)"]]) };
// White textures tinted per frame through the material colour: a year change only updates numbers, never
// creates a new texture (new textures draw white for a frame before they load: the "white flash").
const WHITE = { glow: glow("255,255,255"), ring: ring("255,255,255") };
const RGB = { warm: [255, 120, 40], cool: [70, 130, 210], heatRing: [255, 150, 70], coolRing: [110, 160, 230],
  green: [40, 190, 60], brown: [190, 95, 35], water: [90, 170, 235], power: [255, 200, 90], violet: [190, 140, 255], haze: [125, 90, 190] };

// Year-dependent numbers, recomputed on every "cs:year"; the entities read them through callbacks.
const D = { k: 0.2, sign: 1, t: 0, started: false, on: false, toward: 0 };
function derive() {
  // Future years use the same realistic scenario as the panel's number (ui-facts.js projectRow), not the raw fitted line.
  const r = (V.row?.Phase === "projected" && !V.facts?.rep ? projectRow(V.theme, V.facts, V.year, V.site) : V.row) || {}, rv = V.facts?.years?.rowVar, v = num(r[`${rv}_Local`]), s = num(r[`${rv}_Surround`]) ?? (num(r[`${rv}_Site`]) != null && v != null ? num(r[`${rv}_Site`]) - v : null);
  const start = +String(V.site?.onset).slice(0, 4), pub = V.facts?.published;
  D.started = (V.year ?? 9999) >= start;
  D.on = (V.year ?? 0) >= (pub?.after.year ?? start);
  D.toward = (num(r.PlumeTowardDeg) ?? 0) * Math.PI / 180;
  if (V.theme === "heat") { D.sign = (v ?? 0) >= 0 ? 1 : -1; D.k = clamp(Math.abs(v ?? 0) / 0.5, 0.15, 1); }
  if (V.theme === "green") D.t = clamp(-((v ?? 0) / (s || 1)) / 0.3, 0, 1); // 0 = as green as nearby, 1 = 30%+ less green
  if (V.theme === "air") D.k = pub ? (D.on ? 1 : 0.12) : clamp(((v ?? 0) / (s || 1)) / 0.15, 0.1, 1);
}

let builtKey = "";
function build() {
  const C = globalThis.Cesium; if (!V.viewer || !C) return;
  derive();
  const mapShown = V.theme === "heat" && V.mapOn && !V.local;
  const key = [V.theme, V.site?.id, V.local, Math.round(V.ground), mapShown].join("|");
  if (key === builtKey && V.ents.length) return; // same scene: callbacks pick up the new year
  builtKey = key;
  for (const e of V.ents) V.viewer.entities.remove(e); V.ents = [];
  if (!V.site || !V.theme) return;
  const add = (spec) => V.ents.push(V.viewer.entities.add(spec));
  // In the low-poly close-up the ground is the team's terrain mesh, not the ellipsoid: lift everything onto it.
  const lift = V.local ? V.ground : 0; // ellipse `height` is absolute, so add the ground there too
  const at = (h = 0) => C.Cartesian3.fromDegrees(V.site.lon, V.site.lat, h + lift);
  const cb = (fn) => new C.CallbackProperty(fn, false);
  const spin = cb(() => ((performance.now() - V.t0) / 1000) * 0.03); // slow texture rotation keeps patchy glows alive
  const tint = (rgb, alpha) => cb(() => { const c = typeof rgb === "function" ? rgb() : rgb; return new C.Color(c[0] / 255, c[1] / 255, c[2] / 255, Math.max(0, alpha())); });
  const mat = (img, rgb, alpha) => new C.ImageMaterialProperty({ image: img, transparent: true, color: tint(rgb, alpha) });
  const disc = (radius, rgb, alpha, h = 18, show) => add({ position: at(), ellipse: { semiMajorAxis: radius, semiMinorAxis: radius, height: h + lift, stRotation: spin, material: mat(WHITE.glow, rgb, alpha), show } });
  const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
  const ripples = (n, period, r0, r1, rgb, alpha, h, show) => { for (let i = 0; i < n; i++) {
    const f = () => (((performance.now() - V.t0) / period) + i / n) % 1, rad = cb(() => (typeof r0 === "function" ? r0() : r0) + f() * (typeof r1 === "function" ? r1() : r1));
    add({ position: at(), ellipse: { semiMajorAxis: rad, semiMinorAxis: rad, height: h + lift, material: mat(WHITE.ring, rgb, () => alpha() * (1 - f())), show } });
  } };

  if (V.theme === "heat") {
    // The NASA map isn't drawn on the low-poly close-up terrain, so there the glow carries the heat on its own.
    const R = () => (V.local ? 900 + D.k * 1800 : 2000 + D.k * 4500), faint = mapShown ? 0.5 : 1;
    if (!mapShown) add({ position: at(), ellipse: { semiMajorAxis: cb(R), semiMinorAxis: cb(R), height: 18 + lift, stRotation: spin,
      material: mat(WHITE.glow, () => (D.sign > 0 ? RGB.warm : RGB.cool), () => (0.45 + 0.55 * D.k) * (0.8 + 0.2 * pulse(1.3))) } });
    ripples(3, 3000, () => R() * 0.3, () => R() * 0.9, () => (D.sign > 0 ? RGB.heatRing : RGB.coolRing), () => faint * (0.6 + 0.4 * D.k), 22);
  }
  if (V.theme === "green") {
    add({ position: at(), ellipse: { semiMajorAxis: 5600, semiMinorAxis: 5600, height: 16 + lift, material: new C.ImageMaterialProperty({ image: IMG.band, transparent: true, color: cb(() => C.Color.WHITE.withAlpha(0.85 + 0.15 * pulse(0.6))) }) } });
    disc(3000, () => mix(RGB.green, RGB.brown, D.t), () => 0.95);
  }
  const ps = V.site.effects?.plumeSource, fluidAir = V.site.effects?.plume === true || !!ps;
  if (V.theme === "air" && fluidAir) {
    // The GPU fluid (fluid-gpu.js) draws the plume itself; mark only the source so the simulation stays the hero.
    add({ position: C.Cartesian3.fromDegrees(ps?.lon ?? V.site.lon, ps?.lat ?? V.site.lat), ellipse: { semiMajorAxis: 650, semiMinorAxis: 650, height: 30 + lift, stRotation: spin,
      material: mat(WHITE.glow, RGB.violet, () => (D.on ? 0.75 : 0.18) * (0.8 + 0.2 * pulse(2.2))) } });
  }
  if (V.theme === "air" && !fluidAir) {
    const enu = C.Transforms.eastNorthUpToFixedFrame(at());
    for (const [h, size, drift] of [[120, 1, 0.6], [550, 0.8, 1], [1000, 0.6, 1.4]]) { // three soft layers, higher = smaller and further downwind
      const pos = cb(() => { const d = (600 + D.k * 1400) * drift * (0.9 + 0.1 * pulse(0.4)); return C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(Math.sin(D.toward) * d, Math.cos(D.toward) * d, 0), new C.Cartesian3()); });
      const R = cb(() => (2800 + D.k * 4500) * size);
      add({ position: pos, ellipse: { semiMajorAxis: R, semiMinorAxis: R, height: h + lift, stRotation: spin, material: mat(WHITE.glow, RGB.haze, () => (0.3 + 0.65 * D.k) * (0.8 + 0.2 * pulse(0.7))) } });
    }
  }
  const rep = V.facts?.rep, hasRep = rep && !rep.missing, shown = cb(() => D.started);
  if (V.theme === "water" && hasRep) {
    // Text-only figures (e.g. a county share) have no household count: show a mid-size symbolic ripple.
    const n = clamp(Math.round((rep.households ?? 3000) / 600), 3, 12);
    disc(1100, RGB.water, () => 0.75 + 0.25 * pulse(1.5), 18, shown);
    ripples(n, 4200, 500, 5200, RGB.water, () => 0.95, 15, shown);
  }
  if (V.theme === "power" && hasRep) {
    // Ground-level power lines flowing into the site; more lines = more megawatts (no vertical shapes).
    const n = clamp(Math.round(Math.log10(rep.mw ?? 300) * 3), 3, 12), enu = C.Transforms.eastNorthUpToFixedFrame(at());
    const pt = (ang, d) => C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(Math.sin(ang) * d, Math.cos(ang) * d, 25), new C.Cartesian3());
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * 2 * Math.PI + 0.3, far = pt(ang, 5200), near = pt(ang, 350);
      add({ polyline: { positions: [far, near], width: 12, show: shown, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: C.Color.fromCssColorString("#ffc24d").withAlpha(0.95) }) } });
      const f = () => (((performance.now() - V.t0) / 2200) + i / n) % 1; // pulse travels inward
      add({ position: cb(() => C.Cartesian3.lerp(far, near, f(), new C.Cartesian3())),
        billboard: { image: IMG.spark, width: 56, height: 56, show: shown, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    disc(1400, RGB.power, () => 0.75 + 0.25 * pulse(2), 18, shown);
  }
}

function init(cs) {
  V.viewer = cs.viewer;
  window.addEventListener("cs:theme", ({ detail: d }) => { Object.assign(V, { theme: d.theme, site: d.site, facts: d.facts, year: d.year, mapOn: !!d.mapOn }); build(); });
  window.addEventListener("cs:scene-mode", (e) => {
    V.local = !!e.detail?.active; V.ground = 0; build();
    if (V.local) setTimeout(() => { if (!V.local) return; V.ground = sceneGround(V.viewer, V.site?.lat ?? 0, V.site?.lon ?? 0) ?? 0; build(); }, 1500);
  });
  window.addEventListener("cs:year", ({ detail: d }) => { if (V.site && d?.siteId && d.siteId !== V.site.id) return; V.row = d?.row; V.year = d?.year ?? V.year; build(); });
}

if (new URLSearchParams(location.search).get("ui") !== "classic") {
  if (window.CloudShadow) init(window.CloudShadow); else window.addEventListener("cs:ready", (e) => init(e.detail), { once: true });
}
