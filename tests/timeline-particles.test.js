import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {plumeParticleAlpha} from '../apps/web/js/smoke-policy.js';

test('actual timeline callbacks accept Cesium Particle colors and render bounded fade-in/out alpha',()=>{
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
  const context={Cesium,plumeParticleAlpha,createSmokeSprite:()=>({}),FX:{buildSite(){}},window:{addEventListener(){}},document:{querySelector:()=>null},console};
  const source=readFileSync(new URL('../apps/web/js/timeline.js',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  runInNewContext(source+'\nglobalThis.makeEffects=(v,site)=>{viewer=v;T.site=site;applyYear=()=>{};buildEffects();return {wind:T.wind,plume:T.plume};};',context);
  const viewer={scene:{primitives:{add:(p)=>p,remove(){}}}},systems=context.makeEffects(viewer,{lat:35,lon:-90,effects:{plume:true}});
  for(const [name,system] of Object.entries(systems)){
    const particle={velocity:new Cartesian3(),age:0,life:12,startColor:{...system.startColor},endColor:{...system.endColor}},alphas=[];
    // Cesium 1.121 updateBillboard lerps startColor/endColor at normalizedAge.
    for(const age of [0,1,3,6,9,12]){
      particle.age=age;assert.doesNotThrow(()=>system.updateCallback(particle,.016));
      const t=age/particle.life,rendered=particle.startColor.alpha*(1-t)+particle.endColor.alpha*t;
      const expected=name==='plume'?plumeParticleAlpha(age,12):age===0||age===12?0:Math.sin(Math.PI*t)*.055;
      assert.ok(Math.abs(rendered-expected)<1e-12);
      assert.ok(Number.isFinite(rendered)&&rendered>=0&&rendered<=(name==='plume'?.16:.055));alphas.push(rendered);
      assert.equal('color' in particle,false,'callbacks must update the colors that Cesium actually renders');
    }
    assert.equal(alphas[0],0);assert.ok(alphas[2]>0);assert.equal(alphas.at(-1),0);
    if(name==='plume')assert.ok(alphas[4]<alphas[2],'downwind smoke must taper rather than remain opaque');
  }
});
