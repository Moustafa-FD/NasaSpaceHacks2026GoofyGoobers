// Footprint Atlas - one 3D effect per theme, sized by the selected year so BEFORE and AFTER look clearly different.
//   Air: violet haze (NO₂ above nearby) · Heat: orange/blue ground glow · Greenery: green band = surroundings, site disc green→brown
//   Water: blue ripples (reported households' use) · Power: glowing power lines flowing in (reported MW). Water and Power show nothing before the start year.
// Deliberately exaggerated visualizations of the numbers in the panel (the help card says so), not measured concentrations. Driven by "cs:theme" (ui-shell.js) and "cs:year" (timeline.js).
const V = { viewer: null, theme: null, site: null, facts: null, row: null, year: null, ents: [], t0: performance.now() };
const num = (x) => (x == null || x === "" ? null : +x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pulse = (s = 1) => 0.5 + 0.5 * Math.sin(((performance.now() - V.t0) / 1000) * s);

function radial(stops) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256); return c;
}
const glow = (rgb) => radial([[0, `rgba(${rgb},.95)`], [0.5, `rgba(${rgb},.5)`], [1, `rgba(${rgb},0)`]]);
// thin soft ring (ripples, heat waves) and a soft sprite (sparks)
const ring = (rgb) => radial([[0, `rgba(${rgb},0)`], [0.8, `rgba(${rgb},0)`], [0.92, `rgba(${rgb},.9)`], [0.97, `rgba(${rgb},.35)`], [1, `rgba(${rgb},0)`]]);
const IMG = { warm: glow("255,120,40"), cool: glow("70,130,210"), heatRing: ring("255,150,70"), coolRing: ring("110,160,230"),
  waterRing: ring("90,170,235"), haze: glow("125,90,190"), spark: radial([[0, "rgba(255,248,220,1)"], [0.25, "rgba(255,210,110,.85)"], [1, "rgba(242,184,75,0)"]]),
  band: radial([[0, "rgba(60,165,75,0)"], [0.74, "rgba(60,165,75,0)"], [0.87, "rgba(60,165,75,.85)"], [1, "rgba(60,165,75,0)"]]) };
const discCache = new Map();
const disc = (rgb) => discCache.get(rgb) || (discCache.set(rgb, glow(rgb)), discCache.get(rgb));

