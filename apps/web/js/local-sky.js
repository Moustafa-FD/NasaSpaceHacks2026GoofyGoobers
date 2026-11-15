// Tone-mapped HDRI scenery, restricted to background-depth pixels. Available
// precipitation selects an artistic preset; it does not measure cloud cover.
import { sampleElevation } from './landscape.js';
const finite=(v)=>typeof v==='number'&&Number.isFinite(v);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};
let manifestPromise,sequence=0;

export function selectLocalSkyConfig(center={},row={},phase='observed',{regionalFallback=false}={}){
  const raw=row.PrecipMMDay,precip=raw===null||raw===undefined||raw===''?null:Number(raw);
  const known=finite(precip)&&precip>=0;
  const id=known?(precip>=3.6?'overcast':precip>=1.8?'cloudy':'clear'):
    regionalFallback&&finite(center.lat)&&(Math.abs(center.lat)>58||Math.abs(center.lat)<23)?'cloudy':'clear';
  const basis=known?'annual precipitation display cue':regionalFallback?'artistic latitude fallback':'neutral artistic fallback';
  return {id,precipitationMMDay:known?precip:null,weatherKnown:known,phase,illustrative:true,
    basis,selectionBasis:basis,
    caption:'Illustrative HDRI sky; cloud cover is not measured.'};
}
export function localSkyOpacity(height,active=true){return active&&finite(height)?1-smooth(5000,8000,Math.max(0,height)):0;}
export function skyPixelWeight(depth,height,active=true){return finite(depth)&&depth>=.9999999?localSkyOpacity(height,active):0;}
export function skyDirectionUV(direction,yawDegrees=0,skyHorizonRow=.43){
  const size=Math.hypot(direction.x,direction.y,direction.z);if(!(size>0))return null;
  const u=Math.atan2(direction.x,direction.y)/(Math.PI*2)+.5+yawDegrees/360;
  const horizon=clamp(finite(skyHorizonRow)?skyHorizonRow:.43,.25,.5);
  return {u:((u%1)+1)%1,v:1-horizon+2*horizon*Math.asin(clamp(direction.z/size,.015,1))/Math.PI};
}
/** Camera.getPickRay uses world coordinates even with a camera look-at frame.
 * Denormalizing by forward depth makes three corner rays an exact perspective
 * ray basis, independent of the renderer's fullscreen/last-frustum uniforms. */
export function updateSkyRayBasis(camera,width,height,transformDirection,result={}){
  if(!camera.getPickRay||!(width>0&&height>0))return null;
  for(const key of ['base','dx','dy','right','top'])result[key] ||= {x:0,y:0,z:0};
  result.pixel ||= {x:0,y:0};
  function read(x,y,out){
    result.pixel.x=x;result.pixel.y=y;
    const ray=camera.getPickRay(result.pixel,result.ray);if(!ray)return false;
    transformDirection(ray.direction,out);
    const f=camera.directionWC,d=f?ray.direction.x*f.x+ray.direction.y*f.y+ray.direction.z*f.z:1;
    if(d>0.000001){out.x/=d;out.y/=d;out.z/=d;}return true;
  }
  // Texture v=0 is the bottom, but browser window y=0 is the top.
  if(!read(0,height,result.base)||!read(width,height,result.right)||!read(0,0,result.top))return null;
  for(const axis of ['x','y','z']){result.dx[axis]=result.right[axis]-result.base[axis];result.dy[axis]=result.top[axis]-result.base[axis];}
  return result;
}
function validManifest(doc){
  const environments=(doc?.environments||[]).filter((e)=>['clear','cloudy','overcast'].includes(e.id)&&typeof e.image==='string'&&e.image.length>0);
  if(!environments.length)throw new Error('Sky environment catalog is unavailable');return {...doc,environments};
}
function getManifest(fetcher){
  manifestPromise ||= fetcher('assets/sky/environments.json').then((r)=>{if(!r.ok)throw new Error('Sky environment catalog is unavailable');return r.json();}).then(validManifest).catch((error)=>{manifestPromise=null;throw error;});
  return manifestPromise;
}

