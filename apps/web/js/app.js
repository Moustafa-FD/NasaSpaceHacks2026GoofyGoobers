// Cloud Shadow - main app: globe, panel, charts, ledger, tour.
(async function () {
  const { campusMarkerFromEvent, formatSiteMarkerLabel, siteMarkerPresentation } = await import("./site-marker.js");
  const { MAP_SCALES, PROJECTED_DELTAS, createEvidenceProvider, evidenceTexture } = await import('./evidence-map.js');
  const { createMapTransition, mapCrossfadeAlphas } = await import('./map-transition.js');
  const { trackImageryProvider } = await import('./imagery-readiness.js');
  const { sourceDateForYear, seasonalFallbackDate, mapRequestKey } = await import('./map-source-window.js');
  const $ = (s) => document.querySelector(s);
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(d));
  const fmtP = (p) => (p == null || !isFinite(p) ? "–" : p < 0.001 ? "p < 0.001" : "p = " + p.toFixed(3));
  const toast = (msg, ms = 3500) => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); };

  // ------------------------------------------------------------ data
  const [sitesDoc, hlsDates, appConfig] = await Promise.all([
    fetch("data/sites.json").then((r) => r.json()),
    fetch("data/hls_dates.json").then((r) => r.json()).catch(() => ({})),
    // FOOTPRINT_STORY_SITE (server env / build time) picks the opening study site.
    fetch("config.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    loadCatalog(),
  ]);
  const storyId = appConfig?.storySite, storySite = sitesDoc.sites.find((s) => s.id === storyId);
  const SITES = storySite ? [storySite, ...sitesDoc.sites.filter((s) => s !== storySite)] : sitesDoc.sites, CTX = sitesDoc.context;
  const SERIES = {};
  await Promise.all(SITES.map(async (s) => { try { SERIES[s.id] = (await (await fetch(`data/series/${s.id}.json`)).json()).vars; } catch { SERIES[s.id] = {}; } }));

  // ------------------------------------------------------------ side panel collapse (more globe)
  {
    const toggle = $("#panelToggle"), apply = (collapsed) => {
      document.body.classList.toggle("panel-collapsed", collapsed);
      toggle?.setAttribute("aria-expanded", String(!collapsed));
      if (toggle) toggle.title = collapsed ? "Show the side panel" : "Hide the side panel for a larger globe";
      try { localStorage.setItem("csPanelCollapsed", collapsed ? "1" : "0"); } catch { /* storage optional */ }
    };
    let saved = null; try { saved = localStorage.getItem("csPanelCollapsed"); } catch { /* storage optional */ }
    apply(saved === "1");
    toggle?.addEventListener("click", () => apply(!document.body.classList.contains("panel-collapsed")));
  }

  // ------------------------------------------------------------ globe
  Cesium.Ion.defaultAccessToken = localStorage.getItem("cesiumIonToken") || "";
  const viewer = new Cesium.Viewer("globe", {
    contextOptions: { webgl: { powerPreference: "high-performance" } },
    baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19, credit: "Esri, Maxar, Earthstar Geographics",
    })),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false, geocoder: false, timeline: false, animation: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  });
  const scene = viewer.scene;
  // Zoomed far out, lift the globe above the timeline so the whole Earth stays visible.
  // Re-checked when the camera stops (no per-frame cost); close views keep the full screen.
  {
    const LIFT_ABOVE_M = 2_000_000;
    const updateLift = () => document.body.classList.toggle("globe-lifted", viewer.camera.positionCartographic.height > LIFT_ABOVE_M);
    viewer.camera.moveEnd.addEventListener(updateLift); updateLift();
  }
  // Inspect the actual Cesium context locally with ?gpu=1; no telemetry is sent.
  if (new URLSearchParams(location.search).get("gpu") === "1") {
    const gl = viewer.canvas.getContext("webgl2") || viewer.canvas.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "GPU name unavailable in this browser";
    const gpuInfo = document.createElement("aside");
    gpuInfo.id = "gpu-info";
    gpuInfo.setAttribute("aria-label", "GPU diagnostics");
    gpuInfo.textContent = `Cesium GPU\n${renderer}\nContext power preference: ${gl?.getContextAttributes()?.powerPreference || "unavailable"}`;
    gpuInfo.style.cssText = "position:fixed;top:86px;right:16px;z-index:10;max-width:min(480px,90vw);padding:12px;background:#101820ee;border:1px solid #68bd9b;border-radius:8px;color:#e8fff3;font:12px/1.5 monospace;white-space:pre-wrap;pointer-events:none";
    document.body.appendChild(gpuInfo);
  }
  scene.globe.enableLighting = false;
  scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;
  viewer.cesiumWidget.creditContainer.style.display = "block";
  import('./city-labels.js').then(({ createCityLabels }) => createCityLabels(viewer))
    .catch((error) => console.warn('City labels unavailable:', error.message));

  // Optional: Cesium ion token unlocks 3D terrain + OSM buildings (paste once in console: setIonToken("..."))
  window.setIonToken = (t) => { localStorage.setItem("cesiumIonToken", t); location.reload(); };
  if (Cesium.Ion.defaultAccessToken) {
    try {
      scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
      scene.primitives.add(await Cesium.createOsmBuildingsAsync());
    } catch (e) { console.warn("ion features unavailable", e); }
  }

  // Study-area pins become exact mapped roof pins once a campus is prepared.
  const sitePins = new Map(), campusMarkers = new Map(), neighborPins = [];
  let localMarkerMode = false, electricityView = false;
  for (const s of SITES) {
    const pin = viewer.entities.add({
      id: "site-" + s.id,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 2),
      point: { pixelSize: 10, color: Cesium.Color.fromCssColorString("#8fa8ad"), outlineColor: Cesium.Color.fromCssColorString("#10222a"), outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(20000, 1.2, 10000000, 0.75) },
      label: {
        text: formatSiteMarkerLabel(s),
        font: "500 12px Inter, sans-serif", fillColor: Cesium.Color.fromCssColorString("#dceceb"), outlineColor: Cesium.Color.fromCssColorString("#0b171d"), outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -15), showBackground: true,
        backgroundPadding: new Cesium.Cartesian2(7, 5), backgroundColor: Cesium.Color.fromCssColorString("#10232b").withAlpha(0.8),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 700000),
      },
    });
    sitePins.set(s.id, pin);
    for (const nb of s.neighbors || []) {
      neighborPins.push(viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(nb.lon, nb.lat),
        point: { pixelSize: 9, color: Cesium.Color.fromCssColorString("#e66767"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: nb.name, font: "13px Inter, sans-serif", pixelOffset: new Cesium.Cartesian2(0, -16), fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.5e5) },
      }));
    }
  }

  // Ring showing the "surroundings" used for the comparison
  const ringEntities = [];
  function drawRings(lat, lon, ring) {
    ringEntities.forEach((e) => viewer.entities.remove(e)); ringEntities.length = 0;
    for (const [r, dash] of [[ring[0], true], [ring[1], false]]) {
      ringEntities.push(viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: { semiMajorAxis: r * 1000, semiMinorAxis: r * 1000, fill: false, outline: true, height: 0, outlineColor: Cesium.Color.fromCssColorString(dash ? "#3987e5" : "#3987e5").withAlpha(dash ? 0.6 : 0.95), outlineWidth: 2 },
      }));
    }
    ringEntities.push(viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: { pixelSize: 7, color: Cesium.Color.fromCssColorString("#80d9c0"), outlineColor: Cesium.Color.fromCssColorString("#10222a"), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
    ringEntities.forEach((entity) => { entity.show = !localMarkerMode && !electricityView; });
  }

  function flyTo(lat, lon, km = 45, pitch = -50, heading = 0, duration = 2.5) {
    const range = km * 1000;
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat), 10), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), range), duration,
    });
  }
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-92, 37, 9.5e6) });

  // ------------------------------------------------------------ map overlay + compare
  let overlayA = null, overlayB = null;
  // Default Air view = the 20-year OMI record, the same dataset as the top "Air pollution" button.
  const state = { site: SITES[0], live: null, varId: "NO2_OMI", mapLayer: "none" };
  let environmentPanel=null, environmentStory=null;
  const today = new Date().toISOString().slice(0, 10);

  // This accessible caption also exposes the exact source anchor for inspection.
  const markerStatus = document.createElement("p");
  markerStatus.id = "siteMarkerStatus";
  markerStatus.className = "muted";
  markerStatus.setAttribute("role", "status");
  markerStatus.setAttribute("aria-live", "polite");
  function renderMarkerStatus() {
    const site = state.site;
    const marker = siteMarkerPresentation(site, campusMarkers.get(site.id), { active: localMarkerMode, selectedSiteId: site.id });
    markerStatus.hidden = !!state.live;
    markerStatus.textContent = marker.anchored
      ? `${localMarkerMode ? "Roof marker" : "Mapped facility"}: ${marker.facilityName}`
      : "Area marker · zoom in to locate the mapped facility.";
    Object.assign(markerStatus.dataset, {
      siteId: site.id, sourceId: marker.sourceId,
      anchoring: marker.anchored ? (localMarkerMode ? "mapped-roof" : "mapped-campus") : "study-area",
      lat: String(marker.lat), lon: String(marker.lon),
      groundHeight: marker.groundHeight == null ? "" : String(marker.groundHeight),
      roofHeight: marker.roofHeight == null ? "" : String(marker.roofHeight),
      markerVisible: String(marker.show),
    });
    markerStatus.title = marker.anchored
      ? `${marker.facilityName} · ${marker.lat.toFixed(6)}, ${marker.lon.toFixed(6)}${marker.sourceId ? ` · ${marker.sourceId}` : ""}. Comparison area remains centered at ${site.lat.toFixed(6)}, ${site.lon.toFixed(6)}.`
      : "The comparison area is a regional study anchor, not a mapped building roof.";
    $("#story").appendChild(markerStatus);
  }
  function updateSitePins() {
    for (const site of SITES) {
      const pin = sitePins.get(site.id);
      const marker = siteMarkerPresentation(site, campusMarkers.get(site.id), { active: localMarkerMode, selectedSiteId: state.site.id });
      pin.show = marker.show;
      pin.position = Cesium.Cartesian3.fromDegrees(marker.lon, marker.lat, marker.height);
      const reference = marker.clampToGround ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.NONE;
      pin.point.heightReference = reference;
      pin.label.heightReference = reference;
      pin.label.text = marker.label;
      const selected = site.id === state.site.id && !state.live;
      pin.point.color = Cesium.Color.fromCssColorString(selected ? "#80d9c0" : "#8fa8ad");
    }
    neighborPins.forEach((pin) => { pin.show = !localMarkerMode; });
    ringEntities.forEach((entity) => { entity.show = !localMarkerMode && !electricityView; });
    renderMarkerStatus();
    scene.requestRender();
  }
  window.addEventListener("cs:campus-ready", ({ detail }) => {
    const ready = campusMarkerFromEvent(detail, SITES);
    if (!ready) return;
    campusMarkers.set(ready.siteId, ready.marker);
    updateSitePins();
  });
  window.addEventListener("cs:scene-mode", ({ detail }) => {
    if (detail?.siteId && detail.siteId !== state.site.id) return;
    localMarkerMode = !!detail?.active;
    updateSitePins();
  });
  window.addEventListener('cs:electricity', ({ detail }) => {
    if (typeof detail?.active !== 'boolean') return;
    electricityView = detail.active;
    updateSitePins();
  });

  // Per-pixel trend maps (scripts/trend_maps.py): projected map years after the record.
  const TREND_MAP_LAST_YEAR = 2035, trendMaps = new Map();
  let trendMapIndex = null;
  fetch("data/trendmaps/index.json").then((r) => r.ok ? r.json() : null).then((index) => { trendMapIndex = index; if (VARS[state.mapLayer] && +($("#dateA").value || "").slice(0, 4) > 2026) refreshOverlay(); }).catch(() => {});
  function loadTrendMap(siteId, kind) {
    const key = `${siteId}/${kind}`;
    if (!trendMaps.has(key)) {
      const task = import('./evidence-map.js').then(async ({ decodeTrendMap }) => {
        const response = await fetch(`data/trendmaps/${encodeURIComponent(siteId)}/${encodeURIComponent(kind)}.json`);
        if (!response.ok) throw new Error(`Trend map ${key} unavailable`);
        return decodeTrendMap(await response.json());
      });
      trendMaps.set(key, task); task.catch(() => trendMaps.delete(key));
    }
    return trendMaps.get(key);
  }
  function overlaySpec(kind, date) {
    if (kind === "none") return null;
    if (VARS[kind]) { const L = VARS[kind].layer; const d = snapDate(L, date); return { layer: L, date: d }; }
    if (kind === "DIST") { const L = MAP_LAYERS.DIST.layer; return { layer: L, date: snapDate(L, date) }; }
    if (kind === "HLS") {
      // prefer the hand-picked cloud-free date for the current site
      const h = hlsDates[state.site?.id] || {};
      const pick = [h.before, h.after].filter(Boolean).find((x) => x.date === date);
      if (pick) return { layer: pick.layer, date: pick.date };
      const L = "HLS_S30_Nadir_BRDF_Adjusted_Reflectance"; return { layer: L, date: snapDate(L, date) };
    }
  }
  function makeLayer(spec, baseline = null, kind = state.mapLayer, center = state.live || state.site, projection = null, delta = null) {
    const z = CATALOG[spec.layer].z;
    const v=VARS[kind],lut=v? _luts[v.cmap]:null;
    const p = lut ? createEvidenceProvider(Cesium,{url:tileUrl(spec.layer,spec.date),baselineUrl:baseline?tileUrl(spec.layer,baseline.date):null,lut,variable:kind,offset:v.offset,factor:v.scale,change:!!baseline,maximumLevel:z,projection,delta,onError:()=>{ $('#mapLegendDetail').textContent='Some comparison pixels unavailable · transparent gaps are missing data.'; }})
      : new Cesium.UrlTemplateImageryProvider({ url: tileUrl(spec.layer, spec.date), maximumLevel: z, credit: "NASA GIBS",...(kind==='HLS'?{rectangle:Cesium.Rectangle.fromDegrees(Math.max(-180,center.lon-.2),Math.max(-90,center.lat-.15),Math.min(180,center.lon+.2),Math.min(90,center.lat+.15))}: {}) });
    const readiness=trackImageryProvider(p);
    const l = viewer.imageryLayers.addImageryProvider(p);
    l._csReadiness=readiness;
    l.alpha = .001; // Warm incoming tiles while the preceding year stays visible.
    return l;
  }
  const mapStatus = document.createElement('p');
  mapStatus.id='mapPlaybackStatus'; mapStatus.className='map-playback-status'; mapStatus.setAttribute('role','status');
  $('#mapLegend').appendChild(mapStatus);
  const resources=new Set(),textureCache=new Map();
  let committedMap=null, requestedMap=null;
  const paintOpacity=(resource,weight)=>{
    resource.weight=weight;
    const opacity=+$('#opacity').value;
    const ordered=[...resources],front=ordered.at(-1),[backAlpha,frontAlpha]=mapCrossfadeAlphas(opacity,front?.weight??1);
    for(const entry of ordered){
      const alpha=ordered.length===1?entry.weight*opacity:entry===front?frontAlpha:backAlpha;
      entry.layers.forEach(layer=>{layer.alpha=opacity===0?0:Math.max(.001,alpha);});
    }
    scene.requestRender();
  };
  function prepareTexture(payload){
    const key=mapRequestKey(payload);
    if(textureCache.has(key))return textureCache.get(key);
    const {kind,center,a,baseline,change,projection,delta}=payload,v=VARS[kind];
    const task=v?(async()=>{await loadLut(v.cmap);return evidenceTexture({center,url:tileUrl(a.layer,a.date),baselineUrl:baseline?tileUrl(a.layer,baseline.date):null,lut:_luts[v.cmap],variable:kind,offset:v.offset,factor:v.scale,change,maximumLevel:CATALOG[a.layer].z,projection,delta});})():Promise.resolve(null);
    textureCache.set(key,task);task.catch(()=>textureCache.delete(key));
    while(textureCache.size>4)textureCache.delete(textureCache.keys().next().value);
    return task;
  }
  const mapTransition=createMapTransition({
    load:async(payload,signal)=>{
      if(payload.a.projectYear&&!payload.projection){
        try{payload.projection={trend:await loadTrendMap(payload.a.siteId,payload.kind),years:payload.a.projectYear-payload.a.baseYear};}
        catch{payload.a={...payload.a,projectYear:undefined,projectNote:undefined,fallbackNote:`The ${payload.a.projectYear} projected map could not be loaded; showing the ${payload.a.date} map.`};}
      }
      // Decode the local scientific raster before creating any replacement layers.
      const texture=await prepareTexture(payload);
      if(signal.aborted)return {layers:[],payload,texture};
      const resource={layers:[],payload,texture,weight:0}; resources.add(resource);
      try{
        resource.layers.push(makeLayer(payload.a,payload.baseline,payload.kind,payload.center,payload.projection,payload.delta));
        if(payload.compare){
          resource.layers.push(makeLayer(payload.b,null,payload.kind,payload.center));
          resource.layers[0].splitDirection=Cesium.SplitDirection.LEFT;
          resource.layers[1].splitDirection=Cesium.SplitDirection.RIGHT;
        }
        return resource;
      }catch(error){resource.layers.forEach(l=>viewer.imageryLayers.remove(l,true));resources.delete(resource);throw error;}
    },
    whenReady:(resource,signal)=>new Promise((resolve,reject)=>{
      let frames=0,remove;
      const finish=()=>{clearTimeout(timer);remove?.();signal.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(()=>{remove?.();signal.removeEventListener('abort',finish);reject(new Error('Dated imagery did not finish loading'));},8000);
      remove=scene.postRender.addEventListener(()=>{
        frames++;
        const states=resource.layers.map(layer=>layer._csReadiness.snapshot);
        // Once each requested side has decoded imagery, show it progressively.
        // Waiting for every horizon tile to finish stalls playback while panning.
        const layersReady=states.every(s=>s.completed>0);
        // The visible close-up material has its own decoded source raster. An
        // unrelated basemap/HLS request must not hold that verified data hostage.
        const localReady=localMarkerMode&&!resource.payload.compare&&resource.texture?.loadedTileCount>0;
        if(frames>=2&&(layersReady||localReady||+$('#opacity').value===0))finish();
      });
      signal.addEventListener('abort',finish,{once:true});scene.requestRender();
    }),
    setOpacity:paintOpacity,
    dispose:resource=>{resource.layers.forEach(l=>{if(viewer.imageryLayers.contains(l))viewer.imageryLayers.remove(l,true);});resources.delete(resource);},
    onCommit:(resource,payload,key)=>{
      committedMap=payload;overlayA=resource.layers[0];overlayB=resource.layers[1]||null;
      syncLayerControls(payload.a,payload);
      $('#dateA').value=payload.a.date;
      $('#split').hidden=!payload.compare;$('#dateBWrap').hidden=!payload.compare;
      if(payload.compare){$('#dateB').value=payload.b.date;$('#splitL').textContent='◀ '+payload.a.date;$('#splitR').textContent=payload.b.date+' ▶';}
      const texture=resource.texture;
      $('#mapLegend').dataset.validPixels=String(texture?.validPixelCount??0);
      if(texture&&!texture.validPixelCount)$('#mapResolution').textContent='No comparable NASA pixels in this close-up area for these dates. Missing coverage stays transparent.';
      if(payload.compare)$('#mapResolution').textContent='Split comparison applies to globe imagery. Low-poly ground keeps its natural colours; zoom out for the A/B map. Dates are snapshots, not annual averages.';
      window.dispatchEvent(new CustomEvent('cs:evidence-texture',{detail:texture&&!payload.compare?{...texture,key,active:true,sourceDate:payload.a.date,comparison:payload.change}: {active:false}}));
    },
    onState:({state:mapState,key})=>{
      $('#mapLegend').dataset.mapState=mapState;
      const date=committedMap?.a.date;
      mapStatus.textContent=mapState==='loading'?`Loading ${requestedMap?.a.date||'map'}${date?` · still showing ${date}`:''}…`:mapState==='transitioning'?'Blending dated snapshots · intermediate colours are a visual transition.':mapState==='failed'?`Map could not load${date?` · reference remains ${date}`:''}.`:mapState==='ready'?'Map ready · fixed colour scale across years.':'';
      window.dispatchEvent(new CustomEvent('cs:map-state',{detail:{state:mapState,key,sourceDate:date}}));
    },durationMs:700,
  });
  function clearScientificMap(message=''){
    mapTransition.clear(); committedMap=requestedMap=null;overlayA=overlayB=null;
    $('#split').hidden=true;
    window.dispatchEvent(new CustomEvent('cs:evidence-texture',{detail:{active:false}}));
    if(message){$('#mapLegend').hidden=false;$('#mapColorScale').hidden=true;$('#mapLegendDetail').textContent=message;$('#mapResolution').textContent='No annual spatial forecast is available. Future climate scenarios are regional period summaries.';mapStatus.textContent='No dated scientific map shown.';}
  }
  function refreshOverlay() {
    const kind=state.mapLayer,change=$('#mapChange').checked&&!!VARS[kind],compare=$('#cmpToggle').checked&&!change;
    const desired=$('#dateA').value||today;
    let a=overlaySpec(kind,desired);
    window.dispatchEvent(new CustomEvent('cs:map-layer',{detail:{kind,change,date:a?.date??null}}));
    if(!a){clearScientificMap();syncLayerControls(null);return;}
    if(VARS[kind]){
      const dates=expandIntervals(a.layer);
      let date=sourceDateForYear(dates,+desired.slice(0,4),desired);
      // Years beyond (or before) the satellite record: show the nearest real map and say so,
      // instead of clearing the layer. Satellites never provide future maps.
      if(!date){
        // Same season as the requested date, so a July view never borrows an autumn map.
        const earlier=dates.filter(d=>d<=desired),fallback=seasonalFallbackDate(dates,desired)||(earlier.length?earlier.at(-1):dates[0]);
        if(!fallback){clearScientificMap(`No ${VARS[kind].short} imagery for ${desired.slice(0,4)}.`);return;}
        date=fallback;
        const year=+desired.slice(0,4),baseYear=+fallback.slice(0,4),site=state.live?null:state.site;
        if(site&&year>baseYear&&year<=TREND_MAP_LAST_YEAR&&trendMapIndex?.sites?.[site.id]?.includes(kind))
          a={...a,projectYear:year,baseYear,siteId:site.id,projectNote:`PROJECTED ${year} · if each pixel's long-term NASA trend continues from the ${fallback} map. Only pixels with a significant trend change; not a forecast.`};
        else a={...a,fallbackNote:`No ${VARS[kind].short} map exists for ${desired.slice(0,4)}; showing the nearest same-season map (${fallback}), not a projection.`};
      }
      a={...a,date};
    }
    // Projected years in change mode: projected change since the latest real map (the
    // prediction itself), on a colour range sized to the trends, instead of vs. 2005.
    // Projected years continue the same comparison as observed years (vs. the chosen baseline
    // year), so 2027 picks up where 2026 left off and the trend builds on it. Choosing
    // "latest map" as the baseline shows only the projected change, on a trend-sized scale.
    const baseChoice=$('#baselineYear').value,autoBase=baseChoice==='auto';
    const projectedChange=change&&!!a.projectYear&&autoBase&&Number.isFinite(PROJECTED_DELTAS[kind]);
    const baseline=change?(projectedChange?{layer:a.layer,date:a.date}:overlaySpec(kind,`${autoBase?2005:baseChoice}-07-15`)):null;
    const delta=projectedChange?PROJECTED_DELTAS[kind]:null;
    let b=compare?overlaySpec(kind,$('#dateB').value||today):null;
    if(b&&VARS[kind]){
      const desiredB=$('#dateB').value||today,date=sourceDateForYear(expandIntervals(b.layer),+desiredB.slice(0,4),desiredB);
      if(!date){clearScientificMap(`No comparison imagery for ${desiredB.slice(0,4)}.`);return;}
      b={...b,date};
    }
    requestedMap={kind,change,compare,a,b,baseline,delta,center:{...(state.live||state.site)}};
    if(!committedMap)syncLayerControls(a,requestedMap);
    $('#mapLegend').hidden=['HLS','DIST'].includes(kind);
    void mapTransition.show(mapRequestKey(requestedMap),requestedMap).catch(()=>{});
  }
  function syncLayerControls(spec,payload=null) {
    const kind=payload?.kind||state.mapLayer;
    const descriptions = {
      none: ["Satellite", "Satellite imagery shows the real-world landscape."],
      LST_Day: ["Heat", "Daytime surface temperature: the warmth of ground and roofs, not the air."],
      LST_Night: ["Heat (night)", "Night-time surface temperature (~10:30 pm). Stored heat from roofs and paving shows most clearly at night; daytime heat is in the layer list."],
      NDVI: ["Vegetation", "Greenness (NDVI) shows vegetation cover. It does not measure crop yield."],
      NO2_OMI: ["Air pollution", "Nitrogen dioxide (NO₂) in the atmospheric column. This is a regional satellite view, not street-level exposure."],
      NO2: ["Recent NO₂", "A more detailed satellite NO₂ record available since September 2023."],
      AOD: ["Particles / haze", "Aerosol optical depth shows how much sunlight airborne particles block."],
      AirTemp: ["Air temperature", "Regional air temperature from MERRA-2 reanalysis."],
      SoilMoisture: ["Soil moisture", "Root-zone soil moisture from NASA's GLDAS land model (monthly, ~25 km). Blue is wetter, orange drier."],
      Water: ["Water", "Rainfall per year (mm) on one scale for every site: NASA MERRA-2 for past years, CMIP6 climate scenarios after 2026."],
      HLS: ["Satellite · HLS", "NASA high-resolution surface imagery. Available image dates vary."],
      DIST: ["Land disturbance", "Mapped vegetation disturbance, which can include clearing, construction, and fire."],
    };
    const [label, note] = descriptions[kind] || descriptions.none;
    $("#layerSummary").textContent = label;
    $("#layerNote").textContent = note;
    const family = ({ HLS: "none", LST_Day: "LST_Night", NO2: "NO2_OMI", AOD: "NO2_OMI" })[kind] || kind;
    document.querySelectorAll("[data-map-layer]").forEach((button) => {
      const active = button.dataset.mapLayer === family;
      button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    });
    const showLegend = !!spec && !["HLS", "DIST"].includes(kind);
    $("#mapLegend").hidden = !showLegend;
    if (showLegend) {
      $("#mapLegendTitle").textContent = spec.projectYear ? `${label} · PROJECTED ${spec.projectYear}` : label;
      $("#mapLegend").classList.toggle("map-projected", !!spec.projectYear);
      const delta=payload?.delta,scale=delta?{...MAP_SCALES[kind],delta}:MAP_SCALES[kind],change=payload?payload.change:$('#mapChange').checked;
      document.querySelector('#mapColorScale .evidence-ramp')?.classList.toggle('veg',kind==='NDVI'||kind==='SoilMoisture');
      const base=payload?.baseline||overlaySpec(kind,`${$('#baselineYear').value==='auto'?2005:$('#baselineYear').value}-07-15`);
      const shown=spec.projectYear?`${spec.projectYear} (projected)`:spec.date;
      const changeText=delta?`Projected change ${base.date.slice(0,4)} → ${spec.projectYear}`:`${shown} minus ${base.date}`;
      $('#mapLegendDetail').textContent = `${change?changeText:shown} · ${scale.resolution} native data${spec.fallbackNote?` · ${spec.fallbackNote}`:''}${spec.projectNote?` · ${spec.projectNote}`:''}`;
      $('#mapLegendScale').hidden=true;
      $('#mapColorScale').hidden=false;
      $('#mapScaleLow').textContent=change?`−${scale.delta}`:scale.min;
      $('#mapScaleHigh').textContent=(change?`+${scale.delta}`:scale.max)+' '+scale.unit;
      $('#mapScaleMeaning').textContent=kind==='SoilMoisture'?(delta?'Blue: projected to get wetter · orange: projected to get drier · neutral: no significant trend':change?'Blue: wetter · orange: drier':'Blue: wet soil · orange: dry soil'):delta?(kind==='NDVI'?'Blue: projected to get greener · orange: projected to lose green · neutral: no significant trend':'Blue: projected decrease · red: projected increase · neutral: no significant trend'):kind==='NDVI'?(change?'Blue: greener · red: less green':'Blue: greener · red: sparse vegetation'):(change?'Blue: lower · red: higher':'Blue: lower · red: higher');
      const tm=payload?.projection?.trend?.stats;
      $('#mapResolution').textContent=spec.projectYear&&tm?`Trend extension, not a forecast: ${Math.round(tm.significantShare*100)}% of the ${(tm.tested/1000).toFixed(0)}k pixels near the site have a significant ${payload.projection.trend.years.join('–')} July trend (Mann-Kendall, Hamed-Rao, false-discovery q < 0.10); the rest stay at their latest value. Outside the site box the map is the latest real snapshot. Not proof of a facility effect.`:spec.projectYear?'Trend extension, not a forecast: each pixel near the site continues its own significant NASA July trend from the latest real map; pixels without one stay unchanged. Not proof of a facility effect.':'Colour-class estimates from NASA imagery. Transparent = no data. Comparison is between snapshots, not a long-term trend or proof of a facility effect.';
    }
  }
  async function setMapLayer(kind, dateA, dateB, compare) {
    if(state.mapLayer!==kind)clearScientificMap();
    state.mapLayer = kind; $("#layerSel").value = kind;
    if (dateA) $("#dateA").value = dateA; if (dateB) $("#dateB").value = dateB;
    if (compare != null) $("#cmpToggle").checked = compare;
    if(VARS[kind]){
      if(!dateA)$('#dateA').value=`${+$('#tlSlider').value||2025}-07-15`;
      if(state.varId!==kind){state.varId=kind;renderTabs();runAnalysis();}
      const strip=$('#tlRingVar');if(strip.value!==kind&&[...strip.options].some(option=>option.value===kind)){strip.value=kind;strip.dispatchEvent(new Event('change'));}
    }
    refreshOverlay();
  }
  $("#layerSel").onchange = (e) => {
    const s = state.site;
    if (e.target.value === "HLS" && s && hlsDates[s.id]?.before) setMapLayer("HLS", hlsDates[s.id].before.date, hlsDates[s.id].after?.date, true);
    else setMapLayer(e.target.value);
  };
  document.querySelectorAll("[data-map-layer]").forEach((button) => button.addEventListener("click", () => {
    const kind = button.dataset.mapLayer;
    setMapLayer(kind, null, null, false);
  }));
  $("#dateA").onchange = $("#dateB").onchange = $("#cmpToggle").onchange = refreshOverlay;
  $("#opacity").oninput = () => resources.forEach(resource=>paintOpacity(resource,resource.weight));
  $('#mapChange').onchange=()=>setMapLayer(state.mapLayer,$('#dateA').value);
  $('#baselineYear').onchange=()=>setMapLayer(state.mapLayer,$('#dateA').value);
  let yearMapTimer=0;
  window.addEventListener('cs:year',({detail})=>{
    if(!detail?.year||!VARS[state.mapLayer])return;
    const date=`${detail.year}-07-15`;
    clearTimeout(yearMapTimer);
    yearMapTimer=setTimeout(()=>{if(VARS[state.mapLayer]&&$('#dateA').value.slice(0,4)!==date.slice(0,4))setMapLayer(state.mapLayer,date);},90);
  });

  // draggable split
  scene.splitPosition = 0.5;
  (() => {
    const bar = $("#split"); let drag = false;
    bar.addEventListener("pointerdown", (e) => { drag = true; bar.setPointerCapture(e.pointerId); });
    bar.addEventListener("pointerup", () => (drag = false));
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return; const r = viewer.canvas.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX, r.left + 20), r.right - 20);
      bar.style.left = x + "px"; scene.splitPosition = (x - r.left) / r.width;
    });
  })();

  // ------------------------------------------------------------ panel: sites + vars
  function renderChips() {
    $("#siteChips").innerHTML = "";
    for (const s of SITES) {
      const selected = state.site === s && !state.live;
      const pin = sitePins.get(s.id);
      pin.point.color = Cesium.Color.fromCssColorString(selected ? "#80d9c0" : "#8fa8ad");
      pin.point.pixelSize = selected ? 12 : 9;
      const b = document.createElement("button"); b.className = "chip" + (state.site === s && !state.live ? " active" : "");
      const placeNames = { colossus1: ["Memphis", "Colossus 1"], colossus2: ["Southaven", "Colossus 2"], ashburn: ["Ashburn", "Data Center Alley"], abilene: ["Abilene", "Stargate"], thedalles: ["The Dalles", "Google campus"] };
      const [place, name] = placeNames[s.id] || [s.place, s.name];
      const text = document.createElement("span"), title = document.createElement("span"), subtitle = document.createElement("span"), arrow = document.createElement("span");
      title.className = "chip-title"; title.textContent = place; subtitle.className = "chip-subtitle"; subtitle.textContent = name;
      arrow.className = "chip-arrow"; arrow.textContent = "↗"; arrow.setAttribute("aria-hidden", "true");
      text.append(title, subtitle); b.append(text, arrow); b.title = s.name; b.setAttribute("aria-pressed", String(state.site === s && !state.live));
      b.onclick = () => selectSite(s); $("#siteChips").appendChild(b);
    }
  }
  function renderStory() {
    const s = state.site;
    if (state.live) {
      $("#story").innerHTML = `<h3>Your investigation</h3><div class="place">${state.live.lat.toFixed(4)}, ${state.live.lon.toFixed(4)}</div>
        <p>Live NASA data for this spot vs. the ring around it. Try a new industrial park, a mine, a new suburb, or a data center in your city.</p>`;
      renderMarkerStatus();
      return;
    }
    $("#story").innerHTML = `<h3>${s.name}</h3><div class="place">${s.place} · ${s.operator}</div>
      <div class="headline">${s.headline}</div><details><summary>About this place</summary><p>${s.story}</p>
      <p class="muted">Comparison start: <b>${s.onset}</b> (${s.onsetLabel})</p></details>`;
    renderMarkerStatus();
  }
  function renderTabs() {
    $("#varTabs").innerHTML = "";
    for (const [id, v] of Object.entries(VARS)) {
      const b = document.createElement("button"); b.className = "tab" + (state.varId === id ? " active" : "");
      const star = !state.live && state.site.watchFor?.includes(id) ? '<span class="star" title="Most relevant for this site">★ watch</span>' : "";
      const labels = { LST_Day: "Heat · day", LST_Night: "Heat · night", NDVI: "Vegetation", SoilMoisture: "Water · soil moisture", NO2: "NO₂ · recent", NO2_OMI: "NO₂ · long record", AOD: "Particles / haze", AirTemp: "Air temperature" };
      b.innerHTML = `${labels[id] || v.label}${star}`; b.onclick = () => { state.varId = id; renderTabs(); runAnalysis(); };
      $("#varTabs").appendChild(b);
    }
    const v = VARS[state.varId];
    $("#varDefine").innerHTML = `${v.define}<br><span class="muted">${v.sensor} · surroundings ring ${v.ring[0]}–${v.ring[1]} km</span>`;
  }

  function selectSite(s, { fly = true, varId } = {}) {
    clearScientificMap();textureCache.clear();
    if (state.site?.id !== s.id) localMarkerMode = false;
    state.site = s; state.live = null; liveAbort?.abort();
    state.varId = varId || s.watchFor?.[0] || "LST_Day";
    renderChips(); renderStory(); renderTabs(); renderLedger(); runAnalysis();
    updateSitePins();
    if (fly) flyTo(s.lat, s.lon, 40, -45);
    window.dispatchEvent(new CustomEvent("cs:site", { detail: { site: s, fly } }));
    if(state.mapLayer!=='none')void setMapLayer(state.mapLayer,$('#dateA').value);
  }

  // ------------------------------------------------------------ analysis + charts
  let chartMain, chartDiff, liveAbort;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const lastResults = {}; // siteId -> varId -> analysis (feeds the ledger)

  function onsetPlugin(x) {
    return { id: "onset", afterDatasetsDraw(c) {
      if (!x) return; const { ctx, chartArea: a, scales: { x: sx } } = c; const px = sx.getPixelForValue(x);
      if (px < a.left || px > a.right) return;
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = css("--text-2"); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.restore();
    } };
  }
  const axisCommon = (title) => ({
    grid: { color: "rgba(255,255,255,0.06)" }, border: { display: false },
    ticks: { color: css("--muted"), font: { size: 10.5 } }, title: { display: !!title, text: title, color: css("--muted"), font: { size: 10.5 } },
  });

  function drawCharts(a, v, onset) {
    chartMain?.destroy(); chartDiff?.destroy();
    const xs = a.t.map(Stats.decYear);
    const roll = (vals) => Stats.rolling(vals).map((y, i) => ({ x: xs[i], y }));
    const onX = onset ? Stats.decYear(onset) : null;
    chartMain = new Chart($("#chartMain"), {
      type: "line",
      data: { datasets: [
        { label: "Site", data: roll(a.site), borderColor: css("--site"), borderWidth: 2, pointRadius: 0, spanGaps: false, tension: 0.2 },
        { label: "Surroundings", data: roll(a.ref), borderColor: css("--ref"), borderWidth: 2, pointRadius: 0, spanGaps: false, tension: 0.2 },
      ] },
      options: {
        parsing: false, animation: false, responsive: true, interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (it) => { const x = it[0].parsed.x; const y = Math.floor(x); return `${y}-${String(Math.floor((x - y) * 12) + 1).padStart(2, "0")}`; },
          label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(v.digits)} ${v.unit}` } } },
        scales: { x: { type: "linear", ...axisCommon(), ticks: { ...axisCommon().ticks, callback: (x) => Math.round(x), stepSize: 2 } }, y: axisCommon(v.unit) },
      },
      plugins: [onsetPlugin(onX)],
    });
    const ann = a.trendDiff.annual;
    const tr = a.trendDiff;
    chartDiff = new Chart($("#chartDiff"), {
      data: { datasets: [
        { type: "bar", label: "Local anomaly", data: ann.x.map((x, i) => ({ x, y: ann.y[i] })),
          backgroundColor: ann.y.map((y) => ((y > 0) === v.higherIsWorse ? css("--site") : css("--ref"))), borderRadius: 3, barPercentage: 0.8, categoryPercentage: 1 },
        { type: "line", label: "Sen's slope trend", data: ann.x.length ? [ann.x[0], ann.x[ann.x.length - 1]].map((x) => ({ x, y: tr.intercept + tr.slope * x })) : [],
          borderColor: css("--text"), borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
      ] },
      options: {
        parsing: false, animation: false, responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (it) => String(Math.floor(it[0].parsed.x)),
          label: (it) => `${it.dataset.label}: ${fmt(it.parsed.y, v.digits)} ${v.unit}` } } },
        scales: { x: { type: "linear", offset: false, ...axisCommon(), ticks: { ...axisCommon().ticks, callback: (x) => Math.round(x), stepSize: 2 } }, y: axisCommon(v.unit) },
      },
      plugins: [onsetPlugin(onX)],
    });
  }

  function renderVerdict(a, v) {
    const per10 = (t) => t.slope * 10;
    const sig = (p) => (p < 0.05 ? '<span class="badge sig">✓ significant</span>' : '<span class="badge ns">not significant</span>');
    const d = a.trendDiff, ba = a.ba;
    const dir = (x) => (x > 0 ? "rising" : "falling");
    let head;
    const span = `${a.first?.slice(0, 4)}–${a.last?.slice(0, 4)}`;
    const regional=v.layer.startsWith('MERRA2'),headlineTrend=regional?a.trendSite:d;
    $('#changeHeadline').innerHTML=`<span class="eyebrow">${v.short} · ${span}</span><strong>${Number.isFinite(headlineTrend.slope)?fmt(headlineTrend.slope*10,v.digits):'Unavailable'} <small>${v.unit} / decade</small></strong><p>${regional?'Regional air temperature':'Change at the site relative to its surroundings'} · ${headlineTrend.p<.05?'statistically significant':'no statistically significant trend'}</p><p class="muted">${v.sensor}. Nearby change alone does not establish a facility effect.</p><button type="button" id="showTrendDetail">See chart and method</button>`;
    $('#showTrendDetail').onclick=()=>{$('#analysisDetails').open=true;$('#analysisDetails').scrollIntoView({behavior:'smooth',block:'start'});};
    if (v.layer.startsWith("MERRA2")) {
      const t = a.trendSite;
      head = `☁️ Regional climate control: air temperature here is ${t.slope > 0 ? "warming" : "cooling"} <b>${fmt(t.slope * 10, 2)} °C/decade</b> (${fmtP(t.p)}, ${span}). A site's local heat signal has to stand out against this background.`;
    } else if (ba && ba.p < 0.05) {
      const worse = (ba.diff > 0) === v.higherIsWorse;
      head = `${worse ? "⚠️" : "ℹ️"} Since ${a.onset.slice(0, 4)}, ${v.noun} at the site moved <b>${fmt(ba.diff, v.digits)} ${v.unit}</b> relative to its surroundings, and that's statistically significant.`;
    } else if (d.p < 0.05) {
      head = `📈 The site's ${v.noun} has been <b>${dir(d.slope)}</b> relative to its surroundings, ${fmt(per10(d), v.digits)} ${v.unit}/decade (${span}).`;
    } else {
      head = `🔍 No significant local change in ${v.noun} yet (${span}). That could mean no effect, or a pixel too big for the facility, or a record too short after the start date.`;
    }
    $("#verdict").innerHTML = `<div class="v-head">${head}</div>
      <div class="stats">
        <div class="stat"><div class="k">Site trend</div><div class="v">${fmt(per10(a.trendSite), v.digits)}</div><div class="p">${v.unit}/decade · ${fmtP(a.trendSite.p)}</div></div>
        <div class="stat"><div class="k">Surroundings</div><div class="v">${fmt(per10(a.trendRef), v.digits)}</div><div class="p">${v.unit}/decade · ${fmtP(a.trendRef.p)}</div></div>
        <div class="stat"><div class="k">Local signal</div><div class="v">${fmt(per10(d), v.digits)}</div><div class="p">/decade · ${fmtP(d.p)}<br>${sig(d.p)}</div></div>
      </div>
      ${ba ? `<div class="stat" style="margin-top:6px"><div class="k">Before vs. after ${a.onset} (site − surroundings)</div>
        <div class="v">${fmt(ba.diff, v.digits)} ${v.unit} <span class="p">95% CI [${fmt(ba.lo, v.digits)}, ${fmt(ba.hi, v.digits)}] · ${fmtP(ba.p)}</span></div>
        <div class="p">${ba.nA} months before vs. ${ba.nB} after (effective n ≈ ${ba.nEffA.toFixed(0)} / ${ba.nEffB.toFixed(0)}) ${sig(ba.p)}</div></div>` : ""}
      <div class="p muted" style="margin-top:6px;font-size:11px">Mann-Kendall on yearly means of de-seasonalized monthly data (n = ${d.n} years). Slopes = Sen's estimator.</div>`;
  }

  async function runAnalysis() {
    const v = VARS[state.varId];
    let series, onset = null;
    if (state.live) {
      liveAbort?.abort(); liveAbort = new AbortController(); const my = liveAbort;
      $("#progress").hidden = false; $("#verdict").innerHTML = '<div class="muted">Pulling NASA tiles and decoding pixels…</div>';
      // live mode: thin the record so it finishes in ~30 s
      const stride = state.varId === "NO2" ? 3 : 2;
      series = await sampleSeries(state.live.lat, state.live.lon, state.varId, {
        stride, signal: my.signal,
        onProgress: (d, n) => { $("#progress .bar i").style.width = (100 * d) / n + "%"; $("#progress span").textContent = `${d}/${n}`; },
      });
      if (my.signal.aborted) return;
      $("#progress").hidden = true;
      drawRings(state.live.lat, state.live.lon, v.ring);
    } else {
      series = SERIES[state.site.id]?.[state.varId];
      onset = state.site.onset;
      drawRings(state.site.lat, state.site.lon, v.ring);
      if (!series) { $('#changeHeadline').textContent='No prepared observations for this measurement and location.'; $("#verdict").innerHTML = '<div class="muted">No prepared source data for this measurement.</div>'; chartMain?.destroy(); chartDiff?.destroy(); return; }
    }
    const a = Stats.analyze(series, onset);
    if (!state.live) (lastResults[state.site.id] ||= {})[state.varId] = a;
    window.dispatchEvent(new CustomEvent('cs:analysis',{detail:{siteId:state.live?'point-'+state.live.lat.toFixed(4)+','+state.live.lon.toFixed(4):state.site.id,varId:state.varId,analysis:a}}));
    renderVerdict(a, v); drawCharts(a, v, onset);
    if (!state.live) renderLedger();
  }

  // ------------------------------------------------------------ impact ledger
  const CATS = [
    ["air", "🏭 Emission sources (reported)"], ["noise", "🔊 Noise pollution"], ["noise_suit", "⚖️ Noise lawsuit"],
    ["water", "💧 Water use"], ["water_quality", "🧪 Water quality"], ["power", "⚡ Power draw (drives emissions & heat)"],
  ];
  const GAP_TEXT = {
    water_quality: "Not visible at this scale from orbit. Next step: Landsat/HLS aquatic reflectance or NASA PACE for nearby rivers and lakes, plus local water-utility test results.",
    noise: "No satellite can hear. Noise needs ground sensors or resident reports, which a citizen-science layer could add.",
  };
  function satelliteCard(id, cat) {
    const a = lastResults[state.site.id]?.[id]; const v = VARS[id];
    if (!a) return "";
    const ba = a.ba, d = a.trendDiff;
    let txt;
    if (v.layer.startsWith("MERRA2")) {
      if (!isFinite(a.trendSite.slope)) return "";
      txt = `Regional air ${a.trendSite.slope > 0 ? "warming" : "cooling"} <b>${fmt(a.trendSite.slope * 10, 2)} °C/decade</b> (${fmtP(a.trendSite.p)}), the background a local signal must beat`;
    } else if (ba) txt = `Site vs. surroundings after ${a.onset}: <b>${fmt(ba.diff, v.digits)} ${v.unit}</b> (${fmtP(ba.p)})`;
    else if (isFinite(d.slope)) txt = `Local trend ${fmt(d.slope * 10, v.digits)} ${v.unit}/decade (${fmtP(d.p)})`;
    else return "";
    return `<div class="led"><div class="top"><span class="cat">${cat}</span><span class="kind satellite">🛰 measured</span></div><div class="val">${txt}</div></div>`;
  }
  function renderLedger() {
    const s = state.site, L = s.ledger || {};
    let html = "";
    html += satelliteCard("NO2", "🌫️ Air: NO₂ (satellite)") + satelliteCard("AOD", "🌫️ Air: particles (satellite)") + satelliteCard("LST_Night", "🌡️ Night heat (satellite)")
      + satelliteCard("LST_Day", "🌡️ Day heat (satellite)") + satelliteCard("NDVI", "🌳 Land cover (satellite)") + satelliteCard("AirTemp", "☁️ Regional weather (control)");
    for (const [k, label] of CATS) {
      const e = L[k];
      if (e) html += `<div class="led"><div class="top"><span class="cat">${label}</span><span class="kind">${e.kind}</span></div><div class="val">${e.value}</div>${e.src ? `<a href="${e.src[1]}" target="_blank" rel="noopener">↗ ${e.src[0]}</a>` : ""}</div>`;
      else if (GAP_TEXT[k]) html += `<div class="led"><div class="top"><span class="cat">${label}</span><span class="kind gap">data gap</span></div><div class="val">${GAP_TEXT[k]}</div></div>`;
    }
    $("#ledger").innerHTML = html;
  }

  // ------------------------------------------------------------ click anywhere = live mode
  new Cesium.ScreenSpaceEventHandler(viewer.canvas).setInputAction((ev) => {
    const picked = scene.pick(ev.position);
    if (picked?.id?.city) return;
    if (picked?.id?.lowPoly || picked?.id === "low-poly-neighborhood" || picked?.id?.id === "low-poly-neighborhood" || picked?.primitive?.id?.lowPoly) return;
    if (picked?.id?.id?.startsWith?.("site-")) return selectSite(SITES.find((s) => "site-" + s.id === picked.id.id));
    const cart = viewer.camera.pickEllipsoid(ev.position, scene.globe.ellipsoid); if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    state.live = { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    clearScientificMap();textureCache.clear();
    const pointSite={...state.live,id:'point-'+state.live.lat.toFixed(4)+','+state.live.lon.toFixed(4),name:'Selected map location'};
    environmentPanel?.setSite(pointSite);
    window.dispatchEvent(new CustomEvent('cs:location',{detail:{site:pointSite}}));
    refreshOverlay();
    renderChips(); renderStory(); renderTabs(); runAnalysis();
    $("#ledger").innerHTML = '<div class="led"><div class="val">The ledger is available for the case-study sites. For your own spot, the satellite results above are the measured part.</div></div>';
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ------------------------------------------------------------ guided tour (the challenge's "demonstration examples")
  const S = Object.fromEntries(SITES.map((s) => [s.id, s]));
  const hls = (id) => hlsDates[id] || {};
  const TOUR = [
    { t: "Data centers are physical", p: "Every chatbot reply runs in a building that burns power, heats the ground and, sometimes, pollutes the air. Let's look for those footprints with NASA satellites.", go: () => { setMapLayer("none", null, null, false); viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-92, 37, 7.5e6), duration: 2.5 }); } },
    { t: "Memphis: xAI Colossus", p: "A former appliance factory became one of the world's largest AI supercomputers in 2024, powered partly by on-site methane gas turbines. Boxtown (red dot) is ~3 km away.", go: () => { selectSite(S.colossus1, { varId: "NO2" }); setMapLayer("HLS", hls("colossus1").before?.date, hls("colossus1").after?.date, true); flyTo(S.colossus1.lat, S.colossus1.lon, 9, -55, 20, 3); } },
    { t: "What the turbines put in the air", p: "Gas turbines emit NOx. TROPOMI sees NO₂ from space. The panel compares NO₂ over the site with a 20–50 km ring around it, before vs. after mid-2024.", go: () => { selectSite(S.colossus1, { fly: false, varId: "NO2" }); setMapLayer("NO2", "2025-07-15", null, false); flyTo(S.colossus1.lat, S.colossus1.lon, 160, -60, 0, 2.5); } },
    { t: "Colossus 2: watching land disappear", p: "The second campus went from open land to industrial site in 2025. Drag the split to compare before and after in 30 m imagery, then check the greenness trend.", go: () => { selectSite(S.colossus2, { fly: false, varId: "NDVI" }); setMapLayer("HLS", hls("colossus2").before?.date, hls("colossus2").after?.date, true); flyTo(S.colossus2.lat, S.colossus2.lon, 7, -55, -15, 3); } },
    { t: "The long view: Data Center Alley", p: "Twenty years of build-out in Ashburn, VA. Its nights now run warmer than the land around it, a 24/7 heat fingerprint. Mann-Kendall says that trend is real (p = 0.001).", go: () => { selectSite(S.ashburn, { fly: false, varId: "LST_Night" }); setMapLayer("LST_Night", "2004-07-11", "2025-07-12", true); flyTo(S.ashburn.lat, S.ashburn.lon, 60, -55, 0, 3.5); } },
    { t: "Weather or data center?", p: "Is it just a hotter climate? NASA's MERRA-2 weather reanalysis shows the regional air temperature, our control. A site only counts as a signal when it changes relative to its surroundings, not with the whole region.", go: () => { selectSite(S.ashburn, { fly: false, varId: "AirTemp" }); setMapLayer("LST_Night", "2025-07-12", null, false); flyTo(S.ashburn.lat, S.ashburn.lon, 220, -60, 0, 3); } },
    { t: "Stargate Abilene: the next one", p: "The pin marks the campus; reported power capacity remains in its label and source ledger. Drag the split to compare rangeland and server-hall imagery, then inspect the vegetation trend.", go: () => { selectSite(S.abilene, { fly: false, varId: "NDVI" }); setMapLayer("HLS", hls("abilene").before?.date, hls("abilene").after?.date, true); flyTo(S.abilene.lat, S.abilene.lon, 12, -50, 30, 3.5); } },
    { t: "Your turn, detective", p: "Click anywhere on Earth. We'll pull live NASA data for that spot and its surroundings, then test whether the change is real.", go: () => { setMapLayer("none", null, null, false); } },
  ];
  let tourI = 0;
  function showTour(i) {
    tourI = Math.max(0, Math.min(TOUR.length - 1, i)); const s = TOUR[tourI];
    $("#tourCard").hidden = false; $("#tourText").innerHTML = `<h4>${s.t}</h4><p>${s.p}</p>`; $("#tourStep").textContent = `${tourI + 1} / ${TOUR.length}`;
    $("#tourNext").textContent = tourI === TOUR.length - 1 ? "Finish" : "Next ›"; s.go();
  }
  $("#tourBtn").onclick = () => showTour(0);
  $("#tourNext").onclick = () => (tourI === TOUR.length - 1 ? ($("#tourCard").hidden = true) : showTour(tourI + 1));
  $("#tourPrev").onclick = () => showTour(tourI - 1);
  $("#tourEnd").onclick = () => ($("#tourCard").hidden = true);
  document.addEventListener("keydown", (e) => { if ($("#tourCard").hidden) return; if (e.key === "ArrowRight") $("#tourNext").click(); if (e.key === "ArrowLeft") $("#tourPrev").click(); if (e.key === "Escape") $("#tourEnd").click(); });

  // ------------------------------------------------------------ boot
  $("#analysisDetails").addEventListener("toggle", () => {
    if ($("#analysisDetails").open) { chartMain?.resize(); chartDiff?.resize(); }
  });
  $("#mapLegendScale").addEventListener("error", () => { $("#mapLegendScale").hidden = true; });
  $("#mapLegendScale").addEventListener("load", () => { $("#mapLegendScale").hidden = !!VARS[state.mapLayer]; });
  syncLayerControls(null);
  // pre-run the satellite analyses so the ledger shows measured cards immediately
  for (const s of SITES) for (const id of Object.keys(VARS)) { const ser = SERIES[s.id]?.[id]; if (ser) (lastResults[s.id] ||= {})[id] = Stats.analyze(ser, s.onset); }
  selectSite(SITES[0], { fly: false });
  // Unreal / embed hook: ?site=colossus1&var=NO2&embed=1
  const q = new URLSearchParams(location.search);
  if (q.get("site") && S[q.get("site")]) selectSite(S[q.get("site")], { varId: q.get("var") || undefined });
  if (q.get("tour") != null) showTour(+q.get("tour"));
  if (q.get("embed")) { $("#globe").style.display = "none"; $("#topbar").style.display = "none"; $("#panel").style.width = "100%"; }
  window.CloudShadow = { selectSite: (id, v) => S[id] && selectSite(S[id], { varId: v }), viewer, state, sites: SITES, flyTo, setMapLayer, getMapLayer: () => state.mapLayer };
  const [{attachEnvironmentPanel},{attachEnvironmentMap},{attachEnvironmentStory},{attachSiteEvidence},{attachFutureData},{attachFutureScene},{attachEvidenceWorkbench},{attachSceneReadout},{attachEvidenceScene}]=await Promise.all([import('./environment-panel.js'),import('./environment-map.js'),import('./environment-story.js'),import('./scene-evidence.js'),import('./future-data.js'),import('./future-scene.js'),import('./evidence-workbench.js'),import('./scene-readout.js'),import('./evidence-scene.js')]);
  const initialYear=+q.get('year')||+$('#tlSlider').value||2025;
  attachEnvironmentMap(viewer,{sites:SITES});
  import('./water-map.js').then(({attachWaterMap})=>{window.CloudShadow.water=attachWaterMap(viewer);if(state.mapLayer==='Water')refreshOverlay();}).catch(()=>{});
  attachSceneReadout(viewer);
  const futureData=attachFutureData({site:state.site,year:initialYear,loadSupplemental:true,onRequest:(kind,options)=>environmentPanel?.runAction(kind,options)});
  window.addEventListener('cs:future-state',({detail})=>{
    // The future scene carries model-period labels; an empty satellite legend
    // must not obscure those results or suggest every model is unavailable.
    if(detail?.state?.year>new Date().getUTCFullYear())$('#mapLegend').hidden=true;
  });
  const futureScene=attachFutureScene(viewer,{site:state.site,year:initialYear});
  const evidenceScene=attachEvidenceScene(viewer);
  environmentStory=attachEnvironmentStory({site:state.site,sites:SITES,seriesBySite:SERIES,varId:state.varId,year:initialYear,futureState:futureData.state,onSelectVariable:id=>setMapLayer(id,null,null,false),onOpenEvidence:action=>environmentPanel.openAction(action),onSelectYear:year=>window.CloudShadowTimeline?.setYear(year)});
  environmentPanel=attachEnvironmentPanel({site:state.site,sites:SITES,year:initialYear,apiBase:location.hostname==='localhost'||location.hostname==='127.0.0.1'?'/api/environment':undefined});
  const evidenceWorkbench=attachEvidenceWorkbench({site:state.site,year:initialYear,futureState:futureData.state,onRequest:payload=>environmentPanel.runAction('environment-screening',{payload}),onSelectYear:year=>window.CloudShadowTimeline?.setYear(year)});
  futureScene.setState(futureData.state);
  evidenceScene.setState(futureData.state);
  futureData.publish();
  $('#story').before($('#environmentStory'));
  $('#environmentStory').after(evidenceWorkbench.element);
  for(const [id,analysis] of Object.entries(lastResults[state.site.id]||{}))environmentStory.setAnalysis(id,analysis,state.site.id);
  $('#changeHeadline').hidden=true;
  attachSiteEvidence({site:state.site,year:+q.get('year')||2025,host:document.querySelector('#timeline .tl-main')});
  const syncTimelineInset=()=>document.documentElement.style.setProperty('--timeline-height',`${Math.ceil($('#timeline').getBoundingClientRect().height)}px`);
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(syncTimelineInset).observe($('#timeline'));
  syncTimelineInset();
  window.CloudShadow.environment=environmentPanel;
  window.CloudShadow.future=futureData;
  window.CloudShadow.evidenceWorkbench=evidenceWorkbench;
  window.dispatchEvent(new CustomEvent("cs:ready", { detail: window.CloudShadow }));
})();
