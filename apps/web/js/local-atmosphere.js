// Local scenery atmosphere. Weather drives only qualitative cloud appearance;
// the distance haze hides the finite scene boundary, not measured air pollution.
import { sampleElevation } from './landscape.js';

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const finite=(v)=>typeof v==='number'&&Number.isFinite(v);
const smooth=(lo,hi,v)=>{const t=clamp((v-lo)/(hi-lo),0,1);return t*t*(3-2*t);};
function hash(value){let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
const random=(key)=>hash(key)/4294967296;
let sequence=0;

/** Fog thresholds are eye distances suitable for length(positionEC). The
 * underlying horizontal ranges are also returned; adding camera height avoids
 * fogging every ground pixel simply because the camera is high overhead.
 */
export function localAtmosphereState(height,edgeDistance,quality='high') {
  const h=finite(height)?Math.max(0,height):9000,edge=finite(edgeDistance)?edgeDistance:0;
  // Preserve a clear playable foreground even beside the finite map boundary.
  // Never compress the entire haze ramp into a few hundred meters at an edge.
  const horizontalNear=clamp(edge*0.45,1000,1800);
  const horizontalFar=Math.max(horizontalNear+1200,clamp(edge*1.1,2400,4200));
  const overviewFade=1-smooth(6400,8000,h);
  return {
    cameraHeightM:h,edgeDistanceM:edge,
    fogHorizontalNearM:horizontalNear,fogHorizontalFarM:horizontalFar,
    fogNearM:Math.hypot(h,horizontalNear),fogFarM:Math.hypot(h,horizontalFar),
    fogStrength:0.35*smooth(120,450,h)*(1-0.6*smooth(2500,5800,h))*overviewFade,
    boundaryStrength:0.65*overviewFade,boundaryClearM:300,boundaryFullM:1100,
    fogColor:[0.65,0.72,0.75],
    cloudAlpha:0.16*smooth(400,1000,h)*(1-smooth(5000,6500,h)),
    cloudCount:quality==='low'?2:['medium','balanced'].includes(quality)?4:6,
    postProcessFog:true,
  };
}

export function distanceFogFactor(distance,state) {
  if(!finite(distance))return 0;
  return smooth(state.fogNearM,state.fogFarM,Math.max(0,distance))*state.fogStrength;
}

/** Only the outer 850 m of the finite square scene receives stronger haze.
 * Horizontal camera distance protects nearby ground even at a scene corner or
 * directly under an overview camera. This is display blending, not pollution.
 */
export function sceneBoundaryFogFactor(point,camera,state,radius=3300,circle=null) {
  if(![point?.x,point?.y,camera?.x,camera?.y,radius].every(finite)||radius<=0)return 0;
  const circular=[circle?.x,circle?.y,circle?.radius].every(finite)&&circle.radius>0;
  const rim=circular?smooth(Math.max(0,circle.radius-450),circle.radius+100,Math.hypot(point.x-circle.x,point.y-circle.y))
    :smooth(Math.max(0,radius-850),radius+150,Math.max(Math.abs(point.x),Math.abs(point.y)));
  const away=smooth(state.boundaryClearM,state.boundaryFullM,Math.hypot(point.x-camera.x,point.y-camera.y));
  return clamp(rim*away*state.boundaryStrength,0,0.65);
}

/** CPU diagnostic equivalent of Cesium 1.121's raw depth/log-depth overload.
 * Ray length is the eye-ray length when its forward-z component is one.
 * This is useful for checking fog ranges without a WebGL context.
 */
export function eyeDistanceFromDepth(rawDepth,near,far,{logarithmic=false,rayLength=1}={}) {
  if(![rawDepth,near,far,rayLength].every(finite)||rawDepth<=0||rawDepth>=1||near<=0||far<=near||rayLength<1)return null;
  const forward=logarithmic?Math.pow(2,rawDepth*Math.log2(far-near+1))-1+near:near*far/(far-rawDepth*(far-near));
  return forward*rayLength;
}

/** Fade a cloud before the camera can enter or fill the view with its billboard. */
export function cloudProximityFade(distance,width=260) {
  return finite(distance)?smooth(Math.max(350,width*2),Math.max(750,width*4),distance):0;
}

export function localWeatherPolicy(row={},phase='observed') {
  const number=(v)=>v===null||v===undefined||v===''?null:Number(v);
  const precipitation=number(row.PrecipMMDay),speed=number(row.WS10M),bearing=number(row.PlumeTowardDeg);
  const hasWind=finite(speed)&&speed>=0&&finite(bearing),hasRain=finite(precipitation)&&precipitation>=0;
  return {
    rainSignal:hasRain?clamp(precipitation/8,0,1):null,
    windSpeedMs:hasWind?clamp(speed,0,35):0,
    windTowardDeg:hasWind?((bearing%360)+360)%360:null,
    weatherKnown:hasRain||hasWind,phase,illustrative:true,
  };
}

export const LOCAL_FOG_FRAGMENT_SHADER=`
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_fogStrength;
uniform vec3 u_fogColor;
uniform mat4 u_worldToLocal;
uniform vec3 u_localCamera;
uniform float u_sceneRadius;
uniform float u_boundaryStrength;
uniform vec2 u_boundaryCenter;
uniform float u_boundaryRadius;
uniform float u_boundaryCircle;
in vec2 v_textureCoordinates;
void main() {
    vec4 color=texture(colorTexture,v_textureCoordinates);
    // Scene.js supplies a raw DEPTH_STENCIL texture, not packed globe-depth RGBA.
    // The vec2/float overload reverses log depth itself: do not call readDepth
    // first, which would reverse it twice and fog even foreground geometry.
    float depth=texture(depthTexture,v_textureCoordinates).r;
    if(depth>=1.0 || depth<=0.0) { out_FragColor=color; return; }
    vec4 eye=czm_windowToEyeCoordinates(gl_FragCoord.xy,depth);
    vec3 eyePosition=eye.xyz/max(abs(eye.w),0.000001);
    float distance=length(eyePosition);
    vec4 world=czm_inverseView*vec4(eyePosition,1.0);
    vec3 local=(u_worldToLocal*world).xyz;
    float rim=smoothstep(max(0.0,u_sceneRadius-850.0),u_sceneRadius+150.0,max(abs(local.x),abs(local.y)));
    if(u_boundaryCircle>0.5)rim=smoothstep(max(0.0,u_boundaryRadius-450.0),u_boundaryRadius+100.0,length(local.xy-u_boundaryCenter));
    float away=smoothstep(300.0,1100.0,length(local.xy-u_localCamera.xy));
    // Nearby pixels are protected independently of eye depth and camera altitude.
    // The stronger fade is restricted to distant scene edges; general haze stays subtle.
    float haze=clamp(smoothstep(u_fogNear,max(u_fogNear+1.0,u_fogFar),distance)*u_fogStrength,0.0,0.35);
    float boundary=clamp(rim*away*u_boundaryStrength,0.0,0.65);
    float amount=max(haze,boundary);
    out_FragColor=vec4(mix(color.rgb,u_fogColor,amount),color.a);
}
`;

/** sceneData.onAtmosphere(state) receives the current frame policy. Postprocess
 * fog already covers models and basemap: do not also apply model fog at full
 * strength. All primitives/stages/listeners are released by destroy().
 */
export function attachLocalAtmosphere(viewer,site,sceneData={}) {
  const C=sceneData.Cesium||globalThis.Cesium;
  if(!C)throw new Error('Cesium is required for local atmosphere');
  const scene=viewer.scene,radius=sceneData.radius||3300,center=sceneData.center||site;
  let active=false,destroyed=false,quality=sceneData.quality||'high',weather=localWeatherPolicy(),collection,stage,savedFog,previousTime;
  let frame,inverse,lastState=localAtmosphereState(9000,0,quality);
  const clouds=[],localCamera=new C.Cartesian3(),scratch=new C.Cartesian3(),fogColor=new C.Cartesian3(...lastState.fogColor);
  const boundaryCenter=new C.Cartesian2(0,0);
  let boundaryRadius=radius,boundaryCircle=0;

  function nativeFog(activeValue) {
    const fog=scene.fog;
    if(!fog)return;
    if(activeValue&&!savedFog){
      savedFog={enabled:fog.enabled,density:fog.density,minimumBrightness:fog.minimumBrightness};
      // Use one controlled haze pass locally; don't stack native fog over it.
      fog.enabled=false;
    }else if(!activeValue&&savedFog){Object.assign(fog,savedFog);savedFog=null;}
  }
  function allocate() {
    if(collection)return;
    frame=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(center.lon,center.lat));
    inverse=C.Matrix4.inverseTransformation(frame,new C.Matrix4());
    // Cesium 1.121 CloudCollectionFS uses three Worley-noise layers to erode
    // cloud alpha, then discards fragments below 0.01: these are separate noisy
    // clumps with transparent gaps, not an opaque cloud sheet. Keep both debug
    // solid-billboard/ellipsoid paths off; native detail 16 gives finer erosion.
    // Source: CesiumGS/cesium/1.121/.../Shaders/CloudCollectionFS.glsl.
    collection=scene.primitives.add(new C.CloudCollection({show:false,noiseDetail:16,debugBillboards:false,debugEllipsoids:false}));
    for(let i=0;i<9;i++){
      const key=(site?.id||sceneData.source?.name||'local')+':cloud:'+i;
      const angle=i*Math.PI*2/9+(random(key+'angle')-.5)*.45,range=radius*(.35+random(key+'range')*.28);
      const x=Math.cos(angle)*range,y=Math.sin(angle)*range,width=170+random(key+'w')*140;
      const altitude=(sampleElevation(sceneData.elevation,x,y)??sceneData.focusHeight??0)+950+random(key+'h')*300;
      const position=C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(x,y,altitude),new C.Cartesian3());
      const cloud=collection.add({show:false,position,scale:new C.Cartesian2(width,width*(.38+random(key+'aspect')*.16)),maximumSize:new C.Cartesian3(18+random(key)*8,8,7),slice:0.32+random(key+'slice')*.26,brightness:0.92,color:new C.Color(0.94,0.96,0.98,0)});
      clouds.push({cloud,x,y,altitude,width});
    }
    stage=scene.postProcessStages.add(new C.PostProcessStage({
      name:'footprint-local-distance-fog-'+(++sequence),fragmentShader:LOCAL_FOG_FRAGMENT_SHADER,
      uniforms:{u_fogNear:()=>lastState.fogNearM,u_fogFar:()=>lastState.fogFarM,u_fogStrength:()=>lastState.fogStrength,u_fogColor:()=>fogColor,
        u_worldToLocal:()=>inverse,u_localCamera:()=>localCamera,u_sceneRadius:radius,u_boundaryStrength:()=>lastState.boundaryStrength,
        u_boundaryCenter:()=>boundaryCenter,u_boundaryRadius:()=>boundaryRadius,u_boundaryCircle:()=>boundaryCircle},
    }));
    stage.enabled=false;
  }
  function tick() {
    if(destroyed||!active)return;
    allocate();
    const position=viewer.camera.positionWC||viewer.camera.position;
    C.Matrix4.multiplyByPoint(inverse,position,localCamera);
    const ground=sampleElevation(sceneData.elevation,localCamera.x,localCamera.y)??sceneData.focusHeight??0;
    const altitude=finite(viewer.camera.positionCartographic?.height)?viewer.camera.positionCartographic.height:localCamera.z;
    const height=Math.max(0,altitude-ground),edge=radius-Math.max(Math.abs(localCamera.x),Math.abs(localCamera.y));
    lastState=localAtmosphereState(height,edge,quality);
    const circle=typeof sceneData.viewCircle==='function'?sceneData.viewCircle():null;
    boundaryCircle=[circle?.x,circle?.y,circle?.radius].every(finite)&&circle.radius>0?1:0;
    if(boundaryCircle){boundaryCenter.x=circle.x;boundaryCenter.y=circle.y;boundaryRadius=circle.radius;}
    const rain=weather.rainSignal??0.35;
    lastState.cloudAlpha*=0.75+rain*0.25;
    lastState.weatherKnown=weather.weatherKnown;lastState.phase=weather.phase;
    lastState.active=true;
    const supplied=sceneData.fogColor;
    if(Array.isArray(supplied)&&supplied.length>=3&&supplied.slice(0,3).every(finite))lastState.fogColor=supplied.slice(0,3);
    fogColor.x=lastState.fogColor[0];fogColor.y=lastState.fogColor[1];fogColor.z=lastState.fogColor[2];
    let dt=0;
    const current=viewer.clock?.currentTime;
    if(current&&C.JulianDate){
      if(previousTime&&viewer.clock.shouldAnimate!==false){
        const elapsed=C.JulianDate.secondsDifference(current,previousTime);
        if(elapsed>=0&&elapsed<=0.5)dt=elapsed;
      }
      previousTime=C.JulianDate.clone(current,previousTime);
    }
    // The shared clock already applies motion speed. Ignore timeline year jumps.
    const bearing=(weather.windTowardDeg??0)*Math.PI/180,drift=weather.windSpeedMs*2.2,wrap=radius*0.78;
    for(let i=0;i<clouds.length;i++){
      const item=clouds[i];
      item.x=((item.x+Math.sin(bearing)*drift*dt+wrap)%(2*wrap)+2*wrap)%(2*wrap)-wrap;
      item.y=((item.y+Math.cos(bearing)*drift*dt+wrap)%(2*wrap)+2*wrap)%(2*wrap)-wrap;
      C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(item.x,item.y,item.altitude),scratch);
      item.cloud.position=C.Cartesian3.clone(scratch,item.cloud.position);
      const distance=C.Cartesian3.distance(position,scratch),nearFade=cloudProximityFade(distance,item.width);
      const edgeFade=smooth(0,280,radius-Math.max(Math.abs(item.x),Math.abs(item.y)));
      const alpha=lastState.cloudAlpha*nearFade*edgeFade;
      item.cloud.show=i<lastState.cloudCount&&alpha>0.002;
      item.cloud.color=new C.Color(0.94-rain*0.12,0.96-rain*0.10,0.98-rain*0.08,alpha);
      item.cloud.brightness=0.94-rain*0.18;
    }
    collection.show=lastState.cloudAlpha>0.002;
    stage.enabled=true;
    sceneData.onAtmosphere?.(lastState);
  }
  const stop=scene.preRender.addEventListener(tick);
  return {
    setActive(value){
      if(destroyed)return;
      active=!!value;previousTime=null;nativeFog(active);
      if(active)tick();else{
        if(collection)collection.show=false;if(stage)stage.enabled=false;
        lastState={...lastState,active:false,cloudAlpha:0,fogStrength:0,boundaryStrength:0};sceneData.onAtmosphere?.(lastState);
      }
    },
    setYear(year,row={},phase='observed'){if(!destroyed){weather=localWeatherPolicy(row,phase);if(active)tick();}},
    setQuality(value){if(!destroyed){quality=['low','medium','balanced','high'].includes(value)?value:'high';if(active)tick();}},
    destroy(){
      if(destroyed)return;
      active=false;nativeFog(false);destroyed=true;
      if(typeof stop==='function')stop();else scene.preRender.removeEventListener(tick);
      if(stage){stage.enabled=false;scene.postProcessStages.remove(stage);if(typeof stage.isDestroyed==='function'&&!stage.isDestroyed())stage.destroy();}
      if(collection){collection.show=false;scene.primitives.remove(collection);if(typeof collection.isDestroyed==='function'&&!collection.isDestroyed())collection.destroy();}
      clouds.length=0;previousTime=null;
      sceneData.onAtmosphere?.({...lastState,active:false,cloudAlpha:0,fogStrength:0,boundaryStrength:0});
    },
  };
}
