// Zoom-driven local 3D scenery. Mapped layout, authored low-poly architecture.
import { createLandscapeShader } from './landscape-shader.js';
import { sampleElevation, scenarioHeightOffset } from './landscape.js';
import { attachCampusEffects } from './campus-effects.js';
import { attachCityLife } from './city-life.js';
import { attachLocalAtmosphere } from './local-atmosphere.js';
import { quality as currentQuality } from './fx.js';
const ENTER_HEIGHT = 5800, EXIT_HEIGHT = 7600;
let cs, viewer, currentSite, model, sceneData, active = false, enabled = true, generation = 0;
let pending = false, scenario = false, lastFrameYear = 2025, lastHealth = 1, savedScene, worker;
let failedGeneration = -1;
let campusEffects, cityLife, localAtmosphere, overviewModel, overviewActive = false, lastQuality = 'high', lastRow = {}, lastPhase = 'observed';
const loadingGenerations = new Set();
const generated = new Map(), workerJobs = new Map();
let workerId = 0;
const q = new URLSearchParams(location.search);

function mountControls() {
  const dock = document.createElement('section');
  dock.id = 'sceneDock'; dock.setAttribute('aria-label', '3D neighborhood');
  dock.innerHTML = `<div class="scene-heading"><span class="scene-dot"></span><strong id="sceneMode">Globe view</strong><span id="sceneCount"></span></div>
    <div class="scene-actions"><button id="sceneEnter" class="primary">Campus ↗</button><button id="sceneHomes">Homes ↗</button><button id="sceneFields">Fields ↗</button><button id="sceneGlobe" hidden>Globe ↗</button><label class="scene-auto"><input id="sceneAuto" type="checkbox" checked>Auto</label></div>
    <div id="sceneStatus" role="status">Zoom closer to reveal the neighborhood.</div>
    <div id="sceneActivity" style="font-size:10px;color:#a9c9be;margin-top:5px" hidden></div>
    <div style="font-size:9px;color:#91a9ac;margin-top:6px"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" style="color:inherit">© OpenStreetMap contributors</a> · <a href="https://open-meteo.com/en/docs/elevation-api" target="_blank" rel="noopener" style="color:inherit">Copernicus / Open-Meteo</a></div>
    <div id="campusPlumeNote" hidden style="font-size:10px;color:#adbdc3;margin-top:6px">Illustrative combustion plume; not measured visible smoke.</div>
    <details class="scene-notes"><summary>Landscape &amp; map details</summary><label><input id="terrainScenario" type="checkbox"> Terrain evolution scenario</label><p id="landscapeState">Present-day mapped buildings, roads, farms, forests and water. Architecture, planting, traffic and aircraft are illustrative.</p><p>Vegetation changes illustrate the site's NDVI signal, not measured crop death or yield. Terrain scenarios are illustrative. Elevation is interpolated from the available reference DEM.</p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a></details>`;
  document.body.appendChild(dock);
  const style = document.createElement('style');
  style.textContent = `#sceneDock{position:fixed;left:calc(var(--panel-width,300px) + 18px);top:92px;z-index:7;width:350px;background:#101a23ed;border:1px solid #ffffff1c;border-radius:12px;padding:12px 14px;box-shadow:0 8px 24px #0002;backdrop-filter:blur(12px);font-size:12px}.scene-heading{display:flex;align-items:center;gap:8px}.scene-heading strong{font-size:12px;letter-spacing:.4px}.scene-dot{width:7px;height:7px;background:#7f9ba4;border-radius:50%;flex:none}body.lowpoly-active .scene-dot{background:#7cdbc1;box-shadow:0 0 9px #7cdbc155}#sceneCount{margin-left:auto;color:#a7bcc5;font-size:10px}.scene-actions{display:flex;gap:6px;margin-top:10px;align-items:center}.scene-actions button{font-size:11px;padding:6px 8px}.scene-auto{margin-left:auto;font-size:11px;color:#acbcc6;display:flex;gap:4px;align-items:center}#sceneStatus{color:#9eafb9;font-size:11px;margin-top:8px;line-height:1.4}.scene-notes{margin-top:8px;font-size:10px;color:#94a4af}.scene-notes summary{cursor:pointer;color:#aabac2}.scene-notes label{display:flex;gap:6px;align-items:center;margin:10px 0}.scene-notes p{line-height:1.5;margin:7px 0}.scene-notes a{color:#92c5bb}#gpu-info{top:92px!important;font-size:10px!important;max-width:360px!important}@media(max-width:680px){#sceneDock{left:14px;top:110px;width:min(350px,calc(100vw - 28px))}#gpu-info{display:none}}`;
  document.head.appendChild(style);
  document.querySelector('#sceneEnter').onclick = () => enter();
  document.querySelector('#sceneHomes').onclick = () => enter('homes');
  document.querySelector('#sceneFields').onclick = () => enter(true);
  document.querySelector('#sceneGlobe').onclick = () => exit();
  document.querySelector('#sceneAuto').onchange = (e) => { enabled = e.target.checked; evaluateCamera(); };
  document.querySelector('#terrainScenario').onchange = (e) => {
    scenario = e.target.checked;
    document.querySelector('#landscapeState').textContent = scenario ? 'TERRAIN SCENARIO · move the timeline from 2025 toward 2035 to see illustrative uplift, erosion and changing shorelines. Not a historical reconstruction or forecast.' : 'Present-day mapped buildings, farms, forests and water. Roofs, missing heights and planting are illustrative.';
    for (const item of [model, overviewModel]) item?.customShader?.setUniform('u_scenario', scenario ? 1 : 0);
    if(sceneData)updateCampusMarker(sceneData,currentSite.id);
    document.querySelector('#sceneMode').textContent = active ? (scenario ? 'Landscape scenario' : 'Low-poly neighborhood') : 'Globe view';
  };
}
const status = (message) => { const el = document.querySelector('#sceneStatus'); if (el) el.textContent = message; };
function removeModel() {
  campusEffects?.destroy(); campusEffects = null;
  cityLife?.destroy(); cityLife = null;
  localAtmosphere?.destroy(); localAtmosphere = null;
  for (const item of [model, overviewModel]) if (item) {
    const shader = item.customShader;
    viewer.scene.primitives.remove(item);
    if (shader && !shader.isDestroyed()) shader.destroy();
  }
  model = overviewModel = null; overviewActive = false;
  document.querySelector('#sceneActivity').hidden = true;
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
function compile(snapshot, elevation, urban = null, options = {}) {
  worker ||= new Worker(new URL('./neighborhood-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = workerJobs.get(data.id); if (!job) return;
    workerJobs.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
  };
  worker.onerror = (event) => {
    for (const job of workerJobs.values()) job.reject(new Error(event.message || 'Neighborhood generator failed'));
    workerJobs.clear(); worker.terminate(); worker = null;
  };
  return new Promise((resolve, reject) => {
    const id = ++workerId; workerJobs.set(id, { resolve, reject });
    worker.postMessage({ id, snapshot, elevation, options:{...options,urban} });
  });
}
async function prepare(site, rebuild = false) {
  const token = ++generation;
  pending = true; currentSite = site; sceneData = null;
  document.querySelector('#campusPlumeNote').hidden = site.effects?.plume !== true;
  failedGeneration = -1;
  document.querySelector('#sceneDock').dataset.ready = 'false';
  setActive(false);
  removeModel();
  status('Preparing mapped streets, homes and landscape…');
  document.querySelector('#sceneEnter').disabled = true;
  try {
    const key = site.id;
    if (rebuild) generated.delete(key);
    if (!generated.has(key)) {
      const promise = (async () => {
      const response = await fetch(`data/neighborhoods/${site.id}.json`);
      if (!response.ok) throw new Error('Map snapshot unavailable for this location');
      const snapshot = await response.json();
      if (snapshot.status === 'failed') throw new Error('This map snapshot is not available yet');
      const [elevation,urban] = await Promise.all([
        fetch(`data/neighborhoods/elevation-${site.id}.json`).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch(`data/neighborhoods/urban-${site.id}.json`).then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      return compile(snapshot, elevation, urban);
      })();
      generated.set(key, promise);
      promise.catch(() => { if (generated.get(key) === promise) generated.delete(key); });
    }
    const data = await generated.get(key);
    if (token !== generation) return;
    sceneData = data; pending = false;
    updateCampusMarker(data,site.id);
    // Bound CPU-side cache; visiting a site never leaves old GPU models alive.
    while (generated.size > 2) generated.delete(generated.keys().next().value);
    document.querySelector('#sceneEnter').disabled = false;
    const s = data.stats;
    document.querySelector('#sceneCount').textContent = `${s.buildings.toLocaleString()} buildings`;
    document.querySelector('#sceneDock').dataset.buildings = s.buildings;
    document.querySelector('#sceneDock').dataset.trees = s.trees;
    document.querySelector('#sceneDock').dataset.roads = data.roadStats?.renderedRoads || 0;
    document.querySelector('#sceneDock').dataset.urban = JSON.stringify(data.urbanStats || {});
    status(`Ready · ${s.dataCenters} data-center halls · ${(s.canopyCrowns || s.trees).toLocaleString()} tree crowns${s.crops ? ' · wheat fields' : ''}${s.grass ? ' · meadow cover' : ''}`);
    evaluateCamera();
    if (q.get('view') === '3d' && token === 1) enter(q.get('focus') === 'fields');
  } catch (error) {
    if (token !== generation) return;
    pending = false; status(error.message + '. Globe view remains available.');
    document.querySelector('#sceneEnter').disabled = true;
    console.warn('Low-poly neighborhood', error);
  }
}
async function loadModel() {
  if (!sceneData || model || loadingGenerations.has(generation) || failedGeneration === generation) return;
  const token = generation, data = sceneData;
  loadingGenerations.add(token);
  const url = URL.createObjectURL(new Blob([data.buffer], { type: 'model/gltf-binary' }));
  let shader, created;
  try {
    const matrix = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(data.center.lon, data.center.lat));
    shader = createLandscapeShader(Cesium, data.elevation);
    shader.setUniform('u_health', lastHealth); shader.setUniform('u_year', lastFrameYear); shader.setUniform('u_scenario', scenario ? 1 : 0);
    created = await Cesium.Model.fromGltfAsync({ url, modelMatrix: matrix, upAxis: Cesium.Axis.Y, forwardAxis: Cesium.Axis.X, allowPicking: true, id: { lowPoly: true }, shadows: Cesium.ShadowMode.ENABLED,
      customShader: shader, imageBasedLightingFactor: new Cesium.Cartesian2(0.55, 0.7), cull: false, incrementallyLoadTextures: false });
    if (token !== generation) { created.destroy(); if (!shader.isDestroyed()) shader.destroy(); return; }
    model = viewer.scene.primitives.add(created);
    campusEffects = attachCampusEffects(viewer, currentSite, data);
    campusEffects.setYear(lastFrameYear, lastRow, lastPhase);
    lastQuality = currentQuality();
    cityLife = attachCityLife(viewer, currentSite, {...data,heightOffset:(x,y)=>scenario?scenarioHeightOffset(x,y,lastFrameYear,data.elevation?.extentM):0,onActivity:(activity)=>{
      if(token!==generation)return;
      const el=document.querySelector('#sceneActivity');
      el.hidden=!active;
      el.textContent=`City life · ${activity.cars || 0} cars · ${activity.planes || 0} aircraft${activity.moving===false?' · motion paused':''}`;
      el.dataset.cars=activity.cars || 0; el.dataset.planes=activity.planes || 0;
      el.dataset.carsInView=activity.carsInView || 0; el.dataset.planesInView=activity.planesInView || 0;
      el.dataset.routes=activity.routeCount || 0;
      el.dataset.aircraftScreen=JSON.stringify(activity.aircraftScreen || []);
      el.dataset.focus=JSON.stringify(activity.focus || {});
      el.dataset.closestRoad=activity.closestRoadM ?? '';
      el.dataset.moving=String(activity.moving !== false);
    }});
    cityLife.setQuality(lastQuality);
    localAtmosphere = attachLocalAtmosphere(viewer, currentSite, data);
    localAtmosphere.setYear(lastFrameYear, lastRow, lastPhase);
    localAtmosphere.setQuality(lastQuality);
    model.errorEvent.addEventListener((error) => {
      if (token !== generation || model !== created) return;
      failedGeneration = token; model.show = false; if (overviewModel) overviewModel.show = false;
      setActive(false); status('3D rendering failed; Globe remains available.'); console.error(error);
    });
    evaluateCamera();
    document.querySelector('#sceneDock').dataset.ready = 'true';
    // Compile the overview off the main thread too, then swap visibility using
    // hysteresis. Loading the second GPU model never hides the working close view.
    if (data.overviewBuffer) {
      const overviewUrl = URL.createObjectURL(new Blob([data.overviewBuffer], {type:'model/gltf-binary'}));
      const overviewShader = createLandscapeShader(Cesium, data.elevation);
      try {
        const coarse = await Cesium.Model.fromGltfAsync({url:overviewUrl,modelMatrix:matrix,upAxis:Cesium.Axis.Y,forwardAxis:Cesium.Axis.X,
          show:false,shadows:Cesium.ShadowMode.ENABLED,customShader:overviewShader,imageBasedLightingFactor:new Cesium.Cartesian2(.55,.7),cull:false});
        if (token !== generation) { coarse.destroy(); if (!overviewShader.isDestroyed()) overviewShader.destroy(); }
        else {
          overviewModel = viewer.scene.primitives.add(coarse);
          coarse.errorEvent.addEventListener((error) => {
            if (token !== generation || overviewModel !== coarse) return;
            overviewModel = null; overviewActive = false;
            viewer.scene.primitives.remove(coarse);
            if (!overviewShader.isDestroyed()) overviewShader.destroy();
            console.warn('Overview detail unavailable',error); evaluateCamera();
          });
          overviewShader.setUniform('u_health',lastHealth); overviewShader.setUniform('u_year',lastFrameYear); overviewShader.setUniform('u_scenario',scenario?1:0);
          evaluateCamera();
        }
      } catch(error) { if (!overviewShader.isDestroyed()) overviewShader.destroy(); console.warn('Overview detail unavailable',error); }
      finally { URL.revokeObjectURL(overviewUrl); }
    }
  } catch (error) {
    if (created && model === created) { setActive(false); removeModel(); }
    else if (created && !created.isDestroyed()) created.destroy();
    if (shader && !shader.isDestroyed()) shader.destroy();
    if (token === generation) { failedGeneration = token; status('Unable to display 3D scenery: ' + error.message); console.error(error); }
  }
  finally { URL.revokeObjectURL(url); loadingGenerations.delete(token); if (token !== generation) evaluateCamera(); }
}
function setActive(value) {
  if (active === value) return;
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
    // Cesium is pinned to 1.121. Its glTF terrain receives the smaller primitive
    // bias; use its native-terrain bias to avoid self-shadow stripes on broad facets.
    // Guard this version-specific hook and restore it when returning to the globe.
    if (bias) { bias.depthBias = 0.0001; bias.normalOffsetScale = 0.5; }
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
  const center = Cesium.Cartesian3.fromDegrees(currentSite.lon, currentSite.lat);
  const nearby = focus && Cesium.Cartesian3.distance(focus, center) < (sceneData?.radius || 3300) * 1.65;
  const close = enabled && nearby && failedGeneration !== generation && height < (active ? EXIT_HEIGHT : ENTER_HEIGHT);
  if (close && sceneData && !model) loadModel();
  const ground = sceneData ? sampleElevation(sceneData.elevation,0,0) ?? 0 : 0;
  const threshold = lastQuality === 'low' ? 900 : 1500;
  if (overviewModel) overviewActive = height - ground > threshold + (overviewActive ? -180 : 180);
  if (model) model.show = !!close && !overviewActive;
  if (overviewModel) overviewModel.show = !!close && overviewActive;
  document.querySelector('#sceneDock').dataset.detail = overviewActive ? 'overview' : 'close';
  setActive(!!(close && model));
}
function enter(fields = false) {
  if (!sceneData || !currentSite) return;
  enabled = true; document.querySelector('#sceneAuto').checked = true;
  const f = (fields === true ? sceneData.fieldFocus : fields === 'homes' ? sceneData.focus : sceneData.campusFocus) || { x: 0, y: 0 };
  const lat = currentSite.lat + f.y / 111320, lon = currentSite.lon + f.x / (111320 * Math.cos(currentSite.lat * Math.PI / 180));
  const height = (sampleElevation(sceneData.elevation, f.x, f.y) ?? 0) + 4 + (scenario?scenarioHeightOffset(f.x,f.y,lastFrameYear,sceneData.elevation?.extentM):0);
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  const range = fields === true ? 650 : fields === 'homes' ? 650 : Math.max(850, Math.hypot(f.width || 0, f.depth || 0) * 1.7);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(position, 20), { offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-25), Cesium.Math.toRadians(-32), range), duration: 1.8 });
}
function exit() {
  if (currentSite) cs.flyTo(currentSite.lat, currentSite.lon, 21, -40, 20, 1.7);
}
function init(context) {
  cs = context; viewer = cs.viewer; mountControls();
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
    if(sceneData)updateCampusMarker(sceneData,currentSite.id);
    for (const item of [model,overviewModel]) if (item?.customShader) {
      item.customShader.setUniform('u_health', lastHealth);
      item.customShader.setUniform('u_year', lastFrameYear);
    }
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
  window.CloudShadowNeighborhood = { enter, exit, get active() { return active; }, get pending() { return pending; } };
}
if (window.CloudShadow) init(window.CloudShadow);
else window.addEventListener('cs:ready', (event) => init(event.detail), { once: true });
