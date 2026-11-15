import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createSceneStreamer,streamKey,streamRadius,radialCoverage,fadeWeights,waitForModelReady} from '../apps/web/js/scene-streaming.js';
import {createSceneCompiler} from '../apps/web/js/scene-compiler.js';
import {setLandscapeEvidence,normalizeEvidenceTexture,clearLandscapeEvidencePrevious,createEvidenceTransition} from '../apps/web/js/landscape-shader.js';
const ready=(point)=>({status:200,json:async()=>({status:'ready',center:point,snapshot:{center:point}})});
const turn=()=>new Promise((resolve)=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise((r)=>resolve=r);return {promise,resolve};};

test('stream boundaries are circular, smoothly feathered and bounded at every height/fade time',()=>{
  const circle={x:100,y:200,radius:2400};
  assert.equal(radialCoverage({x:100,y:200},circle),1);
  assert.equal(radialCoverage({x:2500,y:200},circle),0);
  assert.equal(radialCoverage({x:2200,y:200},circle),.5);
  assert.equal(radialCoverage({x:100,y:2300},circle),.5);
  assert.ok(Math.abs(radialCoverage({x:100+2100/Math.sqrt(2),y:200+2100/Math.sqrt(2)},circle)-.5)<1e-12,'diagonal has the same fade as cardinal points');
  for(const height of [-100,0,500,2100,100000])assert.ok(streamRadius(height)>=2200&&streamRadius(height)<=3000);
  for(const elapsed of [-100,0,500,2000,9000]){const w=fadeWeights(elapsed);assert.equal(w.incoming+w.outgoing,1);assert.ok(w.incoming>=0&&w.incoming<=1);}
  assert.equal(streamKey({lat:35.12345,lon:-89.98765}),'35.12,-89.99');
});

test('one in-flight job polls pending responses and keeps only the latest queued camera region',async()=>{
  const first=deferred(),calls=[],shown=[],timers=new Map();let timerId=0,requests=0;
  const streamer=createSceneStreamer({
    request:async(point)=>{calls.push({...point});requests++;if(requests===1)return first.promise;if(requests===2)return {status:202,json:async()=>({retryAfterMs:2000})};return ready(point);},
    onReady:(data)=>shown.push(data.center),setTimer:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimer:(id)=>timers.delete(id),
  });
  streamer.setAnchor({lat:0,lon:0});streamer.update({lat:.02,lon:0});streamer.update({lat:.04,lon:0});streamer.update({lat:.06,lon:0});
  assert.equal(calls.length,1);first.resolve(ready({lat:.02,lon:0}));await turn();
  assert.equal(calls.length,2);assert.equal(calls[1].lat,.06,'intermediate camera regions do not create extra requests');
  assert.equal(shown.length,0,'obsolete area never replaces current scenery');assert.equal(timers.size,1);
  const retry=[...timers.values()][0];timers.clear();retry();await streamer.idle();
  assert.equal(calls.length,3);assert.deepEqual(shown,[{lat:.06,lon:0}]);assert.equal(streamer.state,'ready');streamer.destroy();
});

test('compiled-region cache is LRU bounded to two and cache revisits avoid network work',async()=>{
  let calls=0,prepared=0;const streamer=createSceneStreamer({request:async(p)=>{calls++;return ready(p);},prepare:async(v)=>{prepared++;return v;}});
  streamer.setAnchor({lat:0,lon:0});
  for(const lat of [.02,.04,.06]){streamer.update({lat,lon:0});await streamer.idle();}
  assert.equal(calls,3);assert.equal(prepared,3);assert.equal(streamer.cacheKeys.length,2);assert.ok(!streamer.cacheKeys.includes('0.02,0.00'));
  streamer.update({lat:.04,lon:0});await streamer.idle();assert.equal(calls,3);assert.equal(prepared,3);streamer.destroy();
});

