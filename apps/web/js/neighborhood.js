// Zoom-driven local 3D scenery. Mapped layout, authored low-poly architecture.
import { createLandscapeShader } from './landscape-shader.js';
import { sampleElevation, scenarioHeightOffset } from './landscape.js';
import { attachCampusEffects } from './campus-effects.js';
import { attachCityLife } from './city-life.js';
import { attachLocalAtmosphere } from './local-atmosphere.js';
import { applySkyLighting } from './sky-lighting.js';
import { quality as currentQuality, lightMode as currentLightMode } from './fx.js';
import { createSceneStreamer, streamKey, streamRadius, fadeWeights, waitForModelReady } from './scene-streaming.js';
import { createSceneCompiler } from './scene-compiler.js';
const ENTER_HEIGHT = 5800, EXIT_HEIGHT = 7600, WARM_HEIGHT = 12000;
let cs, viewer, currentSite, model, sceneData, active = false, enabled = true, generation = 0;
let pending = false, scenario = false, lastFrameYear = 2025, lastHealth = 1, savedScene;
let failedGeneration = -1;
let campusEffects, cityLife, localAtmosphere, overviewModel, overviewActive = false, lastQuality = 'high', lastRow = {}, lastPhase = 'observed';
const generated = new Map();
const failedUploads=new WeakSet();
const compiler=createSceneCompiler(()=>new Worker(new URL('./neighborhood-worker.js',import.meta.url),{type:'module'}));
let baseData, currentPatch, retiringPatch, uploadingPatch, streamer, worldFocus, lastCameraCheck=-Infinity, patchSequence=0;
let prepareAbort,prepareStarted=0;
const q = new URLSearchParams(location.search);

