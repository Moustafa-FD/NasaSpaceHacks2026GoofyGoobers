import test from 'node:test';
import assert from 'node:assert/strict';
import {trackImageryProvider} from '../apps/web/js/imagery-readiness.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const empty={pending:0,completed:0,failed:0,requested:0,revision:0};

test('scheduler-deferred requests return undefined unchanged and preserve receiver and request arguments',()=>{
  const request={throttle:true},calls=[],provider={requestImage(...args){assert.equal(this,provider);calls.push(args);return undefined;}};
  const tracker=trackImageryProvider(provider);
  assert.equal(provider.requestImage(4,5,6,request),undefined);assert.deepEqual(calls,[[4,5,6,request]]);
  assert.equal(calls[0][3],request);assert.deepEqual(tracker.snapshot,empty);
});

test('successful scheduled promises expose pending work and only count a completed nonnull image on settlement',async()=>{
  const work=deferred(),image={width:256,height:256},provider={requestImage:()=>work.promise},tracker=trackImageryProvider(provider);
  const pending=provider.requestImage(1,2,3);
  assert.deepEqual(tracker.snapshot,{pending:1,completed:0,failed:0,requested:1,revision:1});
  work.resolve(image);assert.equal(await pending,image);
  assert.deepEqual(tracker.snapshot,{pending:0,completed:1,failed:0,requested:1,revision:2});
});

test('rejected and synchronously thrown provider errors retain their identity, increment failure and release pending state',async()=>{
  const error=new Error('source tile unavailable'),work=deferred(),provider={requestImage:()=>work.promise},tracker=trackImageryProvider(provider);
  const pending=provider.requestImage(),rejected=assert.rejects(pending,e=>e===error);work.reject(error);await rejected;
  assert.deepEqual(tracker.snapshot,{pending:0,completed:0,failed:1,requested:1,revision:2});
  const broken={requestImage(){throw error;}},sync=trackImageryProvider(broken);
  assert.throws(()=>broken.requestImage(),e=>e===error);assert.deepEqual(sync.snapshot,{pending:0,completed:0,failed:1,requested:1,revision:2});
});

test('empty fulfilled tiles settle without falsely marking missing imagery ready',async()=>{
  const replies=[Promise.resolve(null),Promise.resolve(undefined),null],provider={requestImage:()=>replies.shift()},tracker=trackImageryProvider(provider);
  assert.equal(await provider.requestImage(),null);assert.equal(await provider.requestImage(),undefined);assert.equal(provider.requestImage(),null);
  assert.deepEqual(tracker.snapshot,{pending:0,completed:0,failed:0,requested:3,revision:6});
});

test('out-of-order concurrent requests maintain independent per-provider counts and changing readiness revisions',async()=>{
  const tasks=[deferred(),deferred(),deferred()];let next=0;
  const a={requestImage:()=>tasks[next++].promise},b={requestImage:()=>({width:256})},ta=trackImageryProvider(a),tb=trackImageryProvider(b);
  const all=[a.requestImage(),a.requestImage(),a.requestImage()];assert.equal(ta.snapshot.pending,3);assert.equal(ta.snapshot.revision,3);
  b.requestImage();assert.equal(tb.snapshot.completed,1);assert.equal(ta.snapshot.completed,0);
  tasks[1].resolve({id:'second'});await all[1];assert.equal(ta.snapshot.pending,2);assert.equal(ta.snapshot.revision,4);
  const failure=assert.rejects(all[0],/failed/);tasks[0].reject(new Error('failed'));await failure;
  tasks[2].resolve({id:'third'});await all[2];
  assert.deepEqual(ta.snapshot,{pending:0,completed:2,failed:1,requested:3,revision:6});
});

test('tracking is idempotent and snapshots are immutable copies rather than writable counters',()=>{
  const image={width:256},provider={requestImage:()=>image},first=trackImageryProvider(provider),wrapped=provider.requestImage,before=first.snapshot;
  assert.equal(trackImageryProvider(provider),first);assert.equal(provider.requestImage,wrapped);
  assert.throws(()=>{before.completed=99;},TypeError);assert.throws(()=>{first.snapshot={};},TypeError);
  assert.equal(provider.requestImage(),image);assert.deepEqual(before,empty);
  assert.deepEqual(first.snapshot,{pending:0,completed:1,failed:0,requested:1,revision:2});
});

test('thenable results settle normally and invalid providers fail clearly without starting timers',async()=>{
  const image={width:256},provider={requestImage:()=>({then(resolve){resolve(image);}})},tracker=trackImageryProvider(provider);
  assert.equal(await provider.requestImage(),image);assert.equal(tracker.snapshot.completed,1);assert.equal(tracker.snapshot.pending,0);
  for(const provider of [null,{}, {requestImage:3}])assert.throws(()=>trackImageryProvider(provider),/requestImage/);
});