test('returning within the loaded anchor cancels a nearby request or compilation before its late result can replace the scene',async()=>{
  // 0.011deg is about1,225m: beyond the1,150m prefetch trigger but inside the
  // old1,400m relevance tolerance that incorrectly installed an obsolete patch.
  for(const pendingPhase of ['request','prepare']){
    const gate=deferred(),shown=[],signals=[],states=[];let prepared=0;
    const streamer=createSceneStreamer({
      request:async(point,signal)=>{signals.push(signal);if(pendingPhase==='request')await gate.promise;return ready(point);},
      prepare:async(data)=>{prepared++;if(pendingPhase==='prepare')await gate.promise;return data;},
      onReady:(data)=>shown.push(data.center),onState:(s)=>states.push(s),
    });
    const anchor={lat:0,lon:0};streamer.setAnchor(anchor);streamer.update({lat:.011,lon:0});await turn();
    const pending=streamer.idle();streamer.update({lat:0.0001,lon:0});
    assert.equal(signals[0].aborted,true);assert.equal(streamer.pending,false);assert.equal(streamer.state,'ready');assert.deepEqual(states.at(-1).center,anchor);
    gate.resolve();await pending;await turn();
    assert.deepEqual(shown,[],'late source/worker completion cannot reset current geometry or local activity');
    assert.equal(streamer.cacheKeys.length,0,'obsolete compilation is not retained after cancellation');
    if(pendingPhase==='request')assert.equal(prepared,0,'cancelled network work never starts geometry generation');
    streamer.update({lat:0,lon:0});assert.equal(signals.length,1,'remaining in the loaded region does not restart acquisition');streamer.destroy();
  }
});

test('zoom-out/site reset abort requests and ignore stale async compilation without installing models',async()=>{
  const compilation=deferred(),shown=[],signals=[];
  const streamer=createSceneStreamer({request:async(p,signal)=>{signals.push(signal);return ready(p);},prepare:async(v)=>{await compilation.promise;return v;},onReady:(data)=>shown.push(data)});
  streamer.setAnchor({lat:0,lon:0});streamer.update({lat:.02,lon:0});await turn();
  assert.equal(streamer.state,'building');streamer.update({lat:.02,lon:0},{height:2200});assert.equal(signals[0].aborted,true);
  streamer.reset({lat:1,lon:1});compilation.resolve();await turn();assert.equal(shown.length,0);assert.equal(streamer.cacheKeys.length,0);assert.equal(streamer.pending,false);streamer.destroy();
});

test('failed area cooldown avoids retry storms and destroy clears pending poll timers',async()=>{
  let at=0,calls=0;const timers=new Map();let next=0;
  const streamer=createSceneStreamer({now:()=>at,request:async()=>{calls++;return {status:503,json:async()=>({error:'Source unavailable',retryAfterMs:60000})};}});
  streamer.setAnchor({lat:0,lon:0});streamer.update({lat:.02,lon:0});await streamer.idle();
  for(let i=0;i<10;i++)streamer.update({lat:.02,lon:0});assert.equal(calls,1);
  at=60001;streamer.update({lat:.02,lon:0});await streamer.idle();assert.equal(calls,2);streamer.destroy();
  const polling=createSceneStreamer({request:async()=>({status:202,json:async()=>({retryAfterMs:2000})}),setTimer:(fn)=>{timers.set(++next,fn);return next;},clearTimer:(id)=>timers.delete(id)});
  polling.setAnchor({lat:0,lon:0});polling.update({lat:.02,lon:0});await turn();assert.equal(timers.size,1);polling.destroy();await turn();assert.equal(timers.size,0);
});

function event(){const listeners=new Set();return {listeners,addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);},raise(v){for(const fn of [...listeners])fn(v);}};}
test('GPU readiness wait does not swap on GLB parse and releases event/timer handlers on ready, failure and abort',async()=>{
  const timers=new Map();let next=0;const options={setTimer:(fn)=>{timers.set(++next,fn);return next;},clearTimer:(id)=>timers.delete(id)};
  for(const outcome of ['ready','failure','abort']){
    const model={ready:false,readyEvent:event(),errorEvent:event()},abort=new AbortController();let settled=false;
    const wait=waitForModelReady(model,abort.signal,options).then(()=>{settled=true;},(e)=>{settled=true;return e;});
    await turn();assert.equal(settled,false,'parsed model must wait for actual readiness');
    if(outcome==='ready'){model.ready=true;model.readyEvent.raise();}else if(outcome==='failure')model.errorEvent.raise(new Error('bad GPU shader'));else abort.abort();
    const error=await wait;assert.equal(settled,true);if(outcome==='failure')assert.match(error.message,/bad GPU shader/);if(outcome==='abort')assert.equal(error.name,'AbortError');
    assert.equal(model.readyEvent.listeners.size,0);assert.equal(model.errorEvent.listeners.size,0);assert.equal(timers.size,0);
  }
});

