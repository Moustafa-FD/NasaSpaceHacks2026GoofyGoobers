// Footprint Atlas - real wind flow from NASA GEOS-FP analyses (flow-field/1.0 products).
//
// Data: data/fields/index.json + <site|global>/<year>.json/.wind.png, built by
//   python -m services.models.fields.build   (see docs/flow-fields.md; same files feed Unreal).
// What it does for the selected site/year:
//   1. particle trails advected by the real gridded 10 m wind (site box when zoomed in, globe when zoomed out),
//      cycling through that year's analysis frames (time-lapse);
//   2. broadcasts the analysed wind at the site as a "cs:wind" event so clouds
//      follow the actual wind of each frame instead of one annual mean arrow.
// Evidence: GEOS-FP is a model analysis (observations assimilated), not a local
// anemometer measurement or a forecast. Display acceleration is illustrative.
// Particles show where air moves; they are not pollutant concentrations.

const SECONDS_PER_FRAME = 2.0;      // time-lapse: one analysis frame every 2 s
// Above this camera height the site box (±3°×±4°) no longer fills the view, so the
// global field takes over; otherwise zooming out shows an isolated "sector" of wind.
const GLOBAL_ALTITUDE_M = 600_000;
const TRAIL = 6;

const cache = new Map();
let indexPromise = null;

export function loadIndex() {
  indexPromise ??= fetch("data/fields/index.json").then((r) => (r.ok ? r.json() : { products: [] })).catch(() => ({ products: [] }));
  return indexPromise;
}

function loadImage(url) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
}

/** Load and decode one product into per-frame Float32 u/v grids (rows north→south, as stored). */
export async function loadField(product) {
  if (cache.has(product.id)) return cache.get(product.id);
  const promise = (async () => {
    const response=await fetch(`data/fields/${product.manifest}`);
    if(!response.ok)throw new Error('Wind analysis unavailable');
    const m = await response.json();
    const img = await loadImage(`data/fields/${product.files.wind}`);
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const { nx, ny } = m.grid, { cols } = m.atlas;
    const R = m.encoding.wind.R, G = m.encoding.wind.G;
    const dec = (b, ch) => ch.min + (b / 255) * (ch.max - ch.min);
    const frames = m.frames.map((_, f) => {
      const ox = (f % cols) * nx, oy = Math.floor(f / cols) * ny;
      const u = new Float32Array(nx * ny), v = new Float32Array(nx * ny), ok = new Uint8Array(nx * ny);
      for (let r = 0; r < ny; r++) for (let q = 0; q < nx; q++) {
        const p = ((oy + r) * img.width + ox + q) * 4, k = r * nx + q;
        u[k] = dec(px[p], R); v[k] = dec(px[p + 1], G); ok[k] = px[p + 2] > 127 ? 1 : 0;
      }
      return { u, v, ok };
    });
    return { m, frames };
  })();
  cache.set(product.id, promise);
  promise.catch(()=>{if(cache.get(product.id)===promise)cache.delete(product.id);});
  while(cache.size>4)cache.delete(cache.keys().next().value);
  return promise;
}

/** Bilinear in space, linear in time; t = fractional frame index. Returns null outside the grid. */
export function sampleWind(field, lat, lon, t) {
  if(!field?.m?.grid||!field.frames?.length||![lat,lon,t].every(Number.isFinite))return null;
  const g = field.m.grid, n = field.frames.length;
  if(g.nx<2||g.ny<2||g.latMax<=g.latMin||g.lonMax<=g.lonMin)return null;
  const dLat = (g.latMax - g.latMin) / (g.ny - 1), dLon = (g.lonMax - g.lonMin) / (g.nx - 1);
  let fx = (lon - g.lonMin) / dLon;
  if (g.wrapsLongitude) fx = ((fx % g.nx) + g.nx) % g.nx;
  const fy = (g.latMax - lat) / dLat; // rows are north → south
  if (fy < 0 || fy > g.ny - 1 || (!g.wrapsLongitude && (fx < 0 || fx > g.nx - 1))) return null;
  const i0 = Math.floor(fx), j0 = Math.min(Math.floor(fy), g.ny - 2);
  const i1 = g.wrapsLongitude ? (i0 + 1) % g.nx : Math.min(i0 + 1, g.nx - 1);
  const tx = fx - i0, ty = fy - j0;
  const f0 = ((Math.floor(t) % n)+n)%n, f1 = (f0 + 1) % n, tt = t - Math.floor(t);
  let u = 0, v = 0;
  for (const [fr, w] of [[field.frames[f0], 1 - tt], [field.frames[f1], tt]]) {
    if(w===0)continue;
    const a = j0 * g.nx, b = (j0 + 1) * g.nx;
    const corners=[[a+i0,(1-tx)*(1-ty)],[a+i1,tx*(1-ty)],[b+i0,(1-tx)*ty],[b+i1,tx*ty]];
    if(corners.some(([index,weight])=>weight>1e-9&&(!fr.ok[index]||!Number.isFinite(fr.u[index])||!Number.isFinite(fr.v[index]))))return null;
    const bl=(arr)=>corners.reduce((sum,[index,weight])=>sum+(weight>1e-9?arr[index]*weight:0),0);
    u += bl(fr.u) * w; v += bl(fr.v) * w;
  }
  return { u, v };
}