function mountControls() {
  const dock = document.createElement('section');
  dock.id = 'sceneDock'; dock.setAttribute('aria-label', '3D neighborhood');
  dock.innerHTML = `<div class="scene-heading"><span class="scene-dot"></span><strong id="sceneMode">Globe view</strong><span id="sceneCount"></span></div>
    <div class="scene-actions"><button id="sceneEnter" class="primary">Campus ↗</button><button id="sceneHomes">Homes ↗</button><button id="sceneFields">Fields ↗</button><button id="sceneShops" hidden>Shops ↗</button><button id="sceneAirport" hidden>Airport ↗</button><button id="sceneParks" hidden>Parks ↗</button><button id="sceneGlobe" hidden>Globe ↗</button><label class="scene-auto"><input id="sceneAuto" type="checkbox" checked>Auto</label></div>
    <div id="sceneStatus" role="status">Zoom closer to reveal the neighborhood.</div>
    <div id="sceneActivity" style="font-size:10px;color:#a9c9be;margin-top:5px" hidden></div>
    <div style="font-size:9px;color:#91a9ac;margin-top:6px"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" style="color:inherit">© OpenStreetMap contributors</a> · <a href="https://open-meteo.com/en/docs/elevation-api" target="_blank" rel="noopener" style="color:inherit">Copernicus / Open-Meteo</a></div>
    <div id="campusPlumeNote" hidden style="font-size:10px;color:#adbdc3;margin-top:6px">Illustrative combustion plume; not measured visible smoke.</div>
    <details class="scene-notes"><summary>Landscape &amp; map details</summary><button id="sceneHorizon" title="Lower the viewing angle to see the local HDRI sky">Horizon view ↗</button><p id="sceneSkyState">EXR sky · regional weather selects an illustrative backdrop.</p><label><input id="terrainScenario" type="checkbox"> Terrain evolution scenario</label><p id="landscapeState">Present-day mapped buildings, roads, farms, forests and water. Architecture, planting, traffic and aircraft are illustrative.</p><p>Vegetation changes illustrate the site's NDVI signal, not measured crop death or yield. Terrain scenarios are illustrative. Elevation is interpolated from the available reference DEM.</p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · <a href="https://polyhaven.com" target="_blank" rel="noopener">HDRI: Poly Haven / CC0</a></details>`;
  document.body.appendChild(dock);
  const style = document.createElement('style');
  style.textContent = `#sceneDock{position:fixed;left:calc(var(--panel-width,300px) + 18px);top:92px;z-index:7;width:350px;background:#101a23ed;border:1px solid #ffffff1c;border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px #0002;backdrop-filter:blur(12px);font-size:12px}.scene-heading{display:flex;align-items:center;gap:8px}.scene-heading strong{font-size:12px;letter-spacing:.4px}.scene-dot{width:7px;height:7px;background:#7f9ba4;border-radius:50%;flex:none}body.lowpoly-active .scene-dot{background:#7cdbc1;box-shadow:0 0 9px #7cdbc155}#sceneCount{margin-left:auto;color:#a7bcc5;font-size:10px}.scene-actions{display:flex;gap:6px;margin-top:10px;align-items:center}.scene-actions button{font-size:11px;padding:6px 8px}.scene-auto{margin-left:auto;font-size:11px;color:#acbcc6;display:flex;gap:4px;align-items:center}#sceneStatus{color:#9eafb9;font-size:11px;margin-top:8px;line-height:1.4}.scene-notes{margin-top:8px;font-size:10px;color:#94a4af}.scene-notes summary{cursor:pointer;color:#aabac2}.scene-notes label{display:flex;gap:6px;align-items:center;margin:10px 0}.scene-notes p{line-height:1.5;margin:7px 0}.scene-notes a{color:#92c5bb}#gpu-info{top:92px!important;font-size:10px!important;max-width:360px!important}@media(max-width:680px){#sceneDock{left:14px;top:110px;width:min(350px,calc(100vw - 28px))}#gpu-info{display:none}}`;
  document.head.appendChild(style);
  style.textContent += '.scene-actions{flex-wrap:wrap}';
  document.querySelector('#sceneEnter').onclick = () => enter();
  document.querySelector('#sceneHomes').onclick = () => enter('homes');
  document.querySelector('#sceneFields').onclick = () => enter(true);
  document.querySelector('#sceneShops').onclick = () => enter('shops');
  document.querySelector('#sceneAirport').onclick = () => enter('airport');
  document.querySelector('#sceneParks').onclick = () => enter('parks');
  document.querySelector('#sceneHorizon').onclick = () => enter('horizon');
  document.querySelector('#sceneGlobe').onclick = () => exit();
  document.querySelector('#sceneAuto').onchange = (e) => { enabled = e.target.checked; evaluateCamera(); };
  document.querySelector('#terrainScenario').onchange = (e) => {
    scenario = e.target.checked;
    document.querySelector('#landscapeState').textContent = scenario ? 'TERRAIN SCENARIO · move the timeline from 2025 toward 2035 to see illustrative uplift, erosion and changing shorelines. Not a historical reconstruction or forecast.' : 'Present-day mapped buildings, farms, forests and water. Roofs, missing heights and planting are illustrative.';
    for (const patch of [currentPatch,retiringPatch,uploadingPatch]) for(const asset of patch?.assets||[]) asset.shader.setUniform('u_scenario',scenario?1:0);
    if(baseData)updateCampusMarker(baseData,currentSite.id);
    document.querySelector('#sceneMode').textContent = active ? (scenario ? 'Landscape scenario' : 'Low-poly neighborhood') : 'Globe view';
  };
}
const status = (message) => { const el = document.querySelector('#sceneStatus'); if (el) el.textContent = message; };
function removeModel() {
  for(const patch of [currentPatch,retiringPatch,uploadingPatch])disposePatch(patch);
  currentPatch=retiringPatch=uploadingPatch=null;
  campusEffects=cityLife=localAtmosphere=null;
  model = overviewModel = null; overviewActive = false;
  document.querySelector('#sceneActivity').hidden = true;
}
function disposeControllers(patch){
  for(const controller of patch?.controllers||[])controller.destroy();
  if(patch)patch.controllers=[];
}
function disposePatch(patch){
  if(!patch||patch.disposed)return;
  patch.disposed=true;patch.abort.abort();disposeControllers(patch);
  for(const asset of patch.assets){
    asset.removeError?.();
    if(asset.model&&!asset.model.isDestroyed())viewer.scene.primitives.remove(asset.model);
    if(!asset.shader.isDestroyed())asset.shader.destroy();
  }
  patch.assets.length=0;
}
function updateCampusMarker(data, siteId) {
  const campus = data.campuses?.[0]; if (!campus) return;
  const base = 4 + (sampleElevation(data.elevation,campus.x,campus.y) ?? 0) - (campus.x**2+campus.y**2)/(2*6371000)
    + (scenario ? scenarioHeightOffset(campus.x,campus.y,lastFrameYear,data.elevation?.extentM) : 0);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(data.center.lon,data.center.lat));
  const cartographicAt = (height) => Cesium.Cartographic.fromCartesian(Cesium.Matrix4.multiplyByPoint(frame,new Cesium.Cartesian3(campus.x,campus.y,height),new Cesium.Cartesian3()));
  const roof = cartographicAt(base+campus.height+2),ground=cartographicAt(base);
  window.dispatchEvent(new CustomEvent('cs:campus-ready',{detail:{siteId,campusCount:data.campuses.length,marker:{
    lon:Cesium.Math.toDegrees(roof.longitude),lat:Cesium.Math.toDegrees(roof.latitude),groundHeight:ground.height,roofHeight:roof.height,name:campus.name,sourceId:campus.id,
  }}}));
}
function compile(snapshot, elevation, urban = null, options = {}, signal = null, onProgress = null) {
  return compiler.compile({snapshot,elevation,options:{...options,urban}},{signal,onProgress});
}
function updateBaseControls(data) {
  updateCampusMarker(data,currentSite.id);
  document.querySelector('#sceneEnter').disabled=false;
  document.querySelector('#sceneShops').hidden=!data.commercialFocus;
  document.querySelector('#sceneAirport').hidden=!data.airportFocus;
  document.querySelector('#sceneParks').hidden=!data.recreationFocus;
}
function readyStatus(data) {
  if(data.stage==='preview')return 'Map ready · adding buildings, gardens and city life…';
  const s=data.stats;
  return `Ready · ${s.dataCenters} data-center halls · ${(s.canopyCrowns||s.trees).toLocaleString()} tree crowns${s.crops?' · wheat fields':''}${s.grassSurface?' · textured ground':''}`;
}
async function prepare(site, rebuild = false) {
  const token = ++generation;
  prepareAbort?.abort();prepareAbort=new AbortController();
  const signal=prepareAbort.signal;prepareStarted=performance.now();
  pending = true; currentSite = site; sceneData = baseData = null;worldFocus=null;
  streamer?.reset({lat:site.lat,lon:site.lon});
  document.querySelector('#campusPlumeNote').hidden = site.effects?.plume !== true;
  failedGeneration = -1;
  document.querySelector('#sceneDock').dataset.ready = 'false';
  document.querySelector('#sceneDock').dataset.streamState='idle';
  Object.assign(document.querySelector('#sceneDock').dataset,{loadStage:'fetching',firstVisibleMs:'',detailVisibleMs:''});
  setActive(false);
  removeModel();
  status('Loading the map…');
  document.querySelector('#sceneEnter').disabled = true;
  try {
    const key = site.id;
    if (rebuild) generated.delete(key);
    let entered=false;
    const acceptStage=(data)=>{
      if(token!==generation||signal.aborted)return;
      if(data.stage==='detail')failedGeneration=-1;
      sceneData=baseData=data;streamer?.setAnchor(data.center);updateBaseControls(data);
      document.querySelector('#sceneDock').dataset.loadStage=data.stage==='preview'?'uploading-map':'uploading-detail';
      status(data.stage==='preview'?'Opening mapped streets and terrain…':'Adding detailed buildings, gardens and city life…');
      evaluateCamera();
      if(!entered&&q.get('view')==='3d'&&token===1){entered=true;enter(q.get('focus')==='fields'?true:q.get('focus')||false);}
    };
    let data=generated.get(key);
    if(!data){
      const optional=(name)=>fetch(`data/neighborhoods/${name}-${site.id}.json`,{signal}).then(r=>r.ok?r.json():null).catch(error=>{if(signal.aborted)throw error;return null;});
      // Fetch supplementary data alongside the map rather than after parsing it.
      const [snapshot,elevation,urban,recreation]=await Promise.all([
        fetch(`data/neighborhoods/${site.id}.json`,{signal}).then(async response=>{
          if(!response.ok)throw new Error('Map snapshot unavailable for this location');
          const snapshot=await response.json();if(snapshot.status==='failed')throw new Error('This map snapshot is not available yet');return snapshot;
        }),optional('elevation'),optional('urban'),optional('recreation'),
      ]);
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      data=await compile(snapshot,elevation,urban,{recreation},signal,acceptStage);
    }else acceptStage(data);
    if (token !== generation) return;
    generated.delete(key);generated.set(key,data);
    sceneData = baseData = data; pending = false;
    streamer?.setAnchor(data.center);
    updateBaseControls(data);
    // Bound CPU-side cache; visiting a site never leaves old GPU models alive.
    while (generated.size > 2) generated.delete(generated.keys().next().value);
    if(currentPatch?.data===data){paintPatchData(data);ensureOverview(currentPatch);status(readyStatus(data));}
    evaluateCamera();
  } catch (error) {
    if (token !== generation||error.name==='AbortError') return;
    pending = false; status(error.message + (currentPatch?' · The mapped scene remains available.':'. Globe view remains available.'));
    document.querySelector('#sceneEnter').disabled = !baseData;
    console.warn('Low-poly neighborhood', error);
  }
}
function paintPatchData(data) {
  const dock=document.querySelector('#sceneDock'),s=data.stats;
  document.querySelector('#sceneCount').textContent=s.buildings.toLocaleString()+' buildings';
  Object.assign(dock.dataset,{buildings:s.buildings,infill:s.infillBuildings||0,infillByKind:JSON.stringify(s.infillByKind||{}),trees:s.trees,roads:data.roadStats?.renderedRoads||0,urban:JSON.stringify(data.urbanStats||{}),center:JSON.stringify(data.center),ready:'true'});
  document.querySelector('#sceneCount').title=`${s.mappedBuildings||0} mapped buildings + ${s.infillBuildings||0} illustrative homes and businesses along suitable streets`;
  Object.assign(dock.dataset,{recreation:JSON.stringify(data.recreationStats||{}),compile:JSON.stringify(data.compileStats||{})});
}
function setPatchCircle(patch,height) {
  const local=Cesium.Matrix4.multiplyByPoint(patch.inverse,worldFocus||patch.centerCartesian,patch.circleScratch);
  patch.circle.x=local.x;patch.circle.y=local.y;
  patch.circle.radius=streamRadius(height-(sampleElevation(patch.data.elevation,local.x,local.y)??0));
  patch.circleUniform.x=local.x;patch.circleUniform.y=local.y;patch.circleUniform.z=patch.circle.radius;
  for(const asset of patch.assets)asset.shader.setUniform('u_viewCircle',patch.circleUniform);
}
function patchUniforms(patch,asset) {
  asset.shader.setUniform('u_health',lastHealth);
  asset.shader.setUniform('u_year',lastFrameYear);
  asset.shader.setUniform('u_scenario',scenario?1:0);
  asset.shader.setUniform('u_viewCircle',patch.circleUniform);
  asset.shader.setUniform('u_patchRadius',patch.data.radius||3300);
  asset.shader.setUniform('u_patchOpacity',asset.ready?patch.opacity:0);
  asset.shader.setUniform('u_patchRetiring',patch===retiringPatch?1:0);
}
function disposeAsset(asset) {
  asset.removeError?.();
  if(asset.model&&!asset.model.isDestroyed())viewer.scene.primitives.remove(asset.model);
  if(!asset.shader.isDestroyed())asset.shader.destroy();
}
async function makeAsset(patch,buffer,kind) {
  const shader=createLandscapeShader(Cesium,patch.data.elevation,{center:patch.data.center});
  const asset={shader,model:null,kind,ready:false};patchUniforms(patch,asset);
  shader.setUniform('u_patchOpacity',0);
  patch.assets.push(asset);
  const url=URL.createObjectURL(new Blob([buffer],{type:'model/gltf-binary'}));
  try {
    const created=await Cesium.Model.fromGltfAsync({url,modelMatrix:patch.frame,show:true,upAxis:Cesium.Axis.Y,forwardAxis:Cesium.Axis.X,
      allowPicking:true,id:{lowPoly:true},shadows:Cesium.ShadowMode.ENABLED,customShader:shader,
      imageBasedLightingFactor:new Cesium.Cartesian2(.55,.7),cull:false,incrementallyLoadTextures:false});
    asset.model=created;
    if(patch.skyEnvironment)applySkyLighting(Cesium,created,patch.skyEnvironment);
    if(patch.disposed||patch.token!==generation||patch.abort.signal.aborted)throw new DOMException('Aborted','AbortError');
    viewer.scene.primitives.add(created);
    // Parsing finished before GPU readiness. Coverage is zero while the actual
    // scene compiles shaders/uploads buffers; keep the working patch visible.
    await waitForModelReady(created,patch.abort.signal);
    if(patch.disposed||patch.token!==generation)throw new DOMException('Aborted','AbortError');
    asset.ready=true;
    asset.removeError=created.errorEvent.addEventListener((error)=>{
      if(patch.disposed||patch.token!==generation)return;
      if(kind==='overview'){
        patch.overview=null;patch.overviewActive=false;
        patch.assets=patch.assets.filter((a)=>a!==asset);disposeAsset(asset);
        if(patch===currentPatch)overviewModel=null;
        evaluateCamera();console.warn('Overview detail unavailable',error);return;
      }
      if(patch!==currentPatch)return;
      failedGeneration=generation;streamer.cancel();
      for(const item of [currentPatch,retiringPatch])for(const a of item?.assets||[])a.model.show=false;
      setActive(false);status('3D rendering failed; Globe remains available.');console.error(error);
    });
    return asset;
  } catch(error) {
    patch.assets=patch.assets.filter((a)=>a!==asset);
    if(asset.model){
      if(!asset.model.isDestroyed()){
        if(!viewer.scene.primitives.remove(asset.model))asset.model.destroy();
      }
    }
    if(!shader.isDestroyed())shader.destroy();
    throw error;
  } finally {URL.revokeObjectURL(url);}
}
function attachPatchControllers(patch) {
  const data=patch.data,token=patch.token;
  // Documented combustion belongs to the selected facility in its base patch.
  // A newly streamed mapped data center must not inherit that attribution.
  campusEffects=patch.base&&data.stage!=='preview'?attachCampusEffects(viewer,currentSite,data):null;
  if(campusEffects)patch.controllers.push(campusEffects);
  campusEffects?.setYear(lastFrameYear,lastRow,lastPhase);
  lastQuality=currentQuality();
  if(data.stage!=='preview'){
  cityLife=attachCityLife(viewer,currentSite,{...data,viewCircle:()=>patch.circle,
    heightOffset:(x,y)=>scenario?scenarioHeightOffset(x,y,lastFrameYear,data.elevation?.extentM):0,
    onActivity:(activity)=>{
      if(token!==generation||patch!==currentPatch)return;
      const el=document.querySelector('#sceneActivity');el.hidden=!active;
      el.textContent='City life · '+(activity.cars||0)+' vehicles · '+(activity.planes||0)+' aircraft'+(activity.moving===false?' · motion paused':'');
      Object.assign(el.dataset,{cars:activity.cars||0,planes:activity.planes||0,carsInView:activity.carsInView||0,planesInView:activity.planesInView||0,
        routes:activity.routeCount||0,aircraftScreen:JSON.stringify(activity.aircraftScreen||[]),focus:JSON.stringify(activity.focus||{}),
        closestRoad:activity.closestRoadM??'',moving:String(activity.moving!==false),carModels:activity.carModels||0,carPoints:activity.carPoints||0,
        coverageMode:activity.coverageMode||'',coverageRebuilds:activity.coverageRebuilds||0,visibleRoadCells:activity.visibleRoadCells||0,majorRoadCells:activity.majorRoadCells||0,coveredRoadCells:activity.coveredRoadCells||0,majorRoadVehiclesInView:activity.majorRoadVehiclesInView||0,coverageUpdateMs:activity.coverageUpdateMs||0});
    }});
  patch.controllers.push(cityLife);
  cityLife.setQuality(lastQuality);
  }
  localAtmosphere=attachLocalAtmosphere(viewer,currentSite,{...data,viewCircle:()=>patch.circle,skyNight:()=>currentLightMode()==='night',
    onSkyState:(sky)=>{
      if(patch.disposed||patch!==currentPatch)return;
      Object.assign(document.querySelector('#sceneDock').dataset,{sky:sky.environment||sky.id,skyReady:String(sky.ready),skyBasis:sky.basis});
      document.querySelector('#sceneSkyState').textContent=`EXR sky · ${sky.environment||sky.id} · ${sky.basis}. Illustrative cloud cover.`;
    },
    onSkyEnvironment:(environment)=>{
      if(patch.disposed||patch!==currentPatch)return;
      patch.skyEnvironment=environment;
      for(const asset of patch.assets)applySkyLighting(Cesium,asset.model,environment);
    }});
  patch.controllers.push(localAtmosphere);
  localAtmosphere.setYear(lastFrameYear,lastRow,lastPhase);localAtmosphere.setQuality(lastQuality);
}
function ensureOverview(patch) {
  if(!patch||patch.disposed||patch.overviewStarted||!patch.data.overviewBuffer||!patch.ready)return;
  patch.overviewStarted=true;
  makeAsset(patch,patch.data.overviewBuffer,'overview').then(asset=>{
    if(patch.disposed)return;
    patch.overview=asset;patchUniforms(patch,asset);
    if(patch===currentPatch)overviewModel=asset.model;
    evaluateCamera();
  }).catch(error=>{if(error.name!=='AbortError')console.warn('Overview detail unavailable',error);});
}
async function showData(data,base=false,signal=null) {
  if(currentPatch?.data===data&&!currentPatch.disposed)return currentPatch;
  if(uploadingPatch?.data===data)return uploadingPatch.promise;
  // No third GPU patch: finish the previous retirement before uploading again.
  if(retiringPatch){
    // Finish an interrupted handoff before dropping its complementary pixels.
    // A subsequent failed/aborted upload must leave the current scene opaque.
    if(currentPatch){currentPatch.opacity=1;for(const asset of currentPatch.assets)asset.shader.setUniform('u_patchOpacity',asset.ready?1:0);}
    disposePatch(retiringPatch);retiringPatch=null;
  }
  if(uploadingPatch)disposePatch(uploadingPatch);
  const frame=Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(data.center.lon,data.center.lat));
  const patch={id:++patchSequence,token:generation,data,base,frame,inverse:Cesium.Matrix4.inverseTransformation(frame,new Cesium.Matrix4()),
    centerCartesian:Cesium.Cartesian3.fromDegrees(data.center.lon,data.center.lat),circle:{x:0,y:0,radius:2400},circleScratch:new Cesium.Cartesian3(),
    circleUniform:new Cesium.Cartesian3(0,0,2400),assets:[],controllers:[],abort:new AbortController(),opacity:0,overviewActive:false,disposed:false,ready:false};
  const abort=()=>patch.abort.abort();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  uploadingPatch=patch;
  setPatchCircle(patch,viewer.camera.positionCartographic.height);
  patch.promise=(async()=>{
    try {
      patch.close=await makeAsset(patch,data.buffer,'close');
      if(patch.abort.signal.aborted||patch.token!==generation)throw new DOMException('Aborted','AbortError');
      patch.ready=true;
      const old=currentPatch;
      disposeControllers(old);campusEffects=cityLife=localAtmosphere=null;
      retiringPatch=old;currentPatch=patch;uploadingPatch=null;sceneData=data;
      patch.started=performance.now();patch.opacity=old?0:1;
      model=patch.close.model;overviewModel=null;overviewActive=false;
      if(old){old.retired=patch.started;for(const a of old.assets)a.shader.setUniform('u_patchRetiring',1);}
      for(const asset of patch.assets)patchUniforms(patch,asset);
      try{attachPatchControllers(patch);}catch(error){console.warn('Optional city activity unavailable',error);}
      paintPatchData(data);
      const dock=document.querySelector('#sceneDock');
      dock.dataset.loadStage=data.stage==='preview'?'preview':'ready';
      status(readyStatus(data));
      document.querySelector('#campusPlumeNote').hidden=!base||currentSite.effects?.plume!==true;
      setActive(active,true);evaluateCamera();
      ensureOverview(patch);
      return patch;
    } catch(error) {
      disposePatch(patch);if(uploadingPatch===patch)uploadingPatch=null;
      if(patch.token===generation&&error.name!=='AbortError'){
        failedUploads.add(data);
        if(!currentPatch){failedGeneration=generation;setActive(false);}
        status('Could not load this area. Existing scenery and Globe remain available.');console.warn('Neighborhood load',error);
      }
      throw error;
    } finally {signal?.removeEventListener('abort',abort);}
  })();
  return patch.promise;
}
function loadModel() {
  if(!sceneData||failedUploads.has(sceneData)||currentPatch?.data===sceneData||uploadingPatch?.data===sceneData||failedGeneration===generation)return;
  showData(sceneData,sceneData===baseData).catch(()=>{});
}
function tickPatches() {
  const at=performance.now();
  if(retiringPatch){
    const weights=fadeWeights(at-currentPatch.started);
    currentPatch.opacity=weights.incoming;retiringPatch.opacity=weights.outgoing;
    for(const patch of [currentPatch,retiringPatch])for(const asset of patch.assets)asset.shader.setUniform('u_patchOpacity',asset.ready?patch.opacity:0);
    if(weights.outgoing===0){disposePatch(retiringPatch);retiringPatch=null;}
  }
  if(at-lastCameraCheck<1000)return;
  lastCameraCheck=at;
  const resident=[currentPatch,retiringPatch,uploadingPatch].filter((p)=>p&&!p.disposed);
  document.querySelector('#sceneDock').dataset.patchCount=resident.length;
  document.querySelector('#sceneDock').dataset.gpuModels=resident.reduce((n,p)=>n+p.assets.filter((a)=>a.model&&!a.model.isDestroyed()).length,0);
  evaluateCamera();
  if(!currentPatch||!active||pending)return;
  const height=viewer.camera.positionCartographic.height;
  const geographic=worldFocus?Cesium.Cartographic.fromCartesian(worldFocus):null;
  if(geographic)streamer.update({lat:Cesium.Math.toDegrees(geographic.latitude),lon:Cesium.Math.toDegrees(geographic.longitude)},
    {enabled:enabled&&active,height:height-(sampleElevation(sceneData.elevation,currentPatch.circle.x,currentPatch.circle.y)??0)});
}