async function rendererHarness({raf=false}={}) {
  const nodes=new Map(),models=[],shaders=[],controllers=[],primitives=[],workers=[],warnings=[];let clock=0,parseGate=null;
  const element=(id)=>{if(!nodes.has(id))nodes.set(id,{dataset:{},hidden:false,textContent:''});return nodes.get(id);};
  class V3{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(x,y){return new V3(x*111320,y*111320,0);}static distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}static normalize(v,out){const length=Math.hypot(v.x,v.y,v.z);out.x=v.x/length;out.y=v.y/length;out.z=v.z/length;return out;}}
  class M4{static inverseTransformation(m){return m;}static multiplyByPoint(m,p,out){return Object.assign(out,p);}static multiplyByPointAsVector(m,p,out){return Object.assign(out,p);}}
  const C={Cartesian3:V3,Cartesian2:V3,Cartesian4:class{constructor(...values){this.values=values;}},TextureUniform:class{constructor(options){Object.assign(this,options);}},PixelFormat:{RGBA:1},PixelDatatype:{UNSIGNED_BYTE:1},TextureMinificationFilter:{NEAREST:1},TextureMagnificationFilter:{NEAREST:1},Matrix4:M4,Axis:{Y:1,X:0},ShadowMode:{ENABLED:1},Transforms:{eastNorthUpToFixedFrame:()=>new M4()},
    Math:{toDegrees:(v)=>v,toRadians:(v)=>v},DirectionalLight:class {constructor(options){Object.assign(this,options);}},Cartographic:{fromCartesian:(p)=>({latitude:p.y/111320,longitude:p.x/111320,height:p.z})},BoundingSphere:class {},HeadingPitchRange:class {},
    Model:{fromGltfAsync:async(options)=>{
      const model={...options,ready:false,readyEvent:event(),errorEvent:event(),destroyed:false,isDestroyed(){return this.destroyed;},destroy(){assert.equal(this.destroyed,false,'model destroyed only once');this.destroyed=true;}};
      models.push(model);if(parseGate)await parseGate;return model;
    }}};
  const controller=()=>{const c={active:false,destroyed:false,years:[],setYear(...args){assert.equal(this.destroyed,false);this.years.push(args);},setQuality(){},setActive(v){assert.equal(this.destroyed,false);this.active=v;},destroy(){assert.equal(this.destroyed,false,'controller destroyed only once');this.destroyed=true;}};controllers.push(c);return c;};
  const shader=()=>{const s={values:{},destroyed:false,setUniform(k,v){assert.equal(this.destroyed,false);this.values[k]=v;},isDestroyed(){return this.destroyed;},destroy(){assert.equal(this.destroyed,false,'shader destroyed only once');this.destroyed=true;this.values={};}};shaders.push(s);return s;};
  let lookAt=new V3();
  const viewer={canvas:{clientWidth:1000,clientHeight:700},shadowMap:{_primitiveBias:{depthBias:1,normalOffsetScale:1},maximumDistance:10000},camera:{positionCartographic:{height:500},pickEllipsoid:()=>lookAt,flyToBoundingSphere(){}},
    scene:{light:{},highDynamicRange:true,postProcessStages:{bloom:{enabled:true}},screenSpaceCameraController:{},globe:{ellipsoid:{}},primitives:{add(m){primitives.push(m);return m;},remove(m){const i=primitives.indexOf(m);if(i<0)return false;primitives.splice(i,1);m.destroy();return true;}}}};
  class Worker {
    posted=[];terminated=false;
    constructor(){workers.push(this);}
    postMessage(data){this.posted.push(data);}
    emit(data){this.onmessage?.({data});}
    terminate(){this.terminated=true;}
  }
  const windowEvents=new Map();
  const frameCallbacks=new Map();let nextFrame=0;
  const context={Cesium:C,URL,Blob,AbortController,DOMException,setTimeout,clearTimeout,performance:{now:()=>clock},console:{...console,warn:(...args)=>warnings.push(args)},Worker,
    location:{search:''},URLSearchParams,window:{addEventListener(type,fn){if(!windowEvents.has(type))windowEvents.set(type,[]);windowEvents.get(type).push(fn);},dispatchEvent(event){for(const fn of windowEvents.get(event.type)||[])fn(event);}},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    document:{querySelector:element,body:{classList:{toggle(){}}}},createLandscapeShader:shader,setLandscapeEvidence,normalizeEvidenceTexture,clearLandscapeEvidencePrevious,createEvidenceTransition:(options)=>createEvidenceTransition({...options,now:()=>clock}),sampleElevation:()=>0,
    attachCampusEffects:controller,attachSceneEvidence:(_viewer,site,data)=>{const c=controller();c.kind='evidence';c.site=site;c.data=data;return c;},attachCityLife:controller,attachLocalAtmosphere:controller,currentQuality:()=> 'low',
    createSceneCompiler,createSceneStreamer,streamKey,streamRadius,fadeWeights,waitForModelReady,
    fetch:async()=>({ok:true,json:async()=>({status:'ready'})})};
  if(raf){context.window.requestAnimationFrame=(fn)=>{frameCallbacks.set(++nextFrame,fn);return nextFrame;};context.window.cancelAnimationFrame=(id)=>frameCallbacks.delete(id);}
  const source=(await readFile(new URL('../apps/web/js/neighborhood.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  runInNewContext(source+`\nglobalThis.sceneHooks={showData,removeModel,tickPatches,enter,evaluateCamera,prepare,ensureOverview,get active(){return active;},get current(){return currentPatch;},get retiring(){return retiringPatch;},get uploading(){return uploadingPatch;},seed(v,d,options={}){viewer=v;currentSite={id:'selected',lat:0,lon:0,effects:{plume:true}};baseData=sceneData=d;active=options.active??true;enabled=options.enabled??true;streamer={reset(){},cancel(){},setAnchor(){},update(){}};},invalidate(){generation++;removeModel();},destroy(){prepareAbort?.abort();removeModel();compiler.destroy();}};`,context);
  return {h:context.sceneHooks,viewer,models,shaders,controllers,primitives,workers,warnings,element,C,year:(detail)=>context.applyTimelineFrame(detail),
    evidence(detail){context.window.dispatchEvent({type:'cs:evidence-texture',detail});},
    evidenceFrame(){const callbacks=[...frameCallbacks.values()];frameCallbacks.clear();for(const fn of callbacks)fn();},
    setClock(value){clock=value;},setFocus(lat,lon){lookAt=V3.fromDegrees(lon,lat);},setParseGate(value){parseGate=value;}};
}
const sceneData=(n,stage)=>({buffer:new ArrayBuffer(4),overviewBuffer:stage?undefined:new ArrayBuffer(4),stage,center:{lat:n,lon:n},radius:3300,campuses:[],focus:{x:100,y:0},stats:{buildings:3,trees:5,dataCenters:1}});

test('real evidence events reach current and uploading shaders, persist for future assets, clear without exiting 3D and release with retired models',async(t)=>{
  const {h,viewer,models,shaders,evidence,setClock}=await rendererHarness(),base=sceneData(0,'detail');
  t.after(()=>h.destroy());h.seed(viewer,base);
  const rgba=new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,0]),bounds=[-.02,-.02,.02,.02];
  evidence({active:true,rgba,width:2,height:2,bounds});
  const first=h.showData(base,true);await turn();
  assert.equal(shaders[0].values.u_evidenceActive,1,'an event before the first model upload remains selected');
  assert.deepEqual([...shaders[0].values.u_evidence.typedArray],[...rgba]);
  models[0].ready=true;models[0].readyEvent.raise();await first;
  const replacement=h.showData(sceneData(.01,'detail'),false);await turn();
  assert.equal(h.current.data,base);assert.equal(shaders[1].values.u_evidenceActive,1,'the future upload inherits the existing raster');
  const next=rgba.slice();next[3]=100;evidence({active:true,rgba:next,width:2,height:2,bounds});
  for(const shader of shaders)assert.equal(shader.values.u_evidence.typedArray[3],100,'current and pending models get the new actual alpha');
  assert.equal(h.active,true,'evidence selection leaves the local camera and scene active');
  evidence({active:false});
  for(const shader of shaders){assert.equal(shader.values.u_evidenceActive,0);assert.equal(shader.values.u_evidence.width,1);assert.deepEqual([...shader.values.u_evidence.typedArray],[0,0,0,0]);}
  models[1].ready=true;models[1].readyEvent.raise();await replacement;setClock(2100);h.tickPatches();
  assert.equal(shaders[0].destroyed,true,'retired CustomShader releases its texture manager');
  assert.equal(shaders[0].values.u_evidence,undefined);
  h.destroy();assert.ok(shaders.every((shader)=>shader.destroyed&&shader.values.u_evidence===undefined));
});

