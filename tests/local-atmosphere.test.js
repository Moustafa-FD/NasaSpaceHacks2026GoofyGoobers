import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLocalAtmosphere, localAtmosphereState, distanceFogFactor, sceneBoundaryFogFactor, eyeDistanceFromDepth, cloudProximityFade, localWeatherPolicy, LOCAL_FOG_FRAGMENT_SHADER } from '../apps/web/js/local-atmosphere.js';

test('clouds fade away before street-level close-ups and remain subtle in overview',()=>{
  for(const h of [0,100,299,300])assert.equal(localAtmosphereState(h,3300).cloudAlpha,0);
  assert.ok(localAtmosphereState(600,3300).cloudAlpha>0);
  assert.ok(localAtmosphereState(1000,3300).cloudAlpha<=0.16);
  assert.ok(localAtmosphereState(5800,3300).cloudAlpha>0);
  assert.equal(localAtmosphereState(6500,3300).cloudAlpha,0);
  assert.equal(cloudProximityFade(100,600),0);
  assert.equal(cloudProximityFade(3000,600),1);
  assert.equal(cloudProximityFade(NaN),0);
});

test('edge-aware fog hides distant geometry while preserving the high camera foreground',()=>{
  const nearEdge=localAtmosphereState(200,200),center=localAtmosphereState(200,3300);
  assert.equal(nearEdge.fogHorizontalNearM,1000);
  assert.equal(nearEdge.fogHorizontalFarM,2400);
  assert.ok(Math.abs(center.fogHorizontalFarM-3630)<1e-8);
  assert.equal(center.fogHorizontalNearM,1485);
  assert.ok(nearEdge.fogFarM<center.fogFarM);
  const overview=localAtmosphereState(5800,3300);
  assert.ok(overview.fogNearM>5800);
  assert.equal(distanceFogFactor(5800,overview),0,'camera altitude alone must not fog every ground pixel');
  assert.equal(distanceFogFactor(overview.fogFarM+100,overview),overview.fogStrength);
  assert.ok(overview.fogStrength<localAtmosphereState(800,3300).fogStrength);
  assert.equal(localAtmosphereState(9000,3300).fogStrength,0);
  const invalid=localAtmosphereState(NaN,Infinity);
  assert.ok(Number.isFinite(invalid.fogNearM)&&Number.isFinite(invalid.fogFarM));
  assert.equal(invalid.cloudAlpha,0);
});

test('haze cannot obscure the foreground or become an opaque sheet at a scene edge',()=>{
  for(const height of [0,50,120,300,500,1200,5800])for(const edge of [-2000,0,200,1000,3300]){
    const state=localAtmosphereState(height,edge);
    assert.ok(state.fogFarM>state.fogNearM+100);
    assert.equal(distanceFogFactor(Math.hypot(height,999),state),0,'nearby scenery stays clear even outside the patch');
    assert.ok(distanceFogFactor(1e8,state)<=.35,'at least 65 percent of the scene remains visible at any depth');
    if(height<=120)assert.equal(state.fogStrength,0,'street-level inspection must stay clear');
    if(height<=400)assert.equal(state.cloudAlpha,0,'close-up clouds cannot cover buildings');
  }
});

test('quality budgets support the app balanced tier without changing geometric fog distances',()=>{
  assert.equal(localAtmosphereState(1000,3300,'low').cloudCount,2);
  assert.equal(localAtmosphereState(1000,3300,'balanced').cloudCount,4);
  assert.equal(localAtmosphereState(1000,3300,'high').cloudCount,6);
  assert.equal(localAtmosphereState(1000,3300,'low').fogFarM,localAtmosphereState(1000,3300,'high').fogFarM);
});

