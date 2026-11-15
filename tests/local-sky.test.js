import test from 'node:test';
import assert from 'node:assert/strict';
import {selectLocalSkyConfig,localSkyOpacity,skyPixelWeight,skyDirectionUV,updateSkyRayBasis,attachLocalSky,LOCAL_SKY_FRAGMENT_SHADER} from '../apps/web/js/local-sky.js';

test('precipitation selects explicitly illustrative presets and missing values never become observed clear weather',()=>{
  const clear=selectLocalSkyConfig({lat:35},{PrecipMMDay:0});assert.equal(clear.id,'clear');assert.equal(clear.weatherKnown,true);
  assert.equal(selectLocalSkyConfig({}, {PrecipMMDay:2}).id,'cloudy');assert.equal(selectLocalSkyConfig({}, {PrecipMMDay:8}).id,'overcast');
  assert.equal(selectLocalSkyConfig({}, {PrecipMMDay:1.58}).id,'clear');assert.equal(selectLocalSkyConfig({}, {PrecipMMDay:2.41}).id,'cloudy');assert.equal(selectLocalSkyConfig({}, {PrecipMMDay:4.03}).id,'overcast');
  assert.equal(selectLocalSkyConfig({}, {PrecipMMDay:2.41}).selectionBasis,'annual precipitation display cue');
  for(const raw of [null,undefined,'',-1,'missing']){const config=selectLocalSkyConfig({lat:65},{PrecipMMDay:raw});assert.equal(config.id,'clear');assert.equal(config.weatherKnown,false);assert.equal(config.precipitationMMDay,null);assert.equal(config.illustrative,true);}
  assert.equal(selectLocalSkyConfig({lat:65},{},'observed',{regionalFallback:true}).id,'cloudy');
  const future=selectLocalSkyConfig({}, {PrecipMMDay:8},'projected');assert.equal(future.phase,'projected');assert.match(future.caption,/cloud cover is not measured/);
});

test('only background pixels receive the sky, fading to native globe by8km without foreground fog',()=>{
  for(const depth of [0,.1,.5,.99,.999999])assert.equal(skyPixelWeight(depth,400),0);
  assert.equal(skyPixelWeight(1,400),1);assert.equal(skyPixelWeight(1,400,false),0);
  assert.equal(localSkyOpacity(5000),1);assert.equal(localSkyOpacity(6500),.5);assert.equal(localSkyOpacity(8000),0);assert.equal(localSkyOpacity(100000),0);
  assert.ok(LOCAL_SKY_FRAGMENT_SHADER.includes('if(depth<0.9999999 || u_opacity<=0.0)'));
  assert.ok(LOCAL_SKY_FRAGMENT_SHADER.includes('out_FragColor=base; return;'));
  assert.ok(LOCAL_SKY_FRAGMENT_SHADER.includes('u_rayBase+v_textureCoordinates.x*u_rayDx+v_textureCoordinates.y*u_rayDy'));
  assert.ok(!LOCAL_SKY_FRAGMENT_SHADER.includes('czm_inverseProjection'),'fullscreen pass projection must not become the camera ray');
});

test('actual world-space camera rays preserve a vertical sky gradient through an ENU/look-at transform',()=>{
  // World frame is deliberately rotated: ENU north is world+Z, ENU up is
  // world+Y. This catches accidental use of fullscreen identity camera state.
  const camera={directionWC:{x:0,y:0,z:1},getPickRay(pixel){const x=pixel.x/1000*2-1,up=(1-pixel.y/600*2)*.6;const length=Math.hypot(x,up,1);return {direction:{x:x/length,y:up/length,z:1/length}};}};
  const basis=updateSkyRayBasis(camera,1000,600,(d,out)=>Object.assign(out,{x:d.x,y:d.z,z:d.y}));
  const bottom=skyDirectionUV(basis.base),top=skyDirectionUV({x:basis.base.x+basis.dy.x,y:basis.base.y+basis.dy.y,z:basis.base.z+basis.dy.z});
  assert.ok(top.v-bottom.v>.10,'upper sky must sample multiple image rows, not the clamped horizon row');
  assert.equal(basis.base.z,-.6);assert.equal(basis.base.z+basis.dy.z,.6);assert.equal(basis.base.y,1);
  assert.equal(updateSkyRayBasis(camera,0,600,()=>{}),null);
});

test('Horizon-view elevations sample real upper-image clouds instead of the bundled uniform lower haze',()=>{
  const elevations=[0,5,10],imageRows=elevations.map((degrees)=>{const radians=degrees*Math.PI/180;return 1-skyDirectionUV({x:0,y:Math.cos(radians),z:Math.sin(radians)}).v;});
  assert.ok(imageRows.every((row)=>row<.44),'visible horizon sky stays above the builder haze fill beginning at image row0.44');
  assert.ok(imageRows[0]-imageRows[2]>.04,'visible sky samples a range of cloud rows');
  assert.ok(elevations.every((degrees)=>.5-degrees/180>.44),'legacy full-panorama mapping sampled only the flat haze band at these elevations');
  const full=skyDirectionUV({x:0,y:Math.cos(Math.PI/6),z:Math.sin(Math.PI/6)},0,.5);
  assert.ok(Math.abs(full.v-2/3)<1e-12,'a future full-sky asset can explicitly retain the native equirectangular hemisphere');
});