test('paused environmental motion still crossfades evidence on wall time without reuploading either source raster every frame',async(t)=>{
  const {h,viewer,models,shaders,evidence,setClock}=await rendererHarness(),base=sceneData(0,'detail');
  t.after(()=>h.destroy());h.seed(viewer,base);viewer.clock={shouldAnimate:false};
  const a=new Uint8Array([255,0,0,255]),b=new Uint8Array([0,0,255,255]),bounds=[-.02,-.02,.02,.02];
  evidence({active:true,rgba:a,width:1,height:1,bounds,key:'site:2005'});
  const first=h.showData(base,true);await turn();models[0].ready=true;models[0].readyEvent.raise();await first;
  setClock(700);h.tickPatches();evidence({active:true,rgba:b,width:1,height:1,bounds,key:'site:2006'});
  assert.equal(shaders[0].values.u_evidenceMix,0);assert.equal(shaders[0].values.u_evidencePreviousActive,1);
  const currentTexture=shaders[0].values.u_evidence,previousTexture=shaders[0].values.u_evidencePrevious;
  setClock(1050);h.tickPatches();assert.equal(shaders[0].values.u_evidenceMix,.5);
  assert.equal(shaders[0].values.u_evidence,currentTexture);assert.equal(shaders[0].values.u_evidencePrevious,previousTexture);
  evidence({active:true,rgba:b,width:1,height:1,bounds,key:'site:2006'});assert.equal(shaders[0].values.u_evidenceMix,.5,'same source key cannot restart the visual fade');
  setClock(1400);h.tickPatches();assert.equal(shaders[0].values.u_evidenceMix,1);assert.equal(shaders[0].values.u_evidencePreviousActive,0);
  assert.deepEqual([...shaders[0].values.u_evidencePrevious.typedArray],[0,0,0,0]);assert.equal(shaders[0].values.u_evidence,currentTexture);
});