test('spatial boundary haze blends distant cutoff edges while leaving the center and nearby streets clear',()=>{
  for(const height of [30,120,500,2000,5800]){
    const state=localAtmosphereState(height,3300),camera={x:0,y:0};
    assert.equal(sceneBoundaryFogFactor({x:0,y:0},camera,state),0);
    assert.equal(sceneBoundaryFogFactor({x:2000,y:0},camera,state),0,'the interior receives no spatial boundary blanket');
    const inner=sceneBoundaryFogFactor({x:2700,y:0},camera,state);
    const edge=sceneBoundaryFogFactor({x:3300,y:0},camera,state);
    const outside=sceneBoundaryFogFactor({x:3600,y:0},camera,state);
    assert.ok(inner>0&&edge>inner&&outside>=edge);
    assert.ok(edge>.5&&outside<=.65,'the distant border can be stronger without becoming opaque');
    for(const offset of [0,100,200,299,300]){
      const atEdge={x:3250,y:3250};
      assert.equal(sceneBoundaryFogFactor({x:3250-offset,y:3250},atEdge,state),0,'nearby corner ground must remain clear');
    }
  }
  const street=localAtmosphereState(50,100);
  assert.equal(distanceFogFactor(300,street),0);
  assert.equal(sceneBoundaryFogFactor({x:3300,y:0},{x:3200,y:0},street),0);
  assert.ok(sceneBoundaryFogFactor({x:-3300,y:0},{x:3200,y:0},street)>.5,'only distant background edges fade at street level');
  assert.ok(LOCAL_FOG_FRAGMENT_SHADER.includes('czm_inverseView*vec4(eyePosition,1.0)'));
  assert.ok(LOCAL_FOG_FRAGMENT_SHADER.includes('u_worldToLocal*world'));
});

test('scene boundary haze fades out with globe altitude and rejects invalid geometry',()=>{
  const point={x:3600,y:0},camera={x:0,y:0};
  const fog=(h)=>sceneBoundaryFogFactor(point,camera,localAtmosphereState(h,3300));
  assert.ok(fog(6400)>fog(7200));
  assert.ok(fog(7200)>fog(7800));
  assert.equal(fog(8000),0);
  assert.equal(fog(100000),0);
  assert.equal(sceneBoundaryFogFactor({x:NaN,y:0},camera,localAtmosphereState(500,3300)),0);
  assert.equal(sceneBoundaryFogFactor(point,camera,localAtmosphereState(500,3300),0),0);
});

test('an optional moving view circle blends its 450 m rim in the same local frame',()=>{
  const state=localAtmosphereState(500,3300),circle={x:1200,y:-600,radius:2400},camera={x:1200,y:-600};
  assert.equal(sceneBoundaryFogFactor(camera,camera,state,3300,circle),0);
  assert.equal(sceneBoundaryFogFactor({x:3000,y:-600},camera,state,3300,circle),0,'circle interior stays clear even near a static patch edge');
  const rim=sceneBoundaryFogFactor({x:3500,y:-600},camera,state,3300,circle);
  const outside=sceneBoundaryFogFactor({x:3800,y:-600},camera,state,3300,circle);
  assert.ok(rim>.4&&outside>rim&&outside<=.65);
  const nearBoundaryCamera={x:3550,y:-600};
  assert.equal(sceneBoundaryFogFactor({x:3600,y:-600},nearBoundaryCamera,state,3300,circle),0);
});

test('raw logarithmic and normal depth reconstruct realistic near/far fog distances exactly once',()=>{
  const state=localAtmosphereState(500,3300);
  for(const [near,far] of [[1,10000000],[100,1000000],[0.1,1000000000]])for(const distance of [500,1500,5000]){
    const logDepth=Math.log2(distance-near+1)/Math.log2(far-near+1);
    const normalDepth=far*(1-near/distance)/(far-near);
    const fromLog=eyeDistanceFromDepth(logDepth,near,far,{logarithmic:true});
    const fromNormal=eyeDistanceFromDepth(normalDepth,near,far);
    assert.ok(Math.abs(fromLog-distance)<1e-6);
    assert.ok(Math.abs(fromNormal-distance)<1e-3);
    if(distance===500)assert.equal(distanceFogFactor(fromLog,state),0,'the foreground must remain clear');
    if(distance===5000)assert.equal(distanceFogFactor(fromLog,state),state.fogStrength,'distant outside-patch pixels must be hidden');
    assert.ok(Math.abs(eyeDistanceFromDepth(logDepth,near,far,{logarithmic:true,rayLength:1.25})-distance*1.25)<1e-6);
  }
  const normalDepthOfForeground=10000000*(1-1/500)/(10000000-1);
  const incorrectlyDoubleDecoded=eyeDistanceFromDepth(normalDepthOfForeground,1,10000000,{logarithmic:true});
  assert.ok(incorrectlyDoubleDecoded>9000000,'the regression turned a500m foreground into a multi-million-meter distance');
  assert.ok(LOCAL_FOG_FRAGMENT_SHADER.includes('float depth=texture(depthTexture,v_textureCoordinates).r;'));
  assert.ok(!LOCAL_FOG_FRAGMENT_SHADER.includes('czm_readDepth('));
});