export const LOCAL_SKY_FRAGMENT_SHADER=`
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D u_environment;
uniform vec3 u_rayBase;
uniform vec3 u_rayDx;
uniform vec3 u_rayDy;
uniform float u_opacity;
uniform float u_yaw;
uniform float u_skyHorizonRow;
in vec2 v_textureCoordinates;
void main() {
    vec4 base=texture(colorTexture,v_textureCoordinates);
    float depth=texture(depthTexture,v_textureCoordinates).r;
    // A clear depth of one is the sky. Preserve all geometry, including near
    // depth zero: there is no foreground fog or billboard/plane intersection.
    if(depth<0.9999999 || u_opacity<=0.0) { out_FragColor=base; return; }
    vec3 local=normalize(u_rayBase+v_textureCoordinates.x*u_rayDx+v_textureCoordinates.y*u_rayDy);
    float longitude=atan(local.x,local.y)/6.28318530718+0.5+u_yaw;
    // Sample the sky hemisphere. Photographed ground below the HDRI horizon
    // must not become a second terrain layer near Earth's curved horizon.
    // The bundled display panoramas replace rows from0.44 down with haze.
    // Map the visible hemisphere into their actual upper sky, not that flat
    // band. Texture's HTML-image upload flips Y; v=1 is image row zero.
    float latitude=1.0-u_skyHorizonRow+2.0*u_skyHorizonRow*asin(clamp(local.z,0.015,1.0))/3.14159265359;
    vec3 sky=texture(u_environment,vec2(fract(longitude),latitude)).rgb;
    out_FragColor=vec4(mix(base.rgb,sky,u_opacity),base.a);
}
`;

/** Shared by the local-atmosphere lifecycle. Image URLs are relative to the
 * page root (e.g. assets/sky/clear.jpg), never to the manifest directory twice.
 * onSkyEnvironment fires once a selected texture is ready while active. */