test('cached rapid scrubs coalesce to one upload pair per animation frame and keep the last displayed raster as the previous year',async(t)=>{
  const {h,viewer,models,shaders,evidence,evidenceFrame,setClock}=await rendererHarness({raf:true}),base=sceneData(0,'detail');
  t.after(()=>{evidence({active:false});h.destroy();});h.seed(viewer,base);
  const bounds=[-.02,-.02,.02,.02],image=(n)=>({active:true,rgba:new Uint8Array([n,0,0,255]),width:1,height:1,bounds,key:'date:'+n});
  evidence(image(1));evidenceFrame();const first=h.showData(base,true);await turn();models[0].ready=true;models[0].readyEvent.raise();await first;
  setClock(700);evidenceFrame();const shown=shaders[0].values.u_evidence;
  for(let n=2;n<=100;n++)evidence(image(n));
  assert.equal(shaders[0].values.u_evidence,shown,'new scrub targets cannot queue GPU uploads before a frame');
  evidenceFrame();assert.equal(shaders[0].values.u_evidence.typedArray[0],100);
  assert.equal(shaders[0].values.u_evidencePrevious.typedArray[0],1,'an unseen intermediate year is never used as the previous image');
  setClock(1400);evidenceFrame();assert.equal(shaders[0].values.u_evidencePreviousActive,0);
});

test('anchored facility evidence belongs only to the selected base detail and follows its year and disposal lifecycle',async(t)=>{
  const {h,viewer,models,controllers,year}=await rendererHarness(),base=sceneData(0,'detail');
  t.after(()=>h.destroy());h.seed(viewer,base);
  const first=h.showData(base,true);await turn();models[0].ready=true;models[0].readyEvent.raise();await first;
  const label=controllers.find((c)=>c.kind==='evidence');assert.ok(label);assert.equal(label.site.id,'selected');assert.equal(label.active,true);
  assert.equal(label.years.at(-1)[0],2025);year({siteId:'selected',year:2010,row:{},phase:'observed'});assert.equal(label.years.at(-1)[0],2010);
  const changes=label.years.length;year({siteId:'unrelated',year:2030});assert.equal(label.years.length,changes);
  const streamed=h.showData(sceneData(.02,'detail'),false);await turn();models[1].ready=true;models[1].readyEvent.raise();await streamed;
  assert.equal(label.destroyed,true);assert.equal(controllers.filter((c)=>c.kind==='evidence').length,1,'a streamed campus never inherits selected-site history or water labels');
  year({siteId:'selected',year:2030});assert.equal(label.years.length,changes,'retired labels no longer receive timeline changes');
});

