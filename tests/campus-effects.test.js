import test from "node:test";
import assert from "node:assert/strict";
import { emissionPolicy, attachCampusEffects } from "../apps/web/js/campus-effects.js";

const documented = { onset: "2024-06", effects: { plume: true } };
test("emission traces require explicit documented combustion and its onset year", () => {
  assert.equal(emissionPolicy(documented, 2023).eligible, false);
  assert.equal(emissionPolicy(documented, 2024).eligible, true);
  for (const site of [{ effects: { plume: false }, onset: "2024-06" }, { effects: { plume: "true" }, onset: "2024-06" }, { effects: { plume: true } }]) {
    assert.equal(emissionPolicy(site, 2026).emissionRate, 0);
  }
  assert.equal(emissionPolicy(documented, null).eligible, false);
  const a = emissionPolicy(documented, 2025, { WS10M: 4, PlumeTowardDeg: 450, NO2_Local: 9999 });
  const b = emissionPolicy(documented, 2025, { WS10M: 4, PlumeTowardDeg: 450, NO2_Local: 0 });
  assert.deepEqual(a, b, "NO₂ is not converted to invented visible smoke");
  assert.equal(a.windTowardDeg, 90); assert.equal(a.windSpeedMs, 4);
  assert.equal(emissionPolicy(documented, 2025, { WS10M: 4 }).windSpeedMs, 0, "missing direction must not invent a north wind");
});

test("local sources are bounded, lazy, pause via the existing clock, and clean up", () => {
  const savedCesium = globalThis.Cesium, savedDocument = globalThis.document;
  class Cartesian3 {
    constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
    static fromDegrees(x, y, z = 0) { return new Cartesian3(x, y, z); }
    static clone(value, target = new Cartesian3()) { return Object.assign(target, value); }
  }
  class Matrix4 {
    static multiplyByTranslation(frame, point, target) { return Object.assign(target, point); }
    static multiplyByPointAsVector(frame, point, target) { return Object.assign(target, point); }
  }
  let destructions = 0;
  const live = [];
  globalThis.Cesium = { Cartesian3, Matrix4, Cartesian2: class { constructor(x,y) {Object.assign(this,{x,y});} },
    Color: class { constructor(r,g,b,alpha) {this.alpha=alpha;} }, CircleEmitter: class {},
    Transforms:{eastNorthUpToFixedFrame:()=>new Matrix4()}, ParticleSystem:class {constructor(options){Object.assign(this,options);} destroy(){destructions++;}} };
  globalThis.document = {createElement:()=>({getContext:()=>({createRadialGradient:()=>({addColorStop(){}}),fillRect(){}})})};
  const viewer = {scene:{primitives:{add:(value)=>{live.push(value);return value;},remove:(value)=>{live.splice(live.indexOf(value),1);value.destroy();}}}};
  try {
    const sceneData = {center:{lat:35,lon:-90},elevation:{width:2,height:2,extentM:[-1000,-1000,1000,1000],heights:[100,100,100,100]},campuses:[{id:'far',x:900,y:900,width:300,depth:90,height:1000},{id:'near',x:0,y:0,width:180,depth:60,height:700}]};
    const effects = attachCampusEffects(viewer,documented,sceneData);
    effects.setYear(2023,{WS10M:4,PlumeTowardDeg:90}); effects.setActive(true);
    assert.equal(live.length,0,'before onset must not allocate or emit particles');
    effects.setYear(2025,{WS10M:4,PlumeTowardDeg:90});
    assert.equal(live.length,3); assert.ok(live.every((source)=>source.show&&source.emissionRate===4));
    assert.ok(live.reduce((sum,source)=>sum+source.emissionRate*source.maximumParticleLife,0)<=225);
    assert.ok(live.every((source)=>source.modelMatrix.z>109&&source.modelMatrix.z<111),'terrain elevation plus six-meter stack must not use building height');
    const particle={velocity:new Cartesian3(),age:4,life:12,color:{alpha:0}};
    live[0].updateCallback(particle);
    assert.ok(Math.abs(particle.velocity.x-5.6)<1e-8); assert.ok(Math.abs(particle.velocity.y)<1e-8); assert.equal(particle.velocity.z,2.6);
    effects.setActive(false); assert.ok(live.every((source)=>!source.show&&source.emissionRate===0));
    effects.setYear(2030,{WS10M:2,PlumeTowardDeg:0},'projected'); effects.setActive(true);
    assert.ok(live.every((source)=>source.emissionRate===3));
    effects.destroy(); effects.destroy(); effects.setActive(true); effects.setYear(2026,{});
    assert.equal(live.length,0); assert.equal(destructions,3);
    const noCombustion=attachCampusEffects(viewer,{onset:'2020',effects:{plume:false}},sceneData);
    noCombustion.setActive(true); noCombustion.setYear(2026,{}); assert.equal(live.length,0); noCombustion.destroy();
  } finally {globalThis.Cesium=savedCesium;globalThis.document=savedDocument;}
});