export function attachLocalSky(viewer,site,sceneData={}){
  const C=sceneData.Cesium||globalThis.Cesium,scene=viewer.scene,center=sceneData.center||site;
  let active=false,destroyed=false,stage,manifest,loading,entry,applied,opacity=0,frames=0,changedAt=0;
  let config=selectLocalSkyConfig(center),lastStateKey='';
  const frame=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(center.lon,center.lat));
  const inverse=C.Matrix4.inverseTransformation(frame,new C.Matrix4()),localCamera=new C.Cartesian3();
  const rays={base:new C.Cartesian3(-1,1,-.5),dx:new C.Cartesian3(2,0,0),dy:new C.Cartesian3(0,0,1.5),right:new C.Cartesian3(),top:new C.Cartesian3(),...(C.Ray?{ray:new C.Ray()}: {})};
  const transformDirection=(direction,result)=>C.Matrix4.multiplyByPointAsVector(inverse,direction,result);
  const horizonRow=()=>clamp(finite(entry?.skyHorizonRow)?entry.skyHorizonRow:.43,.25,.5);
  function rayDiagnostics(){
    const snapshot=(v)=>({x:v.x,y:v.y,z:v.z}),yaw=Number(entry?.yawDegrees)||0,horizon=horizonRow();
    return {rayBase:snapshot(rays.base),rayDx:snapshot(rays.dx),rayDy:snapshot(rays.dy),skyHorizonRow:horizon,
      topUV:skyDirectionUV({x:rays.base.x+rays.dx.x*.5+rays.dy.x,y:rays.base.y+rays.dx.y*.5+rays.dy.y,z:rays.base.z+rays.dx.z*.5+rays.dy.z},yaw,horizon),
      bottomUV:skyDirectionUV({x:rays.base.x+rays.dx.x*.5,y:rays.base.y+rays.dx.y*.5,z:rays.base.z+rays.dx.z*.5},yaw,horizon)};
  }
  function state(error){
    const diagnostic=rayDiagnostics();
    const value={...config,active,opacity,ready:!!stage&&stage.ready!==false,environment:entry?.id||null,...diagnostic,...(error?{error}:{} )};
    const key=[active,config.id,config.phase,config.year,config.precipitationMMDay,config.weatherKnown,entry?.id,value.ready,opacity>0,!!error,
      diagnostic.topUV?.u.toFixed(3),diagnostic.topUV?.v.toFixed(3),diagnostic.bottomUV?.u.toFixed(3),diagnostic.bottomUV?.v.toFixed(3)].join(':');
    if(key!==lastStateKey){lastStateKey=key;sceneData.onSkyState?.(value);}
    return value;
  }
  function choose(){
    if(!manifest)return;
    const selected=manifest.environments.find((e)=>e.id===config.id)||manifest.environments.find((e)=>e.id==='clear')||manifest.environments[0];
    if(entry===selected)return;entry=selected;applied=null;changedAt=frames;
    if(stage){stage.uniforms.u_environment=entry.image;stage.uniforms.u_yaw=(Number(entry.yawDegrees)||0)/360;stage.uniforms.u_skyHorizonRow=horizonRow();}
  }
  function allocate(){
    if(stage||!manifest||destroyed)return;choose();
    stage=scene.postProcessStages.add(new C.PostProcessStage({name:'footprint-local-hdri-sky-'+(++sequence),fragmentShader:LOCAL_SKY_FRAGMENT_SHADER,
      uniforms:{u_environment:entry.image,u_rayBase:()=>rays.base,u_rayDx:()=>rays.dx,u_rayDy:()=>rays.dy,u_opacity:()=>opacity,u_yaw:(Number(entry.yawDegrees)||0)/360,u_skyHorizonRow:horizonRow()},
      ...(C.PostProcessStageSampleMode?{sampleMode:C.PostProcessStageSampleMode.LINEAR}:{}),textureScale:1}));
    stage.enabled=false;
  }
  function ensure(){
    if(manifest){allocate();return Promise.resolve();}if(loading)return loading;
    const source=sceneData.skyManifest?Promise.resolve(validManifest(sceneData.skyManifest)):getManifest(sceneData.skyFetch||globalThis.fetch);
    loading=source.then((value)=>{if(destroyed)return;manifest=value;choose();if(active){allocate();tick();}})
      .catch((error)=>{if(!destroyed)state(error.message);}).finally(()=>{loading=null;});
    return loading;
  }
  function tick(){
    if(destroyed||!active)return;frames++;
    const canvas=viewer.canvas||scene.canvas;
    if(canvas)updateSkyRayBasis(viewer.camera,canvas.clientWidth,canvas.clientHeight,transformDirection,rays);
    const position=viewer.camera.positionWC||viewer.camera.position;
    if(position)C.Matrix4.multiplyByPoint(inverse,position,localCamera);
    const ground=sampleElevation(sceneData.elevation,localCamera.x,localCamera.y)??sceneData.focusHeight??0;
    const height=(viewer.camera.positionCartographic?.height??localCamera.z)-ground;
    opacity=sceneData.skyNight?.()?0:localSkyOpacity(height,active);
    if(stage){stage.enabled=opacity>0;
      // Let Cesium process a changed URL before treating an old ready flag as
      // the newly selected texture. A pending stage stays on the native sky.
      if(opacity>0&&stage.ready!==false&&frames-changedAt>=2&&applied!==entry){applied=entry;sceneData.onSkyEnvironment?.(entry);}
    }
    state();
  }
  const removeTick=scene.preRender.addEventListener(tick);
  return {
    setActive(value){if(destroyed)return;active=!!value;if(active){ensure();tick();}else{opacity=0;if(stage)stage.enabled=false;state();}},
    setYear(year,row={},phase='observed'){if(destroyed)return;config={...selectLocalSkyConfig(center,row,phase,{regionalFallback:!!sceneData.regionalSkyFallback}),year};choose();if(active)tick();else state();},
    setQuality(){},
    get state(){return state();},get ready(){return loading||Promise.resolve();},
    destroy(){if(destroyed)return;active=false;opacity=0;destroyed=true;removeTick();if(stage){stage.enabled=false;scene.postProcessStages.remove(stage);if(stage.isDestroyed&&!stage.isDestroyed())stage.destroy();}stage=null;},
  };
}
