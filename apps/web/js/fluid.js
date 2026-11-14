// Cloud Shadow - CPU fallback for the fluid weather simulation (used when WebGL2 float
// render targets are unavailable). The main, 60 fps version is the GPU one in fluid-gpu.js.
//
// Solver: Jos Stam, "Real-Time Fluid Dynamics for Games" (2003): semi-Lagrangian advection,
// Gauss-Seidel pressure projection, plus vorticity confinement for curls. Visual inspiration:
// Pavel Dobryakov's WebGL-Fluid-Simulation and Evan Wallace's WebGL Water (both MIT).
// This is a CPU implementation (small grid) so it runs on any laptop, rendered into a canvas
// that Cesium drapes on the ground as a texture.
//
// Driven by NASA data each year (via setWeather):
//   wind  = NASA POWER direction/speed (time-lapsed)      → body force
//   heat stays in numerical charts; it never creates visible smoke.
//   a qualitative blue-gray source exists only for documented on-site combustion.
//   moisture = NASA POWER precipitation → subtle wind wisps from upwind.
// It is a VISUALIZATION of those inputs, not an atmospheric model.

import { getMotionSpeed } from "./motion.js";
import { weatherDyePixel } from "./smoke-policy.js";

const N = 80;                // interior cells per side (CPU cost ~ N² per step)
const SIZE = (N + 2) * (N + 2);
const IX = (i, j) => i + (N + 2) * j;

class Fluid {
  constructor() {
    this.u = new Float32Array(SIZE); this.v = new Float32Array(SIZE);
    this.u0 = new Float32Array(SIZE); this.v0 = new Float32Array(SIZE);
    this.dye = [0, 1, 2].map(() => new Float32Array(SIZE)); // 0 heat, 1 pollution, 2 moisture
    this.tmp = new Float32Array(SIZE); this.curl = new Float32Array(SIZE);
  }
  setBnd(b, x) { // open-ish boundaries: copy neighbours (dye and flow leave the domain)
    for (let i = 1; i <= N; i++) {
      x[IX(0, i)] = x[IX(1, i)]; x[IX(N + 1, i)] = x[IX(N, i)];
      x[IX(i, 0)] = x[IX(i, 1)]; x[IX(i, N + 1)] = x[IX(i, N)];
    }
    x[IX(0, 0)] = x[IX(1, 1)]; x[IX(0, N + 1)] = x[IX(1, N)]; x[IX(N + 1, 0)] = x[IX(N, 1)]; x[IX(N + 1, N + 1)] = x[IX(N, N)];
  }
  advect(b, d, d0, u, v, dt) {
    const dt0 = dt * N;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
      let x = i - dt0 * u[IX(i, j)], y = j - dt0 * v[IX(i, j)];
      x = Math.min(N + 0.5, Math.max(0.5, x)); y = Math.min(N + 0.5, Math.max(0.5, y));
      const i0 = x | 0, i1 = i0 + 1, j0 = y | 0, j1 = j0 + 1, s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
      d[IX(i, j)] = s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) + s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
    }
    this.setBnd(b, d);
  }
  project(u, v, p, div) {
    const h = 1 / N;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
      div[IX(i, j)] = -0.5 * h * (u[IX(i + 1, j)] - u[IX(i - 1, j)] + v[IX(i, j + 1)] - v[IX(i, j - 1)]); p[IX(i, j)] = 0;
    }
    this.setBnd(0, div); this.setBnd(0, p);
    for (let k = 0; k < 14; k++) {
      for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
        p[IX(i, j)] = (div[IX(i, j)] + p[IX(i - 1, j)] + p[IX(i + 1, j)] + p[IX(i, j - 1)] + p[IX(i, j + 1)]) / 4;
      this.setBnd(0, p);
    }
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
      u[IX(i, j)] -= 0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)]) / h;
      v[IX(i, j)] -= 0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)]) / h;
    }
    this.setBnd(1, u); this.setBnd(2, v);
  }
  vorticity(eps, dt) {
    const { u, v, curl } = this;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++)
      curl[IX(i, j)] = 0.5 * ((v[IX(i + 1, j)] - v[IX(i - 1, j)]) - (u[IX(i, j + 1)] - u[IX(i, j - 1)]));
    for (let j = 2; j < N; j++) for (let i = 2; i < N; i++) {
      let nx = 0.5 * (Math.abs(curl[IX(i + 1, j)]) - Math.abs(curl[IX(i - 1, j)]));
      let ny = 0.5 * (Math.abs(curl[IX(i, j + 1)]) - Math.abs(curl[IX(i, j - 1)]));
      const len = Math.hypot(nx, ny) + 1e-5; nx /= len; ny /= len;
      const w = curl[IX(i, j)];
      u[IX(i, j)] += eps * dt * ny * w; v[IX(i, j)] -= eps * dt * nx * w;
    }
  }
  step(dt, wind, decay) {
    const { u, v, u0, v0 } = this;
    // body force: relax toward the large-scale wind
    const relaxation = 1 - Math.pow(0.96, dt * 30);
    for (let k = 0; k < SIZE; k++) { u[k] += (wind[0] - u[k]) * relaxation; v[k] += (wind[1] - v[k]) * relaxation; }
    this.vorticity(28, dt);
    this.project(u, v, u0, v0);
    u0.set(u); v0.set(v);
    this.advect(1, u, u0, u0, v0, dt); this.advect(2, v, v0, u0, v0, dt);
    this.project(u, v, u0, v0);
    for (let c = 0; c < 3; c++) {
      this.tmp.set(this.dye[c]); this.advect(0, this.dye[c], this.tmp, u, v, dt);
      const d = this.dye[c], k = Math.pow(decay[c], dt * 30); for (let i = 0; i < SIZE; i++) d[i] *= k;
    }
  }
  splat(cx, cy, r, du, dv, dyes) {
    const r2 = r * r;
    for (let j = Math.max(1, (cy - 2 * r) | 0); j <= Math.min(N, (cy + 2 * r) | 0); j++)
      for (let i = Math.max(1, (cx - 2 * r) | 0); i <= Math.min(N, (cx + 2 * r) | 0); i++) {
        const w = Math.exp(-((i - cx) ** 2 + (j - cy) ** 2) / r2);
        if (w < 0.01) continue;
        const k = IX(i, j); this.u[k] += du * w; this.v[k] += dv * w;
        for (let c = 0; c < 3; c++) if (dyes[c]) this.dye[c][k] = Math.min(3, this.dye[c][k] + dyes[c] * w);
      }
  }
}