test('renderer retains old geometry until GPU-ready, reactivates new controllers and destroys retired/stale resources',async()=>{
  const {h,viewer,models,shaders,controllers,primitives,setClock,setFocus}=await rendererHarness(),data=sceneData,base=data(0);
  h.seed(viewer,base);
  const first=h.showData(base,true);await turn();assert.equal(h.current,undefined);assert.equal(shaders[0].values.u_patchOpacity,0);
  models[0].ready=true;models[0].readyEvent.raise();await first;await turn();models[1].ready=true;models[1].readyEvent.raise();await turn();
  assert.equal(h.current.data,base);assert.ok(h.current.overview);assert.ok(controllers.every((c)=>c.active),'new controllers activate even while local mode was already active');
  const old=models[0],next=data(.08),second=h.showData(next,false);await turn();
  assert.equal(h.current.data,base,'parsed replacement has not displaced ready geometry');assert.equal(old.destroyed,false);
  models[2].ready=true;models[2].readyEvent.raise();await second;await turn();models[3].ready=true;models[3].readyEvent.raise();await turn();
  assert.equal(h.current.data,next);assert.ok(h.retiring);assert.equal(old.destroyed,false);assert.equal(primitives.length,4,'only current and retiring LOD pairs are resident');
  assert.ok(controllers.slice(0,3).every((c)=>c.destroyed));assert.ok(controllers.slice(3).every((c)=>c.active));
  setClock(1000);h.tickPatches();assert.equal(shaders[0].values.u_patchOpacity,.5);assert.equal(shaders[2].values.u_patchOpacity,.5);
  const interruptedAbort=new AbortController(),interrupted=h.showData(data(.10),false,interruptedAbort.signal);await turn();
  assert.equal(h.current.opacity,1);assert.equal(shaders[2].values.u_patchOpacity,1,'interrupted transition first finishes current opacity');
  interruptedAbort.abort();await assert.rejects(interrupted,{name:'AbortError'});assert.equal(h.current.data,next);assert.equal(shaders[2].values.u_patchOpacity,1,'aborted replacement leaves a fully visible current patch');
  setClock(2100);h.tickPatches();assert.equal(old.destroyed,true);assert.equal(models[1].destroyed,true);assert.equal(shaders[0].destroyed,true);assert.equal(h.retiring,null);assert.equal(primitives.length,2);
  setFocus(.08,.08);viewer.camera.positionCartographic.height=10000;h.evaluateCamera();assert.equal(h.active,false);
  viewer.camera.positionCartographic.height=500;h.evaluateCamera();assert.equal(h.active,true,'a remote loaded patch re-enters after zooming out beyond the selected study radius');
  const late=h.showData(data(.04),false);await turn();h.invalidate();await assert.rejects(late,{name:'AbortError'});
  assert.equal(primitives.length,0);assert.ok(models.every((m)=>m.destroyed));assert.ok(shaders.every((s)=>s.destroyed));assert.ok(controllers.every((c)=>c.destroyed));
  assert.ok(models.every((m)=>m.readyEvent.listeners.size===0&&m.errorEvent.listeners.size===0));
});

