import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapTransition,mapCrossfadeAlphas} from '../apps/web/js/map-transition.js';

test('translucent maps keep constant combined opacity without a midpoint brightness pulse',()=>{
  for(const opacity of [0,.2,.65,1])for(const mix of [0,.1,.5,.9,1]){
    const [back,front]=mapCrossfadeAlphas(opacity,mix);
    assert.ok(Number.isFinite(back)&&Number.isFinite(front));
    assert.ok(Math.abs(front+back*(1-front)-opacity)<1e-12);
    assert.ok(Math.abs(back*(1-front)-opacity*(1-mix))<1e-12);
    assert.ok(Math.abs(front-opacity*mix)<1e-12);
  }
});

const turn=()=>new Promise((resolve)=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
  let time=0,next=0,maxLive=0;const frames=new Map(),resources=[],calls=[],commits=[],live=new Set(),loads=new Map(),ready=new Map();
  const controller=createMapTransition({
    load:async(payload,signal)=>{calls.push(payload);await loads.get(payload)?.promise;const resource={key:payload,layers:[{alpha:0},{alpha:0}],signal,disposed:0};resources.push(resource);live.add(resource);maxLive=Math.max(maxLive,live.size);return resource;},
    whenReady:async(resource)=>{await ready.get(resource.key)?.promise;},
    setOpacity:(r,a)=>{assert.equal(r.disposed,0);r.layers.forEach((l)=>l.alpha=a);},
    dispose:(r)=>{assert.equal(r.disposed++,0,'each resource/pair is disposed once');live.delete(r);},
    onCommit:(r,payload,key)=>commits.push([r,payload,key]),durationMs:700,now:()=>time,
    requestFrame:(fn)=>{frames.set(++next,fn);return next;},cancelFrame:(id)=>frames.delete(id),
  });
  return {controller,frames,resources,calls,commits,live,loads,ready,get maxLive(){return maxLive;},
    step(ms){time+=ms;const batch=[...frames.values()];frames.clear();for(const f of batch)f();},
    async install(key){const p=controller.show(key,key);await turn();this.step(700);await p;return resources.at(-1);}};
}

test('ready comparison pairs remain visible until replacement readiness, then fade on wall-clock time',async()=>{
  const h=fixture(),a=await h.install('a'),gate=deferred();h.ready.set('b',gate);
  const pending=h.controller.show('b','b');await turn();const b=h.resources.at(-1);
  h.step(2000);assert.deepEqual(a.layers.map((l)=>l.alpha),[1,1]);assert.deepEqual(b.layers.map((l)=>l.alpha),[0,0]);assert.equal(h.commits.length,1);
  gate.resolve();await turn();assert.equal(h.commits.length,2);h.step(350);
  assert.deepEqual(a.layers.map((l)=>l.alpha),[1,1]);assert.deepEqual(b.layers.map((l)=>l.alpha),[.5,.5]);
  assert.equal(a.disposed,0);h.step(350);assert.equal(await pending,b);assert.equal(a.disposed,1);assert.deepEqual(b.layers.map((l)=>l.alpha),[1,1]);
  assert.equal(h.controller.state,'ready');assert.equal(h.frames.size,0);assert.equal(h.maxLive,2);h.controller.destroy();
});

test('the same pending or visible key never reloads, restarts a fade or resets opacity',async()=>{
  const h=fixture(),p=h.controller.show('a','a');assert.equal(h.controller.show('a','ignored'),p);await turn();h.step(350);
  assert.equal(h.controller.show('a','ignored-again'),p);h.step(350);const a=await p;
  assert.equal(await h.controller.show('a','ignored'),a);assert.deepEqual(h.calls,['a']);assert.equal(h.commits.length,1);assert.deepEqual(a.layers.map((l)=>l.alpha),[1,1]);h.controller.destroy();
});

test('rapid scrubbing loads only the latest queued target and disposes late cancelled work before another resource loads',async()=>{
  const h=fixture(),base=await h.install('base'),gate=deferred();h.loads.set('obsolete',gate);
  const obsolete=h.controller.show('obsolete','obsolete');await turn();const skipped=h.controller.show('skipped','skipped'),latest=h.controller.show('latest','latest');
  assert.equal(await obsolete,null);assert.equal(await skipped,null);assert.deepEqual(h.calls,['base','obsolete']);assert.equal(base.layers[0].alpha,1);
  gate.resolve();await turn();assert.deepEqual(h.calls,['base','obsolete','latest']);assert.equal(h.resources.find((r)=>r.key==='obsolete').disposed,1);
  h.step(700);assert.equal((await latest).key,'latest');assert.equal(h.maxLive,2);assert.equal(h.live.size,1);h.controller.destroy();
});

test('interrupting a fade promotes its ready incoming pair, never allocating a third map or flashing empty',async()=>{
  const h=fixture(),a=await h.install('a'),bJob=h.controller.show('b','b');await turn();h.step(350);
  const cJob=h.controller.show('c','c');assert.equal((await bJob).key,'b');assert.equal(a.disposed,1);
  const b=h.resources.find((r)=>r.key==='b');assert.deepEqual(b.layers.map((l)=>l.alpha),[1,1]);await turn();h.step(700);assert.equal((await cJob).key,'c');assert.equal(h.maxLive,2);h.controller.destroy();
});

test('readiness failure keeps the prior map; cancelling a readiness wait releases it without waiting for its old promise',async()=>{
  const h=fixture(),a=await h.install('a'),failure=deferred();h.ready.set('bad',failure);
  const bad=h.controller.show('bad','bad'),rejected=assert.rejects(bad,/missing source pixels/);await turn();failure.reject(new Error('missing source pixels'));await rejected;
  assert.equal(a.disposed,0);assert.equal(a.layers[0].alpha,1);assert.equal(h.controller.currentKey,'a');
  h.ready.set('stuck',deferred());const stale=h.controller.show('stuck','stuck');await turn();const fresh=h.controller.show('fresh','fresh');assert.equal(await stale,null);await turn();
  assert.equal(h.resources.find((r)=>r.key==='stuck').disposed,1);h.step(700);assert.equal((await fresh).key,'fresh');assert.equal(h.maxLive,2);h.controller.destroy();
});

test('clear/site reset and destroy cancel frames, settle pending callers and dispose stale arrivals exactly once',async()=>{
  const h=fixture();await h.install('a');const gate=deferred();h.loads.set('late',gate);
  const pending=h.controller.show('late','late');await turn();h.controller.clear();assert.equal(await pending,null);assert.equal(h.live.size,0);assert.equal(h.frames.size,0);
  gate.resolve();await turn();assert.equal(h.resources.find((r)=>r.key==='late').disposed,1);
  const fade=h.controller.show('b','b');await turn();h.controller.destroy();assert.equal(await fade,null);h.controller.destroy();assert.equal(h.frames.size,0);assert.equal(h.live.size,0);
  await assert.rejects(h.controller.show('c','c'),{name:'AbortError'});
});

test('a readiness hook is mandatory instead of silently treating provider construction as image readiness',()=>{
  assert.throws(()=>createMapTransition({load(){},setOpacity(){},dispose(){}}),/whenReady/);
});
