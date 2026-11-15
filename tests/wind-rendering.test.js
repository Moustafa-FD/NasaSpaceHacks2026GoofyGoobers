import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleWind,siteWindAt,attachFlow,analysisDeltaSeconds,resolveWindReadout,windForcingGrid,flowBudget} from '../apps/web/js/flowfield.js';
import {attachFluidCPU} from '../apps/web/js/fluid.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const event=()=>{const listeners=new Set();return {listeners,addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);},raise(){for(const fn of listeners)fn();}};};
const field=()=>({m:{grid:{nx:2,ny:2,latMin:0,latMax:1,lonMin:0,lonMax:1},frames:[{time:'2025-01-01T00:00:00Z'},{time:'2025-02-01T00:00:00Z'}],siteSeries:[{u:2,v:0,time:'2025-01-01T00:00:00Z'},{u:0,v:2,time:'2025-02-01T00:00:00Z'}]},frames:[{u:[1,3,5,7],v:[0,0,0,0],ok:[1,1,1,1]},{u:[11,13,15,17],v:[0,0,0,0],ok:[1,1,1,1]}]});
function browser(t){
  const old={window:globalThis.window,document:globalThis.document,Cesium:globalThis.Cesium,CustomEvent:globalThis.CustomEvent,location:globalThis.location};
  globalThis.window=new EventTarget();globalThis.document={visibilityState:'visible'};globalThis.location={search:''};
  globalThis.CustomEvent=class extends Event{constructor(type,{detail}){super(type);this.detail=detail;}};
  globalThis.Cesium={JulianDate:{clone:value=>value,secondsDifference:(a,b)=>a-b}};
  t.after(()=>{for(const [key,value]of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  return {clock:{currentTime:0,shouldAnimate:true,multiplier:.35},camera:{positionCartographic:{height:100000}},scene:{preRender:event()}};
}

test('gridded wind interpolation preserves frame orientation and ignores only zero-weight missing neighbours',()=>{
  const data=field();assert.equal(sampleWind(data,.5,.5,.5).u,9);
  assert.equal(sampleWind(data,.5,.5,-.5).u,9);assert.equal(sampleWind(data,2,0,0),null);
  data.frames[0].ok=[1,0,0,0];data.frames[1].ok=[0,0,0,0];
  assert.equal(sampleWind(data,1,0,0).u,1,'exact valid source sample does not depend on missing unused neighbours');
  assert.equal(sampleWind(data,.5,.5,0),null);data.m.siteSeries[1].v=null;
  assert.equal(siteWindAt(data,0).speed,2);assert.equal(siteWindAt(data,.5),null);
});

test('one readout selects model analysis or explicitly labelled annual/climatology fallback',()=>{
  const row={WS10M:5,PlumeTowardDeg:180};
  assert.equal(resolveWindReadout(row,'observed',{speed:2,towardDeg:90}).speed,2);
  assert.equal(resolveWindReadout(row,'observed').label,'POWER annual mean');
  assert.equal(resolveWindReadout(row,'projected',{speed:2,towardDeg:90}).label,'Illustrative wind');
  assert.equal(resolveWindReadout({WS10M:5},'observed'),null);
  assert.equal(analysisDeltaSeconds(.1),.1);assert.equal(analysisDeltaSeconds(100000),0);
  assert.equal(analysisDeltaSeconds(.1,false),0);assert.ok(flowBudget('low').site<flowBudget('high').site);
});

test('forcing grids retain geographic variation and north/south conventions without filling missing data',()=>{
  const sample=(lat,lon)=>lon<0?null:{u:lon,v:lat};
  const north=windForcingGrid(sample,{lat:0,lon:0},{size:2,halfSizeM:111320,units:2});
  assert.equal(north[2],0);assert.equal(north[6],1);assert.equal(north[4],1);assert.equal(north[5],-1);assert.equal(north[13],1);
  const image=windForcingGrid(sample,{lat:0,lon:0},{size:2,halfSizeM:111320,units:2,northFirst:true});
  assert.equal(image[5],-1);assert.equal(image[13],1);
});

test('GEOS trails use the shared clock once, hide locally, pause and release listeners/resources',async(t)=>{
  const viewer=browser(t),layers=[],messages=[];
  window.addEventListener('cs:wind',event=>messages.push(event.detail));
  const flow=attachFlow(viewer,{loadIndex:async()=>({products:[{id:'site',kind:'site',site:'a',year:2025},{id:'globe',kind:'global',year:2025}]}),loadField:async()=>field(),createLayer:(_field,options)=>{const layer={show:true,options,steps:[],disposed:false,step(...args){this.steps.push(args);},dispose(){this.disposed=true;}};layers.push(layer);return layer;}});
  await flow.setYear({id:'a',lat:.5,lon:.5},2025,'observed');
  assert.equal(messages.length,1);assert.equal(messages[0].source,'NASA GEOS-FP analysis');
  assert.ok(messages[0].sampleWind(.5,.5));assert.equal(layers.length,2);
  viewer.clock.currentTime=.1;viewer.scene.preRender.raise();
  assert.equal(flow.state.t,.05,'clock delta is already motion-scaled; no second multiplier');
  assert.equal(layers[0].steps.length,1);assert.equal(layers[1].steps.length,0);
  viewer.clock.shouldAnimate=false;viewer.clock.currentTime=.2;viewer.scene.preRender.raise();assert.equal(flow.state.t,.05);
  viewer.clock.shouldAnimate=true;window.dispatchEvent(new CustomEvent('cs:scene-mode',{detail:{active:true}}));
  assert.ok(layers.every(layer=>!layer.show));viewer.clock.currentTime=.3;viewer.scene.preRender.raise();assert.equal(layers[0].steps.length,1);
  const before=flow.state.t;viewer.clock.currentTime=10000;viewer.scene.preRender.raise();assert.equal(flow.state.t,before,'year/light jumps do not advect weather');
  const shown=layers.length;
  await flow.setYear({id:'a',lat:.5,lon:.5},2035,'projected');
  assert.ok(layers.slice(0,shown).every(layer=>layer.disposed),'the previously shown year is removed');
  assert.equal(flow.state.referenceYear,2025,'future years load the labelled reference year');assert.ok(flow.state.siteField,'reference-year trails are drawn');
  flow.dispose();assert.equal(viewer.scene.preRender.listeners.size,0);
});

test('site/year changes ignore late product loads and never retain previous-year trails on future years',async(t)=>{
  const viewer=browser(t),layers=[],states=[];let release;
  window.addEventListener('cs:wind-state',event=>states.push(event.detail));
  const gate=new Promise(resolve=>{release=resolve;});
  const flow=attachFlow(viewer,{loadIndex:async()=>({products:[{id:'a',kind:'site',site:'a',year:2025}]}),loadField:()=>gate,createLayer:()=>{layers.push({});return {dispose(){},show:true};}});
  const old=flow.setYear({id:'a',lat:0,lon:0},2025,'observed');await Promise.resolve();
  const future=flow.setYear({id:'a',lat:0,lon:0},2035,'projected');release(field());await old;await future;
  assert.equal(flow.state.referenceYear,2025,'future years show the latest complete analysed year as a reference');
  assert.match(states.find(s=>s.year===2035).reason,/no wind forecast exists/);
  assert.equal(layers.length,1,'one layer: the reference year, not a stale late load of the old request');flow.dispose();
});

test('CPU fluid: precipitation never makes dye; pollution dye starts only at the facility; pauses and disposes',t=>{
  const viewer=browser(t),images=[],entities=[];
  document.createElement=()=>({width:0,height:0,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>images.push(image.data.slice())})});
  Object.assign(Cesium,{Rectangle:{fromDegrees:(...values)=>values},ImageMaterialProperty:class{constructor(options){Object.assign(this,options);}},CallbackProperty:class{constructor(callback){this.getValue=callback;}}});
  viewer.entities={add(entity){entities.push(entity);return entity;},remove(entity){entities.splice(entities.indexOf(entity),1);}};
  const fluid=attachFluidCPU(viewer,{lat:0,lon:0});
  fluid.setWeather({windTowardDeg:90,windSpeed:2,pollution:0,moisture:2});
  for(let i=1;i<=12;i++){viewer.clock.currentTime=i*.05;viewer.scene.preRender.raise();}
  assert.ok(images.length>0);assert.ok(images.at(-1).every((value,index)=>index%4!==3||value===0),'precipitation never creates dye');
  fluid.setWeather({windTowardDeg:90,windSpeed:2,pollution:.8,moisture:2});
  for(let i=13;i<=24;i++){viewer.clock.currentTime=i*.05;viewer.scene.preRender.raise();}
  const last=images.at(-1),side=Math.round(Math.sqrt(last.length/4));
  assert.ok(last.some((value,index)=>index%4===3&&value>0),'facility pollution dye is visible');
  for(let k=0;k<side;k++)for(const [x,y] of [[k,0],[k,side-1],[0,k],[side-1,k]])assert.equal(last[(y*side+x)*4+3],0,'texture borders stay transparent');
  const count=images.length;viewer.clock.multiplier=0;viewer.clock.currentTime=1.2;viewer.scene.preRender.raise();assert.equal(images.length,count);
  fluid.dispose();assert.equal(entities.length,0);assert.equal(viewer.scene.preRender.listeners.size,0);
});

test('globe FX builds bounded cloud/rain primitives without weather rectangles or invented campus blocks',()=>{
  class Vector{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(x,y,z){return new Vector(x,y,z);}}
  class Options{constructor(options){Object.assign(this,options);}}
  const primitives=[],entities=[];
  const Cesium={Cartesian3:Vector,Cartesian2:Vector,DirectionalLight:Options,CloudCollection:class{add(options){return options;}},ParticleSystem:Options,BoxEmitter:Vector,
    Color:{fromCssColorString:()=>({withAlpha:()=>({})})},Transforms:{eastNorthUpToFixedFrame:()=>({})},Matrix4:{multiplyByPoint:(_,point)=>point},JulianDate:{fromDate:()=>1},Math:{toRadians:n=>n*Math.PI/180}};
  const viewer={clock:{currentTime:0},scene:{globe:{},skyAtmosphere:{},primitives:{add(value){primitives.push(value);return value;},remove(value){primitives.splice(primitives.indexOf(value),1);}}},entities:{add(value){entities.push(value);throw new Error('No site-sized planes or arbitrary massing');},remove(){}}};
  const fluidCalls=[],weather=[];
  const context={attachFluid:(v,site)=>{fluidCalls.push(site.id);return {setWeather(w){weather.push(w);},setWindField(){},setWind(){},setVisible(){},dispose(){}};},Cesium,analysisDeltaSeconds,referenceSunDirection:()=>[1,0,0],getMotionSpeed:()=>.35,window:{addEventListener(){},dispatchEvent(){}},CustomEvent:class{},document:{createElement:()=>({getContext:()=>({createLinearGradient:()=>({addColorStop(){}}),fillRect(){}})})},console};
  const source=readFileSync(new URL('../apps/web/js/fx.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'').replace(/export /g,'');
  runInNewContext(source+`\nglobalThis.hooks={build(v){viewer=v;scene=v.scene;S.nightLights={};buildSite({id:'a',lat:35,lon:-90,onset:'2020',effects:{plume:true}},new Map());},applyYear,setLight,get state(){return S;}};`,context);
  context.hooks.build(viewer);
  // Pollution fluid exists only for documented on-site combustion sites (effects.plume).
  assert.equal(entities.length,0);assert.equal(primitives.length,2);assert.deepEqual(fluidCalls,['a']);assert.ok(context.hooks.state.fluid);
  assert.equal(context.hooks.state.massing.length,0);
  context.hooks.applyYear(2025,{PrecipMMDay:8,T2M:60,NO2_OMI_Local:999,WS10M:3,PlumeTowardDeg:90},'observed');
  assert.ok(context.hooks.state.rain.emissionRate<=180);
  assert.equal(viewer.scene.skyAtmosphere.hueShift,0);
  assert.ok(weather.at(-1).pollution>0&&weather.at(-1).pollution<=1,'observed years after onset release facility dye');
  context.hooks.applyYear(2050,{},'climate');
  assert.equal(context.hooks.state.rain.emissionRate,0);assert.equal(context.hooks.state.windSpeed,0);
  assert.equal(weather.at(-1).pollution,0,'scenario years never release dye');assert.equal(primitives.length,2);
  // Advancing/rewinding data years and switching day/night must never move the
  // native simulation clock: that formerly caused millions of plume emissions.
  Object.defineProperty(viewer.clock,'currentTime',{get:()=>123,set(){throw new Error('Lighting jumped the native particle clock');}});
  for(const year of [2003,2024,2025,2026,2035,2100,2023])context.hooks.applyYear(year,{},year>2026?'projected':'observed');
  context.hooks.setLight('night',2100);context.hooks.setLight('golden',2003);
  assert.equal(viewer.clock.currentTime,123);
  context.hooks.state.localScene=true;const localLight=viewer.scene.light;
  context.hooks.setLight('night');assert.equal(viewer.scene.light,localLight);assert.equal(localLight.intensity,.35);
});

test('reference wind year: latest complete analysed year for the site, never a future year', async () => {
  const { referenceWindYear } = await import('../apps/web/js/flowfield.js');
  const index={products:[2018,2025,2026].map(year=>({kind:'site',site:'a',year})).concat([{kind:'site',site:'b',year:2024}])};
  assert.equal(referenceWindYear(index,'a',2026),2025);
  assert.equal(referenceWindYear(index,'a',2030),2026);
  assert.equal(referenceWindYear({products:[]},'a',2026),null);
});

test('scrubbing through future years keeps one set of reference-year trails', async (t) => {
  const viewer=browser(t);let built=0;
  const flow=attachFlow(viewer,{loadIndex:async()=>({products:[{id:'s',kind:'site',site:'a',year:2025}]}),loadField:async()=>field(),createLayer:()=>{built++;return {show:true,dispose(){},step(){}};}});
  await flow.setYear({id:'a',lat:.5,lon:.5},2030,'projected');
  await flow.setYear({id:'a',lat:.5,lon:.5},2031,'projected');
  await flow.setYear({id:'a',lat:.5,lon:.5},2060,'climate');
  assert.equal(built,1,'layers built once');assert.equal(flow.state.year,2060);assert.equal(flow.state.referenceYear,2025);
  await flow.setYear({id:'a',lat:.5,lon:.5},2025,'observed');
  assert.equal(built,2,'an observed year rebuilds from its own analysis');
  flow.dispose();
});

test('future-year wind readout names the reference year', async () => {
  const { resolveWindReadout } = await import('../apps/web/js/flowfield.js');
  const r = resolveWindReadout({}, 'climate', { speed: 3, towardDeg: 10, reference: true, referenceYear: 2025 });
  assert.equal(r.label, 'GEOS-FP 2025 pattern'); assert.match(r.title, /No wind forecast exists/);
});
