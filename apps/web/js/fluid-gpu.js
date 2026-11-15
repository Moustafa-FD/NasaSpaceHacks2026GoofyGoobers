// Cloud Shadow - GPU fluid weather simulation (WebGL2, 60 fps), draped on the globe around a site.
//
// Same technique as Pavel Dobryakov's WebGL-Fluid-Simulation (MIT), written for this project:
// stable fluids on the GPU: advection, curl + vorticity confinement, divergence, Jacobi pressure
// solve, gradient subtraction, then a dye pass. It runs in its own small WebGL2 canvas; each frame
// the result is copied into a 2D canvas that Cesium drapes on the ground as a texture.
// Falls back to the CPU solver (fluid.js) if WebGL2 float render targets aren't available.
//
// Optional dev tool, not attached to the main globe. Wind can use a real GEOS-FP
// spatial sampler or an explicitly supplied vector. Only manual debug tracers
// create dye; precipitation, heat and pollution values never create sources.
// A transport visualization, not a concentration or atmospheric model.
import { attachFluidCPU } from "./fluid.js";
import { analysisDeltaSeconds, windForcingGrid } from "./flowfield.js";
import { WEATHER_DYE_FRAGMENT_SHADER } from "./smoke-policy.js";

const SIM = 128, DYE = 256, PRESSURE_ITERS = 20;
const CURL = 10, VEL_DISSIPATION = 0.15, DYE_DISSIPATION = [0.5, 0.4, 0.3]; // per second (unused heat, source, moisture)

const VERT = `#version 300 es
precision highp float;
in vec2 aPos; out vec2 vUv, vL, vR, vT, vB; uniform vec2 texel;
void main(){ vUv = aPos*0.5+0.5; vL = vUv-vec2(texel.x,0.); vR = vUv+vec2(texel.x,0.); vT = vUv+vec2(0.,texel.y); vB = vUv-vec2(0.,texel.y); gl_Position = vec4(aPos,0.,1.); }`;
const FRAG = {
  splat: `uniform sampler2D target; uniform vec2 point; uniform vec3 color; uniform float radius;
    void main(){ vec2 p = vUv-point; o = vec4(texture(target,vUv).xyz + exp(-dot(p,p)/radius)*color, 1.); }`,
  advect: `uniform sampler2D velocity, source; uniform vec2 simTexel; uniform float dt; uniform vec3 dissipation;
    void main(){ vec2 c = vUv - dt*texture(velocity,vUv).xy*simTexel; vec4 r = texture(source,c); o = vec4(r.xyz/(1.0+dissipation*dt), 1.); }`,
  wind: `uniform sampler2D velocity, windField; uniform vec2 wind; uniform float k, useField;
    void main(){ vec2 v = texture(velocity,vUv).xy; vec3 sampleWind=texture(windField,vUv).xyz;
      vec2 force=useField>0.5?(sampleWind.z>0.99?sampleWind.xy:vec2(0)):wind;
      o = vec4(v + (force-v)*k, 0., 1.); }`,
  curl: `uniform sampler2D velocity;
    void main(){ float L=texture(velocity,vL).y, R=texture(velocity,vR).y, T=texture(velocity,vT).x, B=texture(velocity,vB).x; o = vec4(0.5*(R-L-T+B),0.,0.,1.); }`,
  vorticity: `uniform sampler2D velocity, curl; uniform float strength, dt;
    void main(){ float L=texture(curl,vL).x, R=texture(curl,vR).x, T=texture(curl,vT).x, B=texture(curl,vB).x, C=texture(curl,vUv).x;
      vec2 f = 0.5*vec2(abs(T)-abs(B), abs(R)-abs(L)); f /= length(f)+1e-4; f *= strength*C; f.y *= -1.0;
      o = vec4(texture(velocity,vUv).xy + f*dt, 0., 1.); }`,
  divergence: `uniform sampler2D velocity;
    void main(){ float L=texture(velocity,vL).x, R=texture(velocity,vR).x, T=texture(velocity,vT).y, B=texture(velocity,vB).y; o = vec4(0.5*(R-L+T-B),0.,0.,1.); }`,
  clear: `uniform sampler2D tex; uniform float value; void main(){ o = value*texture(tex,vUv); }`,
  pressure: `uniform sampler2D pressure, divergence;
    void main(){ float L=texture(pressure,vL).x, R=texture(pressure,vR).x, T=texture(pressure,vT).x, B=texture(pressure,vB).x, d=texture(divergence,vUv).x;
      o = vec4((L+R+B+T-d)*0.25,0.,0.,1.); }`,
  gradient: `uniform sampler2D pressure, velocity;
    void main(){ float L=texture(pressure,vL).x, R=texture(pressure,vR).x, T=texture(pressure,vT).x, B=texture(pressure,vB).x;
      o = vec4(texture(velocity,vUv).xy - vec2(R-L,T-B), 0., 1.); }`,
  display: WEATHER_DYE_FRAGMENT_SHADER,
};

