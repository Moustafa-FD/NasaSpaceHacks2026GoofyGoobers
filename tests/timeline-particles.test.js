import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {resolveWindReadout} from '../apps/web/js/flowfield.js';

test('timeline creates no duplicate wind streak or macro plume particle systems',()=>{
  class Cartesian3{
    constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
    static fromDegrees(x,y,z=0){return new Cartesian3(x,y,z);}
    static clone(a,out=new Cartesian3()){return Object.assign(out,a);}
    static normalize(a,out){const n=Math.hypot(a.x,a.y,a.z)||1;out.x=a.x/n;out.y=a.y/n;out.z=a.z/n;return out;}
    static add(a,b,out){out.x=a.x+b.x;out.y=a.y+b.y;out.z=a.z+b.z;return out;}
    static multiplyByScalar(a,n,out){out.x=a.x*n;out.y=a.y*n;out.z=a.z*n;return out;}
    static lerp(a,b,t,out){out.x=a.x+(b.x-a.x)*t;out.y=a.y+(b.y-a.y)*t;out.z=a.z+(b.z-a.z)*t;return out;}
  }
  class Color{
    constructor(red=1,green=1,blue=1,alpha=1){Object.assign(this,{red,green,blue,alpha});}
    withAlpha(alpha){return new Color(this.red,this.green,this.blue,alpha);}
    static fromCssColorString(hex){return new Color(...[1,3,5].map((i)=>parseInt(hex.slice(i,i+2),16)/255));}
  }
  Color.WHITE=new Color();
  const Cesium={Cartesian3,Color,Cartesian2:class{},BoxEmitter:class{},ConeEmitter:class{},ParticleSystem:class{constructor(options){Object.assign(this,options);}},
    Math:{toRadians:(n)=>n*Math.PI/180},Transforms:{eastNorthUpToFixedFrame:()=>({})},Matrix4:{multiplyByPointAsVector:(_,p,out)=>Cartesian3.clone(p,out)}};
  let builds=0;
  const context={Cesium,resolveWindReadout,FX:{buildSite(){builds++;}},window:{addEventListener(){}},document:{querySelector:()=>null},console};
  const source=readFileSync(new URL('../apps/web/js/timeline.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  runInNewContext(source+'\nglobalThis.makeEffects=(v,site)=>{viewer=v;T.site=site;applyYear=()=>{};buildEffects();return {wind:T.wind,plume:T.plume};};',context);
  const viewer={scene:{primitives:{add(){throw new Error('Duplicate globe particles');},remove(){}}}},systems=context.makeEffects(viewer,{lat:35,lon:-90,effects:{plume:true}});
  assert.equal(systems.wind,null);assert.equal(systems.plume,null);assert.equal(builds,1);
});

test('timeline exposes only the active GEOS wind number and labels projected climatology explicitly',()=>{
  const context={resolveWindReadout,window:{addEventListener(){}},document:{querySelector:()=>null},console};
  const source=readFileSync(new URL('../apps/web/js/timeline.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  runInNewContext(source+'\nglobalThis.markup=(r,p,a)=>{T.analysedWind=a;return windMarkup(r,p);};',context);
  const row={WS10M:4.7,PlumeTowardDeg:270},analysis={speed:2.4,towardDeg:90,time:'2025-07-01T12:00:00Z'};
  const html=context.markup(row,'observed',analysis);
  assert.equal((html.match(/m\/s/g)||[]).length,1);assert.match(html,/GEOS-FP analysis/);
  assert.match(html,/2\.4 m\/s/);assert.match(html,/2025-07-01 12:00Z/);assert.doesNotMatch(html,/POWER|4\.7 m\/s/);
  const projected=context.markup(row,'projected',analysis);
  assert.match(projected,/Illustrative wind/);assert.match(projected,/not a NASA observation/);assert.doesNotMatch(projected,/GEOS-FP/);
});

test('2050 and 2090 select climate periods without extrapolated site rows, wind or vegetation decline',()=>{
  const nodes=new Map(),events=[];
  const element=id=>{if(!nodes.has(id))nodes.set(id,{setAttribute(){},textContent:'',innerHTML:''});return nodes.get(id);};
  const context={resolveWindReadout,FX:{applyYear(){}},window:{addEventListener(){},dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,options){Object.assign(this,{type,...options});}},document:{querySelector:element,body:{classList:{toggle(){}}}},console};
  const source=readFileSync(new URL('../apps/web/js/timeline.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  runInNewContext(source+`\nsetGround=()=>{};renderTrendStrip=()=>{};CS={};T.site={id:'a'};globalThis.change=(year)=>{T.rows.set(year,{NDVI_Site:0,WS10M:99,PlumeTowardDeg:180,Phase:'observed'});setYear(year);};`,context);
  for(const year of [2050,2090]){
    context.change(year);
    const event=events.at(-1);assert.equal(event.type,'cs:year');assert.equal(event.detail.year,year);
    assert.equal(event.detail.phase,'climate');assert.equal(Object.keys(event.detail.row).length,0);
    assert.equal(event.detail.health,1);assert.equal(element('#tlPhase').textContent,'CLIMATE SCENARIO · PERIOD SUMMARY');
    assert.doesNotMatch(element('#tlChips').innerHTML,/99\.0 m\/s|GEOS-FP|POWER annual/);
  }
  context.change(2200);assert.equal(events.at(-1).detail.year,2100);
});