test('progressive renderer keeps preview until detail GPU readiness and attaches late overview once',async()=>{
  const {h,viewer,models,shaders,controllers,primitives,workers,element,setClock}=await rendererHarness();
  h.seed(viewer,sceneData(0));
  const preparation=h.prepare({id:'progressive',lat:0,lon:0,effects:{plume:true}});
  try {
    await turn();
    const worker=workers[0],{id,progressive}=worker.posted[0];
    assert.equal(progressive,true);
    const preview=sceneData(0,'preview');
    worker.emit({id,stage:'preview',result:preview});await turn();
    assert.equal(models.length,1);assert.equal(h.current,null);
    assert.equal(shaders[0].values.u_patchOpacity,0,'parsed preview cannot reveal incomplete GPU data');
    models[0].ready=true;models[0].readyEvent.raise();await turn();
    assert.equal(h.current.data,preview);
    assert.equal(element('#sceneDock').dataset.loadStage,'preview');
    assert.equal(controllers.length,1,'preview permits only atmosphere; no city activity or combustion');
    assert.equal(controllers[0].active,true);
    assert.equal(h.current.overviewStarted,undefined);

    const detail=sceneData(0,'detail');
    worker.emit({id,stage:'detail',result:detail});await turn();
    assert.equal(h.current.data,preview,'detail parse must retain the working preview');
    assert.equal(models[0].destroyed,false);
    assert.equal(shaders[1].values.u_patchOpacity,0);
    models[1].ready=true;models[1].readyEvent.raise();await turn();
    assert.equal(h.current.data,detail);
    assert.equal(h.retiring.data,preview);
    assert.equal(models[0].destroyed,false,'preview remains during complementary crossfade');
    assert.equal(controllers[0].destroyed,true);
    assert.equal(controllers.length,5,'ready detail enables atmosphere, city life, qualified campus effects and anchored evidence');
    assert.ok(controllers.slice(1).every(controller=>controller.active));
    assert.equal(models.length,2,'overview is not requested before its late worker stage');

    const overviewBuffer=new ArrayBuffer(12);
    worker.emit({id,stage:'complete',result:{overviewBuffer,compileStats:{planningPasses:1}}});
    await preparation;await turn();
    assert.equal(h.current.data,detail,'complete must enrich the current detail object without another close upload');
    assert.equal(detail.overviewBuffer,overviewBuffer);
    assert.equal(models.length,3);
    h.ensureOverview(h.current);h.ensureOverview(h.current);await turn();
    assert.equal(models.length,3,'repeated completion/LOD checks must not duplicate overview uploads');
    models[2].ready=true;models[2].readyEvent.raise();await turn();
    assert.equal(h.current.overview.model,models[2]);
    worker.emit({id,stage:'complete',result:{overviewBuffer:new ArrayBuffer(16)}});await turn();
    assert.equal(models.length,3,'a settled compiler ignores duplicate late worker messages');
    setClock(2100);h.tickPatches();
    assert.equal(models[0].destroyed,true);assert.equal(shaders[0].destroyed,true);
    assert.equal(primitives.length,2);assert.equal(h.retiring,null);
  } finally {
    h.destroy();await preparation;
    assert.ok(models.every(model=>model.destroyed));assert.ok(shaders.every(shader=>shader.destroyed));
    assert.ok(controllers.every(controller=>controller.destroyed));
  }
});

test('site change aborts progressive worker stages and frees stale model parses or GPU-ready waits',async(t)=>{
  for(const phase of ['parse','gpu']){
    const {h,viewer,models,shaders,controllers,primitives,workers,setParseGate}=await rendererHarness();
    h.seed(viewer,sceneData(0));
    const parsed=deferred();if(phase==='parse')setParseGate(parsed.promise);
    t.after(()=>{setParseGate(null);parsed.resolve();h.destroy();});
    const first=h.prepare({id:'obsolete-'+phase,lat:0,lon:0,effects:{}});
    await turn();const worker=workers[0],oldId=worker.posted[0].id;
    worker.emit({id:oldId,stage:'preview',result:sceneData(0,'preview')});await turn();
    assert.equal(models.length,1);assert.equal(h.current,null);
    if(phase==='gpu')assert.equal(models[0].readyEvent.listeners.size,1);
    const second=h.prepare({id:'fresh-'+phase,lat:0,lon:0,effects:{}});
    await first;await turn();
    assert.ok(worker.posted.some(message=>message.id===oldId&&message.cancel));
    setParseGate(null);parsed.resolve();await turn();
    assert.equal(models[0].destroyed,true);assert.equal(shaders[0].destroyed,true);
    assert.equal(models[0].readyEvent.listeners.size,0);assert.equal(models[0].errorEvent.listeners.size,0);
    assert.equal(primitives.length,0);
    worker.emit({id:oldId,stage:'detail',result:sceneData(.01,'detail')});
    worker.emit({id:oldId,stage:'complete',result:{overviewBuffer:new ArrayBuffer(4)}});
    models[0].ready=true;models[0].readyEvent.raise();await turn();
    assert.equal(models.length,1,'obsolete stages and readiness events cannot recreate models');
    assert.equal(h.current,null);assert.equal(controllers.length,0);
    const newId=worker.posted.find(message=>!message.cancel&&message.id!==oldId).id;
    const detail=sceneData(0,'detail');worker.emit({id:newId,stage:'detail',result:detail});await turn();
    models[1].ready=true;models[1].readyEvent.raise();await turn();
    worker.emit({id:newId,stage:'complete',result:{overviewBuffer:null}});await second;
    assert.equal(h.current.data,detail);assert.equal(primitives.length,1);
    h.destroy();
    assert.equal(primitives.length,0);assert.ok(models.every(model=>model.destroyed));
    assert.ok(shaders.every(shader=>shader.destroyed));assert.ok(controllers.every(controller=>controller.destroyed));
  }
});