function createGL(size) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
  const gl = canvas.getContext("webgl2", { powerPreference: "high-performance", alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) {gl?.getExtension('WEBGL_lose_context')?.loseContext();return null;}
  return { canvas, gl };
}

function program(gl, fragBody) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 o;
${fragBody}`));
  gl.bindAttribLocation(p, 0, "aPos"); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

function fbo(gl, w, h) {
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fb, w, h };
}
const double = (gl, w, h) => { const d = { read: fbo(gl, w, h), write: fbo(gl, w, h), swap() { [d.read, d.write] = [d.write, d.read]; } }; return d; };

export function attachFluid(viewer, site, opts = {}) {
  const ctx = createGL(DYE);
  if (!ctx) { console.warn("Cloud Shadow: WebGL2 float targets unavailable, using CPU fluid"); return attachFluidCPU(viewer, site, opts); }
  let P;
  try { P = Object.fromEntries(Object.entries(FRAG).map(([k, f]) => [k, program(ctx.gl, f)])); }
  catch (e) {ctx.gl.getExtension('WEBGL_lose_context')?.loseContext();console.warn("Cloud Shadow: GPU fluid shaders failed, using CPU fluid", e); return attachFluidCPU(viewer, site, opts); }
  const { gl, canvas } = ctx;
  const halfSizeM = opts.halfSizeM ?? 16000, texEvery = opts.texEvery ?? 1;

  // full-screen quad
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(0);
  const vel = double(gl, SIM, SIM), dye = double(gl, DYE, DYE), prs = double(gl, SIM, SIM);
  const div = fbo(gl, SIM, SIM), crl = fbo(gl, SIM, SIM);
  const forcing=fbo(gl,16,16),forcingPixels=new Float32Array(16*16*4);
  let sampleField=typeof opts.sampleWind==='function'?opts.sampleWind:null,lastField=-Infinity;
  const simTexel = [1 / SIM, 1 / SIM], dyeTexel = [1 / DYE, 1 / DYE];

  function run(prog, target, uniforms, texel = simTexel) {
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      const loc = prog.u[k]; if (loc == null) continue;
      if (v && v.tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.uniform1i(loc, unit++); }
      else if (Array.isArray(v)) (v.length === 2 ? gl.uniform2fv : gl.uniform3fv).call(gl, loc, v);
      else gl.uniform1f(loc, v);
    }
    if (prog.u.texel) gl.uniform2fv(prog.u.texel, texel);
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, DYE, DYE); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function splat(x, y, dx, dy, color, radius) {
    run(P.splat, vel.write, { target: vel.read, point: [x, y], color: [dx, dy, 0], radius }); vel.swap();
    run(P.splat, dye.write, { target: dye.read, point: [x, y], color, radius }, dyeTexel); dye.swap();
  }

  // Cesium side: double-buffered 2D canvases so the material re-uploads each update
  const out = [0, 1].map(() => { const c = document.createElement("canvas"); c.width = c.height = DYE; return c; });
  let front = 0;
  const dLat = halfSizeM / 111320, dLon = halfSizeM / (111320 * Math.cos(site.lat * Math.PI / 180));
  const entity = viewer.entities.add({
    rectangle: {
      coordinates: Cesium.Rectangle.fromDegrees(site.lon - dLon, site.lat - dLat, site.lon + dLon, site.lat + dLat), height: 25,
      material: new Cesium.ImageMaterialProperty({ image: new Cesium.CallbackProperty(() => out[front], false), transparent: true }),
    },
  });

  const W = { windE: 0, windN: 0, speed: 0, pollution: 0, moisture: 0, projected: 0 };
  let alive = true, visible = true, lastTime=Cesium.JulianDate.clone(viewer.clock.currentTime),frame = 0, t = 0;
  function loop() {
    if (!alive) return;
    const clock=viewer.clock,delta=Cesium.JulianDate.secondsDifference(clock.currentTime,lastTime);
    lastTime=Cesium.JulianDate.clone(clock.currentTime,lastTime);
    const dt=analysisDeltaSeconds(delta,clock.shouldAnimate!==false&&clock.multiplier!==0&&document.visibilityState!=='hidden');
    // Hidden close-up weather does no solver work or canvas texture uploads.
    if (!visible || dt === 0) return;
    frame++; t += dt;
    const stepScale = dt * 60;
    // velocity in sim texels/second (UV: +x east, +y north); NASA wind, time-lapsed
    const scale=SIM/(halfSizeM*2)*(opts.timeLapse??400),sp = W.speed * scale;
    const wind = [W.windE * sp, W.windN * sp];
    if(sampleField&&t-lastField>=.2){
      lastField=t;windForcingGrid(sampleField,site,{size:16,halfSizeM,units:scale},forcingPixels);
      gl.bindTexture(gl.TEXTURE_2D,forcing.tex);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,16,16,gl.RGBA,gl.FLOAT,forcingPixels);
    }
    run(P.wind, vel.write, { velocity: vel.read, windField:forcing, useField:sampleField?1:0, wind, k: Math.min(1, dt * 1.2) }); vel.swap();
    // Dye only comes from an explicit debug tracer. Annual precipitation/NO2
    // do not create edge-water dye, emissions or random momentum splats.
    // solver
    run(P.curl, crl, { velocity: vel.read });
    run(P.vorticity, vel.write, { velocity: vel.read, curl: crl, strength: CURL, dt }); vel.swap();
    run(P.divergence, div, { velocity: vel.read });
    run(P.clear, prs.write, { tex: prs.read, value: Math.pow(0.8, stepScale) }); prs.swap();
    for (let i = 0; i < PRESSURE_ITERS; i++) { run(P.pressure, prs.write, { pressure: prs.read, divergence: div }); prs.swap(); }
    run(P.gradient, vel.write, { pressure: prs.read, velocity: vel.read }); vel.swap();
    run(P.advect, vel.write, { velocity: vel.read, source: vel.read, simTexel, dt, dissipation: [VEL_DISSIPATION, VEL_DISSIPATION, VEL_DISSIPATION] }); vel.swap();
    run(P.advect, dye.write, { velocity: vel.read, source: dye.read, simTexel, dt, dissipation: DYE_DISSIPATION }, dyeTexel); dye.swap();
    // display → copy into the Cesium texture
    if (frame % texEvery === 0) {
      gl.clearColor(0, 0, 0, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT);
      run(P.display, null, { dye: dye.read, windDirection: [W.windE, W.windN], visualTime: t, projected: W.projected }, dyeTexel);
      const back = 1 - front, c2 = out[back].getContext("2d");
      c2.clearRect(0, 0, DYE, DYE); c2.drawImage(canvas, 0, 0);
      front = back;
    }
  }
  const removeLoop=viewer.scene.preRender.addEventListener(loop);
  console.info("Cloud Shadow fluid: GPU (WebGL2)", SIM + "² velocity /", DYE + "² dye");

  return {
    gpu: true,
    setVisible(value) { visible = !!value; entity.show = visible; lastTime=Cesium.JulianDate.clone(viewer.clock.currentTime,lastTime); },
    setWeather({ windTowardDeg, windSpeed, heat, pollution, moisture, projected }) {
      if (Number.isFinite(windTowardDeg)) { const th = windTowardDeg * Math.PI / 180; W.windE = Math.sin(th); W.windN = Math.cos(th); }
      else { W.windE = 0; W.windN = 0; }
      W.speed=Number.isFinite(windSpeed)&&windSpeed>=0?windSpeed:0;
      W.pollution = W.moisture = 0;
      W.projected = projected ? 1 : 0;
    },
    // wind only (time-varying GEOS-FP analysis wind); leaves the dye sources unchanged
    setWind(towardDeg, speed) {
      const th = Number.isFinite(towardDeg)?towardDeg*Math.PI/180:null;W.windE=th==null?0:Math.sin(th);W.windN=th==null?0:Math.cos(th);W.speed=Number.isFinite(speed)&&speed>=0?speed:0;
    },
    setWindField(sample){sampleField=typeof sample==='function'?sample:null;lastField=-Infinity;},
    injectTracer(x=.5,y=.5,amount=.15){splat(Math.max(0,Math.min(1,x)),Math.max(0,Math.min(1,y)),0,0,[0,0,Math.max(0,Math.min(1,amount))],.001);},
    dispose() { alive = false; removeLoop();viewer.entities.remove(entity); gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}