function build() {
  const C = globalThis.Cesium; if (!V.viewer || !C) return;
  for (const e of V.ents) V.viewer.entities.remove(e); V.ents = [];
  if (!V.site || !V.theme) return;
  const add = (spec) => V.ents.push(V.viewer.entities.add(spec));
  const at = (h = 0) => C.Cartesian3.fromDegrees(V.site.lon, V.site.lat, h);
  const ground = (radius, material, h = 18) => add({ position: at(), ellipse: { semiMajorAxis: radius, semiMinorAxis: radius, height: h, material } });
  const image = (img, alpha) => new C.ImageMaterialProperty({ image: img, transparent: true, color: typeof alpha === "function" ? new C.CallbackProperty(() => C.Color.WHITE.withAlpha(alpha()), false) : C.Color.WHITE.withAlpha(alpha) });
  const r = V.row || {}, started = (V.year ?? 9999) >= +String(V.site.onset).slice(0, 4), rv = V.facts?.years?.rowVar;

  if (V.theme === "heat") {
    const v = num(r[`${rv}_Local`]) ?? 0, k = clamp(Math.abs(v) / 0.5, 0.15, 1);
    const R = 2000 + k * 4500, faint = V.mapOn ? 0.5 : 1; // with the NASA heat map on, only mark the site so the map's regions stay visible
    if (!V.mapOn) ground(R, image(v >= 0 ? IMG.warm : IMG.cool, () => (0.45 + 0.55 * k) * (0.8 + 0.2 * pulse(1.3))));
    for (let i = 0; i < 3; i++) { // waves radiating outward; stronger signal = brighter waves
      const f = () => (((performance.now() - V.t0) / 3000) + i / 3) % 1, rad = new C.CallbackProperty(() => R * (0.3 + 0.9 * f()), false);
      add({ position: at(), ellipse: { semiMajorAxis: rad, semiMinorAxis: rad, height: 22, material: image(v >= 0 ? IMG.heatRing : IMG.coolRing, () => faint * (0.6 + 0.4 * k) * (1 - f())) } });
    }
  }
  if (V.theme === "green") {
    const v = num(r[`${rv}_Local`]), s = num(r[`${rv}_Surround`]);
    const t = clamp(-((v ?? 0) / (s || 1)) / 0.3, 0, 1); // 0 = as green as nearby, 1 = 30%+ less green
    const rgb = [40, 190, 60].map((c, i) => Math.round(c + ([190, 95, 35][i] - c) * Math.round(t * 6) / 6)).join(",");
    ground(5600, image(IMG.band, () => 0.85 + 0.15 * pulse(0.6)), 16);
    ground(3000, image(disc(rgb), () => 0.95));
  }
  if (V.theme === "air") {
    const v = num(r[`${rv}_Local`]), s = num(r[`${rv}_Surround`]);
    const pub = V.facts?.published; // published study: haze follows the study's before → after change, not our level
    const k = pub ? ((V.year ?? 0) >= pub.after.year ? 1 : 0.12) : clamp(((v ?? 0) / (s || 1)) / 0.15, 0.1, 1), toward = (num(r.PlumeTowardDeg) ?? 0) * Math.PI / 180;
    const enu = C.Transforms.eastNorthUpToFixedFrame(at());
    for (const [h, size, drift] of [[120, 1, 0.6], [550, 0.8, 1], [1000, 0.6, 1.4]]) { // three soft layers, higher = smaller and further downwind
      const pos = new C.CallbackProperty(() => { const d = (600 + k * 1400) * drift * (0.9 + 0.1 * pulse(0.4)); return C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(Math.sin(toward) * d, Math.cos(toward) * d, 0), new C.Cartesian3()); }, false);
      const R = (2800 + k * 4500) * size;
      add({ position: pos, ellipse: { semiMajorAxis: R, semiMinorAxis: R, height: h, material: image(IMG.haze, () => (0.3 + 0.65 * k) * (0.8 + 0.2 * pulse(0.7))) } });
    }
  }
  if (V.theme === "water" && started && V.facts?.rep && !V.facts.rep.missing) {
    // Text-only figures (e.g. a county share) have no household count: show a mid-size symbolic ripple.
    const n = clamp(Math.round((V.facts.rep.households ?? 3000) / 600), 3, 12);
    ground(1100, image(glow("90,170,235"), () => 0.75 + 0.25 * pulse(1.5)));
    for (let i = 0; i < n; i++) {
      const f = () => (((performance.now() - V.t0) / 4200) + i / n) % 1;
      const radius = new C.CallbackProperty(() => 500 + f() * 5200, false);
      add({ position: at(), ellipse: { semiMajorAxis: radius, semiMinorAxis: radius, height: 15, material: image(IMG.waterRing, () => 0.95 * (1 - f())) } });
    }
  }
  if (V.theme === "power" && started && V.facts?.rep && !V.facts.rep.missing) {
    // Ground-level power lines flowing into the site; more lines = more megawatts (no vertical shapes).
    const n = clamp(Math.round(Math.log10(V.facts.rep.mw ?? 300) * 3), 3, 12), enu = C.Transforms.eastNorthUpToFixedFrame(at());
    const pt = (ang, d) => C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(Math.sin(ang) * d, Math.cos(ang) * d, 25), new C.Cartesian3());
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * 2 * Math.PI + 0.3, far = pt(ang, 5200), near = pt(ang, 350);
      add({ polyline: { positions: [far, near], width: 12, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: C.Color.fromCssColorString("#ffc24d").withAlpha(0.95) }) } });
      const f = () => (((performance.now() - V.t0) / 2200) + i / n) % 1; // pulse travels inward
      add({ position: new C.CallbackProperty(() => C.Cartesian3.lerp(far, near, f(), new C.Cartesian3()), false),
        billboard: { image: IMG.spark, width: 56, height: 56, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
    ground(1400, image(glow("255,200,90"), () => 0.75 + 0.25 * pulse(2)));
  }
}

function init(cs) {
  V.viewer = cs.viewer;
  window.addEventListener("cs:theme", ({ detail: d }) => { Object.assign(V, { theme: d.theme, site: d.site, facts: d.facts, year: d.year, mapOn: !!d.mapOn }); build(); });
  window.addEventListener("cs:year", ({ detail: d }) => { if (V.site && d?.siteId && d.siteId !== V.site.id) return; V.row = d?.row; V.year = d?.year ?? V.year; build(); });
}

if (new URLSearchParams(location.search).get("ui") !== "classic") {
  if (window.CloudShadow) init(window.CloudShadow); else window.addEventListener("cs:ready", (e) => init(e.detail), { once: true });
}