test('missing wind direction stays unknown and precipitation is only a qualitative cloud signal',()=>{
  assert.equal(localWeatherPolicy({WS10M:4}).windTowardDeg,null);
  assert.equal(localWeatherPolicy({WS10M:4}).windSpeedMs,0);
  assert.equal(localWeatherPolicy({PrecipMMDay:null}).rainSignal,null);
  assert.equal(localWeatherPolicy({PrecipMMDay:0}).rainSignal,0);
  const weather=localWeatherPolicy({WS10M:4,PlumeTowardDeg:450,PrecipMMDay:4},'projected');
  assert.equal(weather.windTowardDeg,90);
  assert.equal(weather.windSpeedMs,4);
  assert.equal(weather.rainSignal,0.5);
  assert.equal(weather.illustrative,true);
  assert.equal(weather.phase,'projected');
});

function fakeScene(){
  class Cartesian3{
    constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
    static fromDegrees(x,y,z=0){return new Cartesian3(0,0,z);}
    static clone(p,out=new Cartesian3()){return Object.assign(out,p);}
    static distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
  }
  class Matrix4{
    static inverseTransformation(frame,out){return out;}
    static multiplyByPoint(frame,p,out){return Object.assign(out,p);}
  }
  class Color{constructor(red,green,blue,alpha){Object.assign(this,{red,green,blue,alpha});}}
  class CloudCollection{
    constructor(options){Object.assign(this,options);this.clouds=[];this.dead=false;}
    add(options){const cloud={...options};this.clouds.push(cloud);return cloud;}
    destroy(){this.dead=true;}
    isDestroyed(){return this.dead;}
  }
  class PostProcessStage{
    constructor(options){Object.assign(this,options);this.dead=false;}
    destroy(){this.dead=true;}
    isDestroyed(){return this.dead;}
  }
  const C={Cartesian3,Cartesian2:class{constructor(x,y){Object.assign(this,{x,y});}},Matrix4,Color,CloudCollection,PostProcessStage,
    Transforms:{eastNorthUpToFixedFrame:()=>new Matrix4()},JulianDate:{secondsDifference:(a,b)=>a.seconds-b.seconds,clone:(a,out)=>Object.assign(out||{},a)}};
  const primitives=[],stages=[],listeners=new Set(),fog={enabled:false,density:0.0001,minimumBrightness:0.04};
  const collection=(arr)=>({add(value){arr.push(value);return value;},remove(value){const i=arr.indexOf(value);if(i<0)return false;arr.splice(i,1);value.destroy();return true;}});
  const viewer={camera:{positionWC:new Cartesian3(0,0,2100),positionCartographic:{height:2100}},clock:{currentTime:{seconds:0},shouldAnimate:true},scene:{fog,primitives:collection(primitives),postProcessStages:collection(stages),preRender:{addEventListener(fn){listeners.add(fn);return()=>listeners.delete(fn);}}}};
  const elevation={width:2,height:2,extentM:[-3300,-3300,3300,3300],heights:[100,100,100,100]};
  return {C,viewer,elevation,primitives,stages,listeners,tick(){for(const fn of listeners)fn();}};
}

