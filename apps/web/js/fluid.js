// Cloud Shadow - CPU fallback for the fluid weather simulation (used when WebGL2 float
// render targets are unavailable). The main, 60 fps version is the GPU one in fluid-gpu.js.
//
// Solver: Jos Stam, "Real-Time Fluid Dynamics for Games" (2003): semi-Lagrangian advection,
// Gauss-Seidel pressure projection, plus vorticity confinement for curls. Visual inspiration:
// Pavel Dobryakov's WebGL-Fluid-Simulation and Evan Wallace's WebGL Water (both MIT).
// This is a CPU implementation (small grid) so it runs on any laptop, rendered into a canvas
// that Cesium drapes on the ground as a texture.
//
// Optional dev tool with the same shared clock and geographic wind sampler as
// the GPU path. Only an explicit debug tracer creates dye; no precipitation,
// heat or pollution source is inferred. It is not an atmospheric model.

import { analysisDeltaSeconds, windForcingGrid } from "./flowfield.js";
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
  step(dt, wind, decay,windGrid=null) {
    const { u, v, u0, v0 } = this;
    // body force: relax toward the large-scale wind
    const relaxation = 1 - Math.pow(0.96, dt * 30);
    if(windGrid){
      for(let j=1;j<=N;j++)for(let i=1;i<=N;i++){
        const k=IX(i,j),g=((j-1)*N+i-1)*4,valid=windGrid[g+2]>.5;
        u[k]+=((valid?windGrid[g]:0)-u[k])*relaxation;v[k]+=((valid?windGrid[g+1]:0)-v[k])*relaxation;
      }
    }else for (let k = 0; k < SIZE; k++) { u[k] += (wind[0] - u[k]) * relaxation; v[k] += (wind[1] - v[k]) * relaxation; }
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
export function attachFluidCPU(viewer, site, { halfSizeM = 16000,sampleWind=null,timeLapse=400 } = {}) {
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

  let frame = 0, alive = true, visible = true,lastTime=Cesium.JulianDate.clone(viewer.clock.currentTime),accumulated=0,time=0,lastField=-Infinity;
  let sampleField=typeof sampleWind==='function'?sampleWind:null;
  const forcing=new Float32Array(N*N*4);
  function loop() {
    if (!alive) return;
    const clock=viewer.clock,delta=Cesium.JulianDate.secondsDifference(clock.currentTime,lastTime);
    lastTime=Cesium.JulianDate.clone(clock.currentTime,lastTime);
    const elapsed=analysisDeltaSeconds(delta,clock.shouldAnimate!==false&&clock.multiplier!==0&&document.visibilityState!=='hidden');
    if(!visible||!elapsed)return;
    accumulated+=elapsed;if(accumulated<1/30)return;
    const dt=Math.min(.05,accumulated);accumulated=0;
    frame++; time += dt;
    // grid: +x = east, +y = SOUTH (row 0 is the northern edge of the image)
    const scale=timeLapse/(halfSizeM*2),sp = W.speed * scale;
    const wind = [W.windE * sp, -W.windN * sp];
    if(sampleField&&time-lastField>=.2){
      lastField=time;windForcingGrid(sampleField,site,{size:N,halfSizeM,units:scale,northFirst:true},forcing);
    }
    // No random momentum or edge dye. Only explicit debug tracer injection
    // creates dye; missing gridded samples contribute no invented wind.
    fluid.step(dt, wind, [0.985, 0.988, 0.992],sampleField?forcing:null);
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
  const removeLoop=viewer.scene.preRender.addEventListener(loop);

  return {
    gpu: false,
    setVisible(value) { visible = !!value; entity.show = visible;lastTime=Cesium.JulianDate.clone(viewer.clock.currentTime,lastTime);accumulated=0; },
    setWeather({ windTowardDeg, windSpeed, heat, pollution, moisture, projected }) {
      if (Number.isFinite(windTowardDeg)) { const th = windTowardDeg * Math.PI / 180; W.windE = Math.sin(th); W.windN = Math.cos(th); }
      else { W.windE = 0; W.windN = 0; }
      W.speed=Number.isFinite(windSpeed)&&windSpeed>=0?windSpeed:0;
      W.pollution = W.moisture = 0;
      W.projected = !!projected;
    },
    setWind(towardDeg, speed) {
      const th=Number.isFinite(towardDeg)?towardDeg*Math.PI/180:null;W.windE=th==null?0:Math.sin(th);W.windN=th==null?0:Math.cos(th);W.speed=Number.isFinite(speed)&&speed>=0?speed:0;
    },
    setWindField(sample){sampleField=typeof sample==='function'?sample:null;lastField=-Infinity;},
    injectTracer(x=.5,y=.5,amount=.15){fluid.splat(1+Math.max(0,Math.min(1,x))*(N-1),1+(1-Math.max(0,Math.min(1,y)))*(N-1),1.5,0,0,[0,0,Math.max(0,Math.min(1,amount))]);},
    dispose() { alive = false;removeLoop();viewer.entities.remove(entity); },
  };
}