// ------------------------------------------------------------------ Cesium attachment
export function attachFluidCPU(viewer, site, { halfSizeM = 16000 } = {}) {
  const fluid = new Fluid();
  const canvases = [0, 1].map(() => { const c = document.createElement("canvas"); c.width = c.height = N; return c; });
  let front = 0;
  const img = canvases[0].getContext("2d").createImageData(N, N);
  const W = { windE: 0, windN: 0, speed: 0, pollution: 0, moisture: 0, projected: false };

  // geographic rectangle centred on the site (top of image = north)
  const dLat = halfSizeM / 111320, dLon = halfSizeM / (111320 * Math.cos(site.lat * Math.PI / 180));
  const rect = Cesium.Rectangle.fromDegrees(site.lon - dLon, site.lat - dLat, site.lon + dLon, site.lat + dLat);
  const entity = viewer.entities.add({
    rectangle: {
      coordinates: rect, height: 25,
      material: new Cesium.ImageMaterialProperty({ image: new Cesium.CallbackProperty(() => canvases[front], false), transparent: true }),
    },
  });

  let frame = 0, alive = true, visible = true, last = performance.now(), lastStep = 0, time = 0;
  const c = N / 2 + 0.5;
  function loop(now) {
    if (!alive) return;
    requestAnimationFrame(loop);
    const speed = getMotionSpeed();
    if (!visible || speed === 0) { last = now; lastStep = now; return; }
    if (now - lastStep < 33) return;           // simulate at most ~30 Hz, leave the frame budget to Cesium
    lastStep = now;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)) * speed; last = now;
    if (dt === 0) return;
    frame++; time += dt;
    const stepScale = dt * 30;
    // grid: +x = east, +y = SOUTH (row 0 is the northern edge of the image)
    const sp = W.speed * 0.002;
    const wind = [W.windE * sp, -W.windN * sp];
    // sources
    if (W.pollution > 0) fluid.splat(c, c, 1.8, wind[0] * 3 * stepScale, wind[1] * 3 * stepScale, [0, W.pollution * 0.16 * stepScale, 0]);
    if (W.moisture > 0 && frame % 4 === 0) {
      // wisps entering from the upwind edge
      const t = (Math.random() - 0.5) * N * 0.9;
      const ux = -Math.sign(wind[0]) || 0, uy = -Math.sign(wind[1]) || 0;
      const ex = Math.abs(wind[0]) > Math.abs(wind[1]) ? c + ux * (N / 2 - 3) : c + t;
      const ey = Math.abs(wind[0]) > Math.abs(wind[1]) ? c + t : c + uy * (N / 2 - 3);
      fluid.splat(ex, ey, 4.5, wind[0] * 2 * stepScale, wind[1] * 2 * stepScale, [0, 0, W.moisture * 0.35 * stepScale]);
    }
    if (frame % 9 === 0) { // gentle turbulence so the flow never looks laminar
      fluid.splat(1 + Math.random() * N, 1 + Math.random() * N, 6, (Math.random() - 0.5) * 0.1 * stepScale, (Math.random() - 0.5) * 0.1 * stepScale, [0, 0, 0]);
    }
    fluid.step(dt, wind, [0.985, 0.988, 0.992]);
    if (frame % 2 === 0) render();
  }
  const pixel = [0,0,0,0];
  function render() {
    const d = img.data, [H, P, M] = fluid.dye, proj = W.projected;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = IX(i + 1, j + 1), o = (i + j * N) * 4;
      weatherDyePixel(H[k], P[k], M[k], (i+.5)/N, 1-(j+.5)/N, time, W.windE, W.windN, proj, pixel);
      d[o] = pixel[0]*255; d[o + 1] = pixel[1]*255; d[o + 2] = pixel[2]*255; d[o + 3] = pixel[3]*255;
    }
    const back = 1 - front;
    canvases[back].getContext("2d").putImageData(img, 0, 0);
    front = back; // new canvas object → Cesium re-uploads the texture
  }
  requestAnimationFrame(loop);

  return {
    gpu: false,
    setVisible(value) { visible = !!value; entity.show = visible; last = performance.now(); lastStep = last; },
    setWeather({ windTowardDeg, windSpeed, heat, pollution, moisture, projected }) {
      if (Number.isFinite(windTowardDeg)) { const th = windTowardDeg * Math.PI / 180; W.windE = Math.sin(th); W.windN = Math.cos(th); }
      else { W.windE = 0; W.windN = 0; }
      if (windSpeed != null) W.speed = windSpeed;
      W.pollution = Math.max(0, pollution ?? 0); W.moisture = Math.max(0, moisture ?? 0);
      W.projected = !!projected;
    },
    setWind(towardDeg, speed) {
      const th = towardDeg * Math.PI / 180; W.windE = Math.sin(th); W.windN = Math.cos(th); W.speed = speed;
    },
    dispose() { alive = false; viewer.entities.remove(entity); },
  };
}
