// Footprint Atlas - real wind flow from NASA GEOS-FP analyses (flow-field/1.0 products).
//
// Data: data/fields/index.json + <site|global>/<year>.json/.wind.png, built by
//   python -m services.models.fields.build   (see docs/flow-fields.md; same files feed Unreal).
// What it does for the selected site/year:
//   1. particle trails advected by the real gridded 10 m wind (site box when zoomed in, globe when zoomed out),
//      cycling through that year's analysis frames (time-lapse);
//   2. broadcasts the analysed wind at the site as a "cs:wind" event so the fluid sim, clouds and streaks
//      follow the actual wind of each frame instead of one annual mean arrow.
// Evidence: GEOS-FP is a model analysis (observations assimilated). Directions matched Dulles airport
// observations within ~9 deg (median); speeds read ~37% low vs the airport anemometer, so speed is shown as relative.
// Particles show where air moves; they are not pollutant concentrations.

const SECONDS_PER_FRAME = 2.0;      // time-lapse: one analysis frame every 2 s
const GLOBAL_ALTITUDE_M = 2_500_000; // above this camera height, show the global field
const TRAIL = 6;

const cache = new Map();
let indexPromise = null;

export function loadIndex() {
  indexPromise ??= fetch("data/fields/index.json").then((r) => (r.ok ? r.json() : { products: [] })).catch(() => ({ products: [] }));
  return indexPromise;
}

function loadImage(url) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
}

/** Load and decode one product into per-frame Float32 u/v grids (rows north→south, as stored). */
export async function loadField(product) {
  if (cache.has(product.id)) return cache.get(product.id);
  const promise = (async () => {
    const m = await (await fetch(`data/fields/${product.manifest}`)).json();
    const img = await loadImage(`data/fields/${product.files.wind}`);
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const { nx, ny } = m.grid, { cols } = m.atlas;
    const R = m.encoding.wind.R, G = m.encoding.wind.G;
    const dec = (b, ch) => ch.min + (b / 255) * (ch.max - ch.min);
    const frames = m.frames.map((_, f) => {
      const ox = (f % cols) * nx, oy = Math.floor(f / cols) * ny;
      const u = new Float32Array(nx * ny), v = new Float32Array(nx * ny), ok = new Uint8Array(nx * ny);
      for (let r = 0; r < ny; r++) for (let q = 0; q < nx; q++) {
        const p = ((oy + r) * img.width + ox + q) * 4, k = r * nx + q;
        u[k] = dec(px[p], R); v[k] = dec(px[p + 1], G); ok[k] = px[p + 2] > 127 ? 1 : 0;
      }
      return { u, v, ok };
    });
    return { m, frames };
  })();
  cache.set(product.id, promise);
  return promise;
}

/** Bilinear in space, linear in time; t = fractional frame index. Returns null outside the grid. */
export function sampleWind(field, lat, lon, t) {
  const g = field.m.grid, n = field.frames.length;
  const dLat = (g.latMax - g.latMin) / (g.ny - 1), dLon = (g.lonMax - g.lonMin) / (g.nx - 1);
  let fx = (lon - g.lonMin) / dLon;
  if (g.wrapsLongitude) fx = ((fx % g.nx) + g.nx) % g.nx;
  const fy = (g.latMax - lat) / dLat; // rows are north → south
  if (fy < 0 || fy > g.ny - 1 || (!g.wrapsLongitude && (fx < 0 || fx > g.nx - 1))) return null;
  const i0 = Math.floor(fx), j0 = Math.min(Math.floor(fy), g.ny - 2);
  const i1 = g.wrapsLongitude ? (i0 + 1) % g.nx : Math.min(i0 + 1, g.nx - 1);
  const tx = fx - i0, ty = fy - j0;
  const f0 = Math.floor(t) % n, f1 = (f0 + 1) % n, tt = t - Math.floor(t);
  let u = 0, v = 0;
  for (const [fr, w] of [[field.frames[f0], 1 - tt], [field.frames[f1], tt]]) {
    const a = j0 * g.nx, b = (j0 + 1) * g.nx;
    if (!fr.ok[a + i0] || !fr.ok[a + i1] || !fr.ok[b + i0] || !fr.ok[b + i1]) return null;
    const bl = (arr) => (arr[a + i0] * (1 - tx) + arr[a + i1] * tx) * (1 - ty) + (arr[b + i0] * (1 - tx) + arr[b + i1] * tx) * ty;
    u += bl(fr.u) * w; v += bl(fr.v) * w;
  }
  return { u, v };
}