test('local atmosphere uses a scene-wide depth fog stage and cleans up/restores state on exit',()=>{
  const fake=fakeScene(),states=[],originalFog={...fake.viewer.scene.fog};
  let circle=null;
  const atmosphere=attachLocalAtmosphere(fake.viewer,{id:'test',lat:35,lon:-90},{Cesium:fake.C,radius:3300,elevation:fake.elevation,viewCircle:()=>circle,onAtmosphere:(state)=>states.push({...state})});
  assert.equal(fake.primitives.length,0,'resources are lazy until local mode activates');
  assert.equal(fake.stages.length,0);
  atmosphere.setYear(2025,{WS10M:4,PlumeTowardDeg:90,PrecipMMDay:4});
  atmosphere.setActive(true);
  assert.equal(fake.primitives.length,1);
  assert.equal(fake.primitives[0].clouds.length,9);
  for(const cloud of fake.primitives[0].clouds){
    assert.ok(cloud.scale.x>=170&&cloud.scale.x<=310,'cloud clumps stay small rather than spanning the scenery');
    assert.ok(cloud.position.z>=1050,'clouds sit above the low-poly scene');
  }
  assert.equal(fake.stages.length,1);
  assert.ok(fake.stages[0].fragmentShader.includes('depthTexture'),'fog must include basemap pixels as well as model fragments');
  assert.equal(fake.stages[0].enabled,true);
  assert.equal(states.at(-1).postProcessFog,true);
  assert.equal(states.at(-1).active,true);
  assert.ok(fake.stages[0].uniforms.u_fogFar()>fake.stages[0].uniforms.u_fogNear());
  assert.equal(fake.stages[0].uniforms.u_sceneRadius,3300);
  assert.equal(fake.stages[0].uniforms.u_localCamera().z,2100);
  assert.ok(fake.stages[0].uniforms.u_worldToLocal());
  assert.equal(fake.stages[0].uniforms.u_boundaryStrength(),.65);
  assert.equal(fake.stages[0].uniforms.u_boundaryCircle(),0);
  circle={x:700,y:-200,radius:2400};fake.tick();
  assert.equal(fake.stages[0].uniforms.u_boundaryCircle(),1);
  assert.deepEqual({...fake.stages[0].uniforms.u_boundaryCenter()},{x:700,y:-200});
  assert.equal(fake.stages[0].uniforms.u_boundaryRadius(),2400);
  atmosphere.setQuality('balanced');assert.equal(states.at(-1).cloudCount,4);
  atmosphere.setQuality('low');assert.ok(fake.primitives[0].clouds.filter((c)=>c.show).length<=2);
  fake.viewer.camera.positionCartographic.height=200;fake.viewer.camera.positionWC.z=200;fake.tick();
  assert.equal(fake.primitives[0].show,false,'cloud layer must disappear near the ground');
  atmosphere.setActive(false);
  assert.equal(fake.stages[0].enabled,false);
  assert.deepEqual(fake.viewer.scene.fog,originalFog);
  atmosphere.destroy();atmosphere.destroy();atmosphere.setActive(true);
  assert.equal(fake.primitives.length,0);assert.equal(fake.stages.length,0);assert.equal(fake.listeners.size,0);
  assert.equal(states.at(-1).fogStrength,0);
  assert.equal(states.at(-1).boundaryStrength,0);
});

test('cloud motion follows the shared clock exactly once and ignores timeline jumps or pause',()=>{
  const fake=fakeScene();
  const atmosphere=attachLocalAtmosphere(fake.viewer,{id:'motion-test',lat:35,lon:-90},{Cesium:fake.C,elevation:fake.elevation});
  atmosphere.setYear(2025,{WS10M:4,PlumeTowardDeg:90});atmosphere.setActive(true);
  const cloud=fake.primitives[0].clouds[0],start={...cloud.position};
  fake.viewer.clock.currentTime.seconds=0.25;fake.tick();
  assert.ok(Math.abs(cloud.position.x-start.x-2.2)<1e-7,'0.25 shared-clock seconds × 4m/s × illustrative2.2 drift; no second speed multiplier');
  assert.ok(Math.abs(cloud.position.y-start.y)<1e-7);
  const beforeJump={...cloud.position};fake.viewer.clock.currentTime.seconds=100000;fake.tick();
  assert.deepEqual({...cloud.position},beforeJump,'selecting a distant year must not teleport clouds');
  fake.viewer.clock.shouldAnimate=false;fake.viewer.clock.currentTime.seconds+=0.25;fake.tick();
  assert.deepEqual({...cloud.position},beforeJump);
  atmosphere.destroy();
});