/** Analysed wind at the site point (exact values from the manifest), vector-interpolated in time. */
export function siteWindAt(field, t) {
  const s = field.m.siteSeries; if (!s?.length) return null;
  const n = s.length,index=((Math.floor(t)%n)+n)%n,a = s[index], b = s[(index + 1) % n], w = t - Math.floor(t);
  if(![a.u,a.v].every(v=>typeof v==='number'&&Number.isFinite(v))||(w>0&&![b.u,b.v].every(v=>typeof v==='number'&&Number.isFinite(v))))return null;
  if(w===0)return {u:a.u,v:a.v,speed:Math.hypot(a.u,a.v),towardDeg:(Math.atan2(a.u,a.v)*180/Math.PI+360)%360,time:a.time};
  const u = a.u * (1 - w) + b.u * w, v = a.v * (1 - w) + b.v * w;
  return { u, v, speed: Math.hypot(u, v), towardDeg: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360, time: (w < 0.5 ? a : b).time };
}

const speedColor = (s) => {
  const k = Math.min(1, s / 12);
  return k < 0.5 ? Cesium.Color.fromCssColorString("#7fd3ff").withAlpha(0.55 + k)
                 : Cesium.Color.fromCssColorString("#e2f5ff").withAlpha(0.8);
};

/** Particle-trail layer for one field. */
class Particles {
  constructor(viewer, field, { count, altitude, timeLapse, bbox }) {
    this.viewer = viewer; this.field = field; this.altitude = altitude; this.timeLapse = timeLapse; this.baseTimeLapse = timeLapse; this.bbox = bbox; this.view = null;
    this.lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.p = Array.from({ length: count }, () => this.spawn({}));
    for (const p of this.p) p.line = this.lines.add({ positions: this.positions(p), width: bbox.global ? 2.0 : 1.6, material: Cesium.Material.fromType("Color", { color: Cesium.Color.TRANSPARENT }) });
  }
  /** Global particles spawn inside the visible area (dense flow at any zoom). */
  viewBox() {
    if (!this.bbox.global) return null;
    const r = this.viewer.camera.computeViewRectangle?.(this.viewer.scene.globe.ellipsoid);
    if (!r) return null;
    const D = 180 / Math.PI;
    let w = r.west * D, e = r.east * D;
    if (e < w) e += 360;                                   // view crosses the dateline
    return [w, Math.max(-85, r.south * D), e, Math.min(85, r.north * D)];
  }
  spawn(p) {
    const view = this.view, [w, s, e, n] = view || this.bbox;
    let lat, lon;
    if (this.bbox.global && view) { lat = s + Math.random() * (n - s); lon = w + Math.random() * (e - w); if (lon > 180) lon -= 360; }
    else { lat = this.bbox.global ? Math.asin(2 * Math.random() - 1) * 180 / Math.PI * 0.95 : s + Math.random() * (n - s); lon = w + Math.random() * (e - w); }
    p.trail = Array.from({ length: TRAIL }, () => [lon, lat]);
    p.age = 0; p.life = 3 + Math.random() * 4; p.speed = 0;
    return p;
  }
  positions(p) { return p.trail.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la, this.altitude)); }
  step(dt, t, frameCounter) {
    const R = 6_371_000;
    if (this.bbox.global) {
      if (frameCounter % 15 === 0 || !this.view) this.view = this.viewBox();
      // Trail speed follows zoom so motion stays readable from regional to whole-Earth views.
      const h = this.viewer.camera.positionCartographic.height;
      this.timeLapse = this.baseTimeLapse * Math.max(0.25, Math.min(4, h / 2_500_000));
    }
    for (const p of this.p) {
      p.age += dt;
      const [lon, lat] = p.trail[p.trail.length - 1];
      const w = sampleWind(this.field, lat, lon, t);
      if (!w || p.age > p.life) { this.spawn(p); p.line.material.uniforms.color = Cesium.Color.TRANSPARENT; continue; }
      const k = this.timeLapse * dt;
      const nlat = lat + (w.v * k / R) * 180 / Math.PI;
      let nlon = lon + (w.u * k / (R * Math.max(0.05, Math.cos(lat * Math.PI / 180)))) * 180 / Math.PI;
      if (nlon > 180) nlon -= 360; if (nlon < -180) nlon += 360;
      if (frameCounter % 2 === 0) { p.trail.shift(); p.trail.push([nlon, nlat]); }
      else p.trail[p.trail.length - 1] = [nlon, nlat];
      if (Math.abs(nlon - lon) > 90) { this.spawn(p); continue; } // dateline jump: restart trail
      p.speed = Math.hypot(w.u, w.v);
      const fade = Math.min(1, p.age / 0.6, (p.life - p.age) / 0.8);
      const c = speedColor(p.speed); c.alpha *= Math.max(0, fade);
      p.line.material.uniforms.color = c;
      p.line.positions = this.positions(p);
    }
  }
  set show(v) { this.lines.show = v; }
  get show() { return this.lines.show; }
  dispose() { this.viewer.scene.primitives.remove(this.lines); }
}