test('equirectangular directions follow local North/East/Up and never sample photographed ground',()=>{
  assert.equal(skyDirectionUV({x:0,y:1,z:0}).u,.5);assert.equal(skyDirectionUV({x:1,y:0,z:0}).u,.75);
  assert.equal(skyDirectionUV({x:-1,y:0,z:0}).u,.25);assert.equal(skyDirectionUV({x:0,y:0,z:1}).v,1);
  assert.equal(skyDirectionUV({x:0,y:1,z:0},90).u,.75);assert.ok(skyDirectionUV({x:0,y:0,z:-1}).v>.5);
  assert.equal(skyDirectionUV({x:0,y:0,z:0}),null);
});

function fake(){
  class V3{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(lon,lat){return new V3(lon,lat,0);}}
  class M4{static inverseTransformation(m,out){out.origin=m.origin;return out;}static multiplyByPoint(m,p,out){return Object.assign(out,p);}}
  class Stage{constructor(options){Object.assign(this,options);this.ready=false;this.dead=false;}destroy(){assert.equal(this.dead,false);this.dead=true;}isDestroyed(){return this.dead;}}
  const stages=[],listeners=new Set(),C={Cartesian3:V3,Matrix4:M4,Transforms:{eastNorthUpToFixedFrame:(origin)=>({origin})},PostProcessStage:Stage};
  const viewer={camera:{positionWC:new V3(0,0,500),positionCartographic:{height:500}},scene:{fog:{enabled:true,density:.1},preRender:{addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);}},postProcessStages:{add(s){stages.push(s);return s;},remove(s){const i=stages.indexOf(s);if(i<0)return false;stages.splice(i,1);s.destroy();return true;}}}};
  const manifest={environments:['clear','cloudy','overcast'].map((id)=>({id,image:'assets/sky/'+id+'.jpg',diffuseSH:[[1,1,1]]}))};
  return {C,viewer,stages,listeners,manifest,tick(){for(const fn of listeners)fn();}};
}

test('local sky uses ready assets only while active, preserves scene fog, and removes its stage/listener',async()=>{
  const h=fake(),environments=[],states=[],originalFog={...h.viewer.scene.fog};
  const sky=attachLocalSky(h.viewer,{lat:0,lon:0},{Cesium:h.C,center:{lat:39,lon:-77},skyManifest:h.manifest,onSkyEnvironment:(e)=>environments.push(e.id),onSkyState:(s)=>states.push(s)});
  assert.equal(h.stages.length,0);sky.setYear(2025,{PrecipMMDay:0});sky.setActive(true);await sky.ready;
  assert.equal(h.stages.length,1);const stage=h.stages[0];assert.equal(stage.textureScale,1);assert.equal(stage.uniforms.u_environment,'assets/sky/clear.jpg');
  assert.ok(stage.uniforms.u_rayBase());assert.ok(stage.uniforms.u_rayDy());assert.equal(environments.length,0);
  assert.equal(stage.uniforms.u_skyHorizonRow,.43);assert.ok(sky.state.rayBase&&sky.state.rayDx&&sky.state.rayDy);assert.ok(sky.state.topUV.v>sky.state.bottomUV.v);
  stage.ready=true;h.tick();assert.deepEqual(environments,['clear']);h.tick();assert.equal(environments.length,1);
  sky.setYear(2031,{PrecipMMDay:8},'projected');assert.equal(stage.uniforms.u_environment,'assets/sky/overcast.jpg');assert.equal(environments.length,1,'old readiness must not trigger the new IBL callback');
  stage.ready=false;h.tick();stage.ready=true;h.tick();assert.deepEqual(environments,['clear','overcast']);
  h.viewer.camera.positionCartographic.height=8000;h.tick();assert.equal(stage.enabled,false);assert.equal(stage.uniforms.u_opacity(),0);
  sky.setActive(false);sky.setYear(2020,{PrecipMMDay:2});h.tick();assert.equal(stage.enabled,false);assert.equal(environments.length,2);
  h.viewer.camera.positionCartographic.height=500;sky.setActive(true);h.tick();assert.equal(stage.enabled,true);assert.deepEqual(environments,['clear','overcast','cloudy']);
  assert.deepEqual(h.viewer.scene.fog,originalFog);assert.ok(states.every((s)=>s.illustrative));
  sky.destroy();sky.destroy();sky.setActive(true);assert.equal(h.stages.length,0);assert.equal(h.listeners.size,0);assert.equal(stage.dead,true);
});

test('destroying a pending manifest load cannot allocate a stale sky or call environment hooks',async()=>{
  const h=fake();let resolve,callbacks=0;
  const response=new Promise((r)=>resolve=r),sky=attachLocalSky(h.viewer,{lat:35,lon:-90},{Cesium:h.C,skyFetch:()=>response,onSkyEnvironment:()=>callbacks++});
  sky.setActive(true);const pending=sky.ready;sky.destroy();resolve({ok:true,json:async()=>h.manifest});await pending;
  assert.equal(h.stages.length,0);assert.equal(h.listeners.size,0);assert.equal(callbacks,0);
});