function setActive(value,force=false) {
  if(value&&currentPatch?.ready){
    const dock=document.querySelector('#sceneDock');
    if(!dock.dataset.firstVisibleMs)dock.dataset.firstVisibleMs=Math.round(performance.now()-prepareStarted);
    if(currentPatch.data.stage!=='preview'&&!dock.dataset.detailVisibleMs)dock.dataset.detailVisibleMs=Math.round(performance.now()-prepareStarted);
  }
  if (active === value){if(force)for(const controller of currentPatch?.controllers||[])controller.setActive(active);return;}
  active = value;
  campusEffects?.setActive(active);
  cityLife?.setActive(active);
  localAtmosphere?.setActive(active);
  document.body.classList.toggle('lowpoly-active', active);
  document.querySelector('#sceneMode').textContent = active ? 'Low-poly neighborhood' : 'Globe view';
  document.querySelector('#sceneGlobe').hidden = !active;
  document.querySelector('#sceneEnter').textContent = 'Campus ↗';
  if (active) {
    const bias = viewer.shadowMap._primitiveBias;
    savedScene = { light: viewer.scene.light, hdr: viewer.scene.highDynamicRange, bloom: viewer.scene.postProcessStages.bloom.enabled, shadowDistance: viewer.shadowMap.maximumDistance,
      primitiveBias: bias ? { depthBias: bias.depthBias, normalOffsetScale: bias.normalOffsetScale } : null };
    viewer.shadowMap.maximumDistance = 1800;
    viewer.shadowMap.normalOffset = true;
    // Cesium 1.121 scales native-terrain bias by view distance, but glTF ground
    // receives the unscaled primitive bias. Match its neighbourhood-scale bias
    // so broad ground facets do not turn into repeating self-shadow stripes.
    // Guard this version-specific hook and restore it when returning to the globe.
    if (bias) { bias.depthBias = 0.0006; bias.normalOffsetScale = 0.5; }
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(currentSite.lon, currentSite.lat));
    const direction = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(-0.45, 0.35, -0.85), new Cesium.Cartesian3());
    viewer.scene.light = new Cesium.DirectionalLight({ direction: Cesium.Cartesian3.normalize(direction, direction), intensity: 1.3 });
    viewer.scene.highDynamicRange = false; viewer.scene.postProcessStages.bloom.enabled = false;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 12;
  } else if (savedScene) {
    viewer.scene.light = savedScene.light; viewer.scene.highDynamicRange = savedScene.hdr; viewer.scene.postProcessStages.bloom.enabled = savedScene.bloom;
    viewer.shadowMap.maximumDistance = savedScene.shadowDistance;
    if (savedScene.primitiveBias && viewer.shadowMap._primitiveBias) Object.assign(viewer.shadowMap._primitiveBias, savedScene.primitiveBias);
    savedScene = null;
  }
  document.querySelector('#sceneActivity').hidden=!active;
  window.dispatchEvent(new CustomEvent('cs:scene-mode', { detail: { active, siteId:currentSite?.id } }));
}
function evaluateCamera() {
  if (!viewer || !currentSite) return;
  const height = viewer.camera.positionCartographic.height;
  const focus = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2), viewer.scene.globe.ellipsoid);
  if(focus)worldFocus=focus;
  const center = Cesium.Cartesian3.fromDegrees(currentSite.lon, currentSite.lat);
  const nearBase=focus&&Cesium.Cartesian3.distance(focus,center)<(baseData?.radius||3300)*1.65;
  const nearLoaded=focus&&currentPatch&&!currentPatch.disposed&&Cesium.Cartesian3.distance(focus,currentPatch.centerCartesian)<(currentPatch.data.radius||3300)*1.65;
  const nearby = active || nearBase || nearLoaded;
  const close = enabled && nearby && failedGeneration !== generation && height < (active ? EXIT_HEIGHT : ENTER_HEIGHT);
  // Start GPU upload during the approach, before the low-poly switch. Assets
  // remain hidden outside close mode, but zooming no longer starts a cold upload.
  if (enabled && nearby && height < WARM_HEIGHT && sceneData) loadModel();
  const threshold = lastQuality === 'low' ? 900 : 1500;
  for(const patch of [currentPatch,retiringPatch,uploadingPatch]){
    if(!patch||patch.disposed)continue;
    setPatchCircle(patch,height);
    if(!patch.ready)continue;
    const ground=sampleElevation(patch.data.elevation,patch.circle.x,patch.circle.y)??0;
    if(patch.overview)patch.overviewActive=height-ground>threshold+(patch.overviewActive?-180:180);
    patch.close.model.show=!!close&&!patch.overviewActive;
    if(patch.overview)patch.overview.model.show=!!close&&patch.overviewActive;
  }
  overviewActive=currentPatch?.overviewActive||false;
  document.querySelector('#sceneDock').dataset.detail = overviewActive ? 'overview' : 'close';
  setActive(!!(close && currentPatch?.ready));
  if(!close)streamer?.cancel();
}
function enter(fields = false) {
  if (!baseData || !currentSite) return;
  streamer.cancel();streamer.setAnchor(baseData.center);
  if(currentPatch&&currentPatch.data!==baseData)showData(baseData,true).catch(()=>{});
  const data=baseData;
  enabled = true; document.querySelector('#sceneAuto').checked = true;
  const f = (fields === true ? data.fieldFocus : fields === 'homes' ? data.focus : fields==='shops'?data.commercialFocus:fields==='airport'?data.airportFocus:fields==='parks'?data.recreationFocus:data.campusFocus) || { x: 0, y: 0 };
  const height=(sampleElevation(data.elevation,f.x,f.y)??0)+4-(f.x*f.x+f.y*f.y)/(2*6371000)+(scenario?scenarioHeightOffset(f.x,f.y,lastFrameYear,data.elevation?.extentM):0);
  const frame=Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(data.center.lon,data.center.lat));
  const position=Cesium.Matrix4.multiplyByPoint(frame,new Cesium.Cartesian3(f.x,f.y,height),new Cesium.Cartesian3());
  const range = fields === 'airport'?1800:fields===true||fields==='homes'||fields==='shops'||fields==='parks'?650:Math.max(850,Math.hypot(f.width||0,f.depth||0)*1.7);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(position, 20), { offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-25), Cesium.Math.toRadians(fields==='horizon'?-8:-32), range), duration: 1.8 });
}
function exit() {
  streamer?.cancel();
  if (currentSite) cs.flyTo(currentSite.lat, currentSite.lon, 21, -40, 20, 1.7);
}
function init(context) {
  cs = context; viewer = cs.viewer; mountControls();
  streamer=createSceneStreamer({
    request:(point,signal)=>{const key=streamKey(point).split(',');return fetch('/api/neighborhood?lat='+encodeURIComponent(key[0])+'&lon='+encodeURIComponent(key[1]),{signal});},
    prepare:(response,signal)=>compile(response.snapshot,response.elevation,response.urban,{recreation:response.recreation,maxBuildings:3000,maxInfillBuildings:1200,maxTrees:1800,maxCrops:1800,maxGrass:1000},signal),
    onReady:(data,point,signal)=>showData(data,false,signal),
    onState:({state,error})=>{
      document.querySelector('#sceneDock').dataset.streamState=state;
      if(state==='loading')status('Loading mapped scenery ahead… Current scenery remains available.');
      if(state==='building'||state==='uploading')status('Preparing mapped streets and landscape ahead…');
      if(state==='ready')status('Mapped scenery ready · pan to explore. Study measurements remain anchored to the selected site.');
      if(state==='failed')status((error||'Mapped scenery unavailable')+'. Existing scenery remains available; retrying later.');
    },
  });
  viewer.scene.preRender.addEventListener(tickPatches);
  viewer.camera.percentageChanged = 0.035;
  viewer.camera.changed.addEventListener(evaluateCamera);
  window.addEventListener('cs:site', (event) => { if (event.detail?.site) prepare(event.detail.site); });
  window.addEventListener('cs:year', (event) => {
    if (event.detail.siteId && event.detail.siteId !== currentSite?.id) return;
    lastFrameYear = event.detail.year;
    lastHealth = event.detail.health ?? 1;
    lastRow = event.detail.row || {}; lastPhase = event.detail.phase || 'observed';
    campusEffects?.setYear(lastFrameYear, lastRow, lastPhase);
    localAtmosphere?.setYear(lastFrameYear, lastRow, lastPhase);
    if(baseData)updateCampusMarker(baseData,currentSite.id);
    for(const patch of [currentPatch,retiringPatch,uploadingPatch])for(const asset of patch?.assets||[])patchUniforms(patch,asset);
  });
  window.addEventListener('cs:quality', (event) => {
    lastQuality = event.detail.quality;
    cityLife?.setQuality(lastQuality); localAtmosphere?.setQuality(lastQuality);
    evaluateCamera();
    if (active) { viewer.scene.highDynamicRange = false; viewer.scene.postProcessStages.bloom.enabled = false; }
  });
  // Scientific raster layers retain their real geospatial coverage in map view.
  window.addEventListener('cs:map-layer', (event) => {
    if (active && !['none', 'HLS'].includes(event.detail.kind)) exit();
  });
  if (cs.state.site) prepare(cs.state.site);
  window.CloudShadowNeighborhood = { enter, exit, get active(){return active;},get pending(){return pending||!!uploadingPatch||streamer.pending;},get streamState(){return streamer.state;},get center(){return sceneData?.center;} };
}
if (window.CloudShadow) init(window.CloudShadow);
else window.addEventListener('cs:ready', (event) => init(event.detail), { once: true });