/** Clock deltas are already multiplied by the shared motion slider. Year/light
 * jumps are discontinuities, not wind time; never apply the multiplier twice. */
export function analysisDeltaSeconds(delta,animating=true){return animating&&Number.isFinite(delta)&&delta>0&&delta<5?Math.min(delta,.25):0;}
export const flowBudget=(quality)=>({high:{site:420,global:1800},balanced:{site:220,global:1100},low:{site:100,global:600}}[quality]||{site:220,global:1100});
/** Latest analysed year before the current calendar year (a complete year) that has this
 * site's wind field; falls back to the latest available year. */
export function referenceWindYear(index,siteId,currentYear=new Date().getUTCFullYear()){
  const years=[...new Set((index?.products||[]).filter(p=>p.kind==='site'?p.site===siteId:p.kind==='global').map(p=>p.year))].filter(Number.isInteger).sort((a,b)=>b-a);
  return years.find(y=>y<currentYear)??years[0]??null;
}
export function resolveWindReadout(row={},phase='observed',analysis=null){
  if(analysis?.reference&&Number.isFinite(analysis.speed)&&Number.isFinite(analysis.towardDeg))return {...analysis,label:`GEOS-FP ${analysis.referenceYear} pattern`,title:`Wind trails show NASA GEOS-FP analysed winds from ${analysis.referenceYear}, the latest complete year, as a reference pattern. No wind forecast exists for future years.`};
  const known=value=>typeof value==='number'&&Number.isFinite(value);
  if((phase==='observed'||phase==='present')&&analysis&&known(analysis.speed)&&known(analysis.towardDeg))return {...analysis,label:'GEOS-FP analysis',title:'NASA GEOS-FP assimilated model analysis at the displayed UTC time. Arrow points toward travel; not a local anemometer measurement. Motion is an illustrative time-lapse.'};
  if(phase==='climate'||phase==='scenario')return null;
  const speed=row.WS10M==null||row.WS10M===''?null:Number(row.WS10M),direction=row.PlumeTowardDeg==null||row.PlumeTowardDeg===''?null:Number(row.PlumeTowardDeg);
  if(!known(speed)||!known(direction))return null;
  return {speed:Math.max(0,speed),towardDeg:direction,label:phase==='projected'?'Illustrative wind':'POWER annual mean',title:phase==='projected'?'Projected-year climatology reference; not a NASA observation or a wind forecast. Arrow points toward travel.':'NASA POWER (MERRA-2) annual mean wind; not the current weather. Arrow points toward travel.'};
}
/** Small geographic forcing grid for the optional fluid dev tool. RG are wind
 * components in solver units, B validity; missing samples never invent wind. */