/** Analysed wind at the site point (exact values from the manifest), vector-interpolated in time. */
export function siteWindAt(field, t) {
  const s = field.m.siteSeries; if (!s?.length) return null;
  const n = s.length, a = s[Math.floor(t) % n], b = s[(Math.floor(t) + 1) % n], w = t - Math.floor(t);
  if (a.u == null || b.u == null) return null;
  const u = a.u * (1 - w) + b.u * w, v = a.v * (1 - w) + b.v * w;
  return { u, v, speed: Math.hypot(u, v), towardDeg: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360, time: (w < 0.5 ? a : b).time };
}

const speedColor = (s) => {
  const k = Math.min(1, s / 12);
  return k < 0.5 ? Cesium.Color.fromCssColorString("#7fd3ff").withAlpha(0.55 + k)
                 : Cesium.Color.lerp(Cesium.Color.fromCssColorString("#ffffff"), Cesium.Color.fromCssColorString("#ffb347"), (k - 0.5) * 2, new Cesium.Color()).withAlpha(0.95);
};

/** Particle-trail layer for one field. */
class Particles {
  constructor(viewer, field, { count, altitude, timeLapse, bbox }) {
    this.viewer = viewer; this.field = field; this.altitude = altitude; this.timeLapse = timeLapse; this.bbox = bbox;
    this.lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.p = Array.from({ length: count }, () => this.spawn({}));
    for (const p of this.p) p.line = this.lines.add({ positions: this.positions(p), width: 1.6, material: Cesium.Material.fromType("Color", { color: Cesium.Color.TRANSPARENT }) });
  }
  spawn(p) {
    const [w, s, e, n] = this.bbox;
    const lat = this.bbox.global ? Math.asin(2 * Math.random() - 1) * 180 / Math.PI * 0.95 : s + Math.random() * (n - s);
    const lon = w + Math.random() * (e - w);
    p.trail = Array.from({ length: TRAIL }, () => [lon, lat]);
    p.age = 0; p.life = 3 + Math.random() * 4; p.speed = 0;
    return p;
  }
  positions(p) { return p.trail.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la, this.altitude)); }
  step(dt, t, frameCounter) {
    const R = 6_371_000;
    for (const p of this.p) {
      p.age += dt;
      const [lon, lat] = p.trail[p.trail.length - 1];
      const w = sampleWind(this.field, lat, lon, t);
      if (!w || p.age > p.life) { this.spawn(p); p.line.material.uniforms.color = Cesium.Color.TRANSPARENT; continue; }
      const k = this.timeLapse * dt;
      const nlat = lat + (w.v * k / R) * 180 / Math.PI;
      let nlon = lon + (w.u * k / (R * Math.max(0.05, Math.cos(lat * Math.PI / 180)))) * 180 / Math.PI;
      if (nlon > 180) nlon -= 360; if (nlon < -180) nlon += 360;
      if (frameCounter % 2 === 0) { p.trail.shift(); p.trail.push([nlon, nlat]); }
      else p.trail[p.trail.length - 1] = [nlon, nlat];
      if (Math.abs(nlon - lon) > 90) { this.spawn(p); continue; } // dateline jump: restart trail
      p.speed = Math.hypot(w.u, w.v);
      const fade = Math.min(1, p.age / 0.6, (p.life - p.age) / 0.8);
      const c = speedColor(p.speed); c.alpha *= Math.max(0, fade);
      p.line.material.uniforms.color = c;
      p.line.positions = this.positions(p);
    }
  }
  set show(v) { this.lines.show = v; }
  dispose() { this.viewer.scene.primitives.remove(this.lines); }
}