test('failed detail upload leaves the preview active and camera ticks do not retry the broken buffer',async()=>{
  const {h,viewer,models,shaders,controllers,primitives,workers,warnings,setClock}=await rendererHarness();
  h.seed(viewer,sceneData(0));
  const preparation=h.prepare({id:'failed-detail',lat:0,lon:0,effects:{}});
  try {
    await turn();const worker=workers[0],{id}=worker.posted[0],preview=sceneData(0,'preview');
    worker.emit({id,stage:'preview',result:preview});await turn();
    models[0].ready=true;models[0].readyEvent.raise();await turn();
    assert.equal(h.current.data,preview);assert.equal(h.active,true);
    const detail=sceneData(0,'detail');
    worker.emit({id,stage:'detail',result:detail});await turn();
    worker.emit({id,stage:'complete',result:{overviewBuffer:null}});await preparation;
    assert.equal(models.length,2);assert.equal(h.current.data,preview);
    models[1].errorEvent.raise(new Error('detail GPU allocation failed'));await turn();
    assert.equal(models[1].destroyed,true);assert.equal(shaders[1].destroyed,true);
    assert.equal(h.uploading,null);assert.equal(warnings.length,1);
    for(let tick=1;tick<=6;tick++){
      setClock(tick*1100);h.evaluateCamera();h.tickPatches();await turn();
      assert.equal(h.current.data,preview);assert.equal(h.active,true);
      assert.equal(models[0].show,true);assert.equal(shaders[0].values.u_patchOpacity,1);
    }
    assert.equal(models.length,2,'automatic camera updates must not launch another upload of failed detail');
    assert.equal(primitives.length,1);assert.equal(controllers.length,1);
    assert.equal(controllers[0].active,true);assert.equal(controllers[0].destroyed,false);
  } finally {
    h.destroy();await preparation;
    assert.ok(models.every(model=>model.destroyed));assert.ok(shaders.every(shader=>shader.destroyed));
    assert.ok(controllers.every(controller=>controller.destroyed));
  }
});

test('approach warms GPU geometry without leaving globe view, then reuses it at the close threshold',async()=>{
  const {h,viewer,models,shaders,controllers,primitives}=await rendererHarness(),data=sceneData(0,'detail');
  h.seed(viewer,data,{active:false});
  try {
    viewer.camera.positionCartographic.height=12001;h.evaluateCamera();await turn();
    assert.equal(models.length,0,'above the warming ceiling there is no GPU upload');
    viewer.camera.positionCartographic.height=10000;h.evaluateCamera();await turn();
    assert.equal(models.length,1);assert.equal(h.active,false);
    assert.equal(shaders[0].values.u_patchOpacity,0,'warming is invisible while GPU data is incomplete');
    models[0].ready=true;models[0].readyEvent.raise();await turn();
    assert.equal(h.current.data,data);assert.equal(h.active,false);
    assert.equal(models[0].show,false,'a ready warm model stays hidden in globe mode');
    assert.ok(controllers.every(controller=>!controller.active),'warming cannot start local activity or atmosphere');
    viewer.camera.positionCartographic.height=5000;h.evaluateCamera();await turn();
    assert.equal(h.active,true);assert.equal(models[0].show,true);
    assert.equal(models.length,1,'entering close mode reuses the warm upload');
    assert.ok(controllers.every(controller=>controller.active));
    assert.equal(primitives.length,1);
  } finally {h.destroy();}
  assert.ok(models.every(model=>model.destroyed));assert.ok(shaders.every(shader=>shader.destroyed));
});

test('GPU warming respects disabled Auto and ignores distant camera targets',async(t)=>{
  for(const blockedBy of ['manual-auto-off','far-target']){
    const {h,viewer,models,primitives,setFocus}=await rendererHarness();
    t.after(()=>h.destroy());
    h.seed(viewer,sceneData(0,'detail'),{active:false,enabled:blockedBy!=='manual-auto-off'});
    if(blockedBy==='far-target')setFocus(1,1);
    for(const height of [10000,5000]){
      viewer.camera.positionCartographic.height=height;h.evaluateCamera();await turn();
      assert.equal(h.active,false,blockedBy);
      assert.equal(models.length,0,`${blockedBy} must not launch an upload at ${height}m`);
      assert.equal(primitives.length,0);
    }
  }
});