export function windForcingGrid(sample,site,{size=16,halfSizeM=16000,units=1,northFirst=false}={},out=new Float32Array(size*size*4)){
  const latitudeScale=halfSizeM/111320,longitudeScale=latitudeScale/Math.max(.05,Math.cos(site.lat*Math.PI/180));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const north=(northFirst?-1:1)*(2*(y+.5)/size-1),east=2*(x+.5)/size-1;
    const wind=sample?.(site.lat+north*latitudeScale,site.lon+east*longitudeScale),index=(y*size+x)*4;
    const valid=wind&&Number.isFinite(wind.u)&&Number.isFinite(wind.v);
    out[index]=valid?wind.u*units:0;out[index+1]=valid?wind.v*units*(northFirst?-1:1):0;
    out[index+2]=valid?1:0;out[index+3]=1;
  }
  return out;
}

/** One wind layer/model/clock. No field-sized ground rectangles or second HUD. */
export function attachFlow(viewer,options={}) {
  const disabled=new URLSearchParams(location.search).get('flow')==='off';
  const readIndex=options.loadIndex||loadIndex,readField=options.loadField||loadField;
  const makeLayer=options.createLayer||((field,settings)=>new Particles(viewer,field,settings));
  const F={site:null,year:null,phase:null,siteLayer:null,globalLayer:null,siteField:null,globalField:null,t:0,frame:0,token:0,localScene:false,quality:options.quality||'high',key:null};
  let alive=true,lastTime=Cesium.JulianDate.clone(viewer.clock.currentTime),sinceEmit=0,accumulated=0,pending;
  const emit=(type,detail)=>window.dispatchEvent(new CustomEvent(type,{detail}));
  const unavailable=(reason)=>emit('cs:wind-state',{active:false,siteId:F.site?.id,year:F.year,reason});
  const clear=()=>{F.siteLayer?.dispose();F.globalLayer?.dispose();F.siteLayer=F.globalLayer=null;F.siteField=F.globalField=null;};
  function visibility(){
    const global=viewer.camera.positionCartographic.height>GLOBAL_ALTITUDE_M;
    if(F.siteLayer)F.siteLayer.show=!F.localScene&&!global;
    if(F.globalLayer)F.globalLayer.show=!F.localScene&&global;
  }
  function publish(){
    const field=F.siteField||F.globalField;if(!field)return;
    let wind=siteWindAt(field,F.t);
    if(!wind){
      const value=sampleWind(field,F.site.lat,F.site.lon,F.t);
      if(value)wind={...value,speed:Math.hypot(value.u,value.v),towardDeg:(Math.atan2(value.u,value.v)*180/Math.PI+360)%360,time:field.m.frames[Math.floor(F.t)%field.frames.length]?.time};
    }
    if(!wind){unavailable('Analysis has no valid wind at this location');return;}
    const token=F.token;
    emit('cs:wind',{...wind,active:true,source:F.referenceYear?`NASA GEOS-FP ${F.referenceYear} analysis · reference pattern, not a forecast`:'NASA GEOS-FP analysis',reference:!!F.referenceYear,referenceYear:F.referenceYear||null,siteId:F.site.id,year:F.year,
      sampleWind:(lat,lon)=>token===F.token?sampleWind(field,lat,lon,F.t):null});
  }
  function buildLayers(){
    F.siteLayer?.dispose();F.globalLayer?.dispose();F.siteLayer=F.globalLayer=null;
    const budget=flowBudget(F.quality);
    if(F.siteField){const g=F.siteField.m.grid;F.siteLayer=makeLayer(F.siteField,{count:budget.site,altitude:2500,timeLapse:4500,bbox:[g.lonMin,g.latMin,g.lonMax,g.latMax]});}
    if(F.globalField)F.globalLayer=makeLayer(F.globalField,{count:budget.global,altitude:30000,timeLapse:80000,bbox:Object.assign([-180,-90,180,90],{global:true})});
    visibility();
  }
  function setYear(site,year,phase){
    const key=`${site?.id}:${year}:${phase}`;
    if(F.key===key){publish();return pending||Promise.resolve();}
    const future=phase==='projected'||phase==='climate'||phase==='scenario';
    // Scrubbing through future years: the reference-year trails are identical, so keep them.
    if(future&&site&&F.refSite===site.id&&F.referenceYear&&(F.siteLayer||F.globalLayer)){F.key=key;F.year=year;F.phase=phase;pending=null;++F.token;publish();return Promise.resolve();}
    F.key=key;F.site=site;F.year=year;F.phase=phase;F.t=0;pending=null;F.refSite=null;const token=++F.token;
    clear();F.referenceYear=null;unavailable(future?'Loading reference-year winds (no wind forecast exists)':'Loading wind analysis');
    lastTime=Cesium.JulianDate.clone(viewer.clock.currentTime);sinceEmit=accumulated=0;
    if(disabled||!site)return Promise.resolve();
    pending=(async()=>{
      try{
        const index=await readIndex();if(!alive||token!==F.token)return;
        // Future years have no analysed or forecast winds. Show the latest complete analysed
        // year as an explicitly labelled reference pattern, never the previously shown year.
        const source=future?referenceWindYear(index,site.id):year;
        if(future){F.referenceYear=source;if(!Number.isInteger(source)){unavailable('No GEOS-FP reference year available');return;}}
        const find=kind=>(index.products||[]).find(p=>p.kind===kind&&p.year===source&&(kind==='global'||p.site===site.id));
        const sp=find('site'),gp=find('global');
        const loaded=await Promise.allSettled([sp?readField(sp):null,gp?readField(gp):null]);
        if(!alive||token!==F.token)return;
        F.siteField=loaded[0].status==='fulfilled'?loaded[0].value:null;
        F.globalField=loaded[1].status==='fulfilled'?loaded[1].value:null;
        buildLayers();if(future)F.refSite=site.id;
        if(F.siteField||F.globalField)publish();else unavailable('No wind analysis available for this year');
      }catch{if(alive&&token===F.token){clear();unavailable('Wind analysis unavailable');}}
    })();
    return pending;
  }
  function tick(){
    if(!alive)return;
    const clock=viewer.clock,delta=Cesium.JulianDate.secondsDifference(clock.currentTime,lastTime);
    lastTime=Cesium.JulianDate.clone(clock.currentTime,lastTime);
    visibility();
    const dt=analysisDeltaSeconds(delta,clock.shouldAnimate!==false&&clock.multiplier!==0&&document.visibilityState!=='hidden');
    if(!dt||(!F.siteField&&!F.globalField))return;
    const n=(F.siteField||F.globalField).frames.length;F.t=(F.t+dt/SECONDS_PER_FRAME)%n;
    accumulated+=dt;sinceEmit+=dt;
    if(accumulated>=1/30){
      const step=Math.min(.25,accumulated);accumulated=0;F.frame++;
      if(F.siteLayer?.show)F.siteLayer.step(step,F.t,F.frame);
      if(F.globalLayer?.show)F.globalLayer.step(step,F.t%F.globalField.frames.length,F.frame);
    }
    if(sinceEmit>=.2){sinceEmit=0;publish();}
  }
  const removeTick=viewer.scene.preRender.addEventListener(tick);
  const onScene=event=>{F.localScene=!!event.detail?.active;visibility();};
  const onQuality=event=>{const next=event.detail?.quality||'balanced';if(next===F.quality)return;F.quality=next;if(F.siteField||F.globalField)buildLayers();};
  window.addEventListener('cs:scene-mode',onScene);window.addEventListener('cs:quality',onQuality);
  return {setYear,reset(site,year){F.token++;F.key=null;pending=null;F.site=site;F.year=year;clear();unavailable('Loading site wind');},get state(){return F;},dispose(){alive=false;F.token++;clear();removeTick();window.removeEventListener('cs:scene-mode',onScene);window.removeEventListener('cs:quality',onQuality);}};
}