/** Controller: pick products for the site/year, animate, broadcast site wind. */
export function attachFlow(viewer) {
  const disabled = new URLSearchParams(location.search).get("flow") === "off";
  const F = { site: null, year: null, siteLayer: null, globalLayer: null, siteField: null, t: 0, last: performance.now(), frame: 0, lastEmit: 0, token: 0 };
  const hud = () => {
    let el = document.getElementById("tlFlow");
    if (!el) {
      el = document.createElement("span"); el.id = "tlFlow"; el.className = "tl-chip muted";
      el.title = "NASA GEOS-FP analysis wind at the site (time-lapse through the year's analyses). Direction matches airport observations; speed reads low, so treat it as relative.";
      document.getElementById("tlChips")?.after(el);
    }
    return el;
  };

  async function setYear(site, year, phase) {
    if (disabled) return;
    const token = ++F.token;
    F.site = site; F.year = year; F.siteField = null; // stop broadcasting the previous year's wind immediately
    const idx = await loadIndex();
    if (token !== F.token) return;
    const find = (kind, y, siteId) => idx.products.find((p) => p.kind === kind && p.year === y && (kind === "global" || p.site === siteId));
    const sp = phase === "projected" ? null : find("site", year, site.id);
    const gp = phase === "projected" ? null : find("global", year);
    const [sf, gf] = await Promise.all([sp ? loadField(sp) : null, gp ? loadField(gp) : null]);
    if (token !== F.token) return;
    F.siteLayer?.dispose(); F.globalLayer?.dispose(); F.siteLayer = F.globalLayer = null; F.siteField = sf;
    const q = (window.localStorage?.getItem("csQuality") || "high") === "low" ? 0.5 : 1;
    if (sf) {
      const g = sf.m.grid;
      F.siteLayer = new Particles(viewer, sf, { count: Math.round(900 * q), altitude: 2500, timeLapse: 9000, bbox: [g.lonMin, g.latMin, g.lonMax, g.latMax] });
    }
    if (gf) F.globalLayer = new Particles(viewer, gf, { count: Math.round(2200 * q), altitude: 30000, timeLapse: 160000, bbox: Object.assign([-180, -90, 180, 90], { global: true }) });
    const el = hud();
    if (!sf) {
      el.textContent = phase === "projected" ? "Flow: no forecast for projected years" : year < 2018 ? "Flow: GEOS-FP analyses start 2018" : "Flow: no field built";
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    if (disabled) return;
    const now = performance.now(), dt = Math.min(0.05, (now - F.last) / 1000); F.last = now; F.frame++;
    const field = F.siteField;
    const n = field?.frames.length || F.globalLayer?.field.frames.length || 1;
    F.t = (F.t + dt / SECONDS_PER_FRAME) % n;
    const height = viewer.camera.positionCartographic.height;
    const global = height > GLOBAL_ALTITUDE_M;
    if (F.siteLayer) { F.siteLayer.show = !global; if (!global) F.siteLayer.step(dt, F.t, F.frame); }
    if (F.globalLayer) { F.globalLayer.show = global; if (global) F.globalLayer.step(dt, F.t % F.globalLayer.field.frames.length, F.frame); }
    if (field && now - F.lastEmit > 200) {
      F.lastEmit = now;
      const w = siteWindAt(field, F.t);
      if (w) {
        window.dispatchEvent(new CustomEvent("cs:wind", { detail: { ...w, source: "NASA GEOS-FP analysis", siteId: F.site?.id } }));
        hud().innerHTML = `<span class="arrow" style="display:inline-block;transform:rotate(${w.towardDeg.toFixed(0)}deg)">↑</span> GEOS-FP ${w.time.slice(0, 10)} ${w.time.slice(11, 16)}Z · ${w.speed.toFixed(1)} m/s`;
      }
    }
  }
  requestAnimationFrame(tick);
  return { setYear, get state() { return F; } };
}
