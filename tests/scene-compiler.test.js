import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createSceneCompiler} from '../apps/web/js/scene-compiler.js';

class StubWorker {
  posted = [];
  terminated = 0;
  postError = null;
  postMessage(message) {
    if (this.postError) throw this.postError;
    this.posted.push(message);
  }
  emit(message) { this.onmessage?.({data: message}); }
  fail(message = 'worker crashed') { this.onerror?.({message}); }
  terminate() { this.terminated++; }
}
const fixture = () => {
  const workers = [];
  const compiler = createSceneCompiler(() => { const worker = new StubWorker(); workers.push(worker); return worker; });
  return {compiler, workers};
};
const complete = (worker, id, detail = {}, final = {}) => {
  worker.emit({id, stage: 'detail', result: detail});
  worker.emit({id, stage: 'complete', result: final});
};

test('preview and detail progress do not resolve early; completion enriches the exact delivered detail object', async () => {
  const {compiler, workers} = fixture(), progress = [];
  const input = {snapshot: {siteId: 'test'}, options: {maxTrees: 100}};
  const job = compiler.compile(input, {onProgress: value => progress.push(value)});
  const worker = workers[0], {id} = worker.posted[0];
  assert.equal(worker.posted[0].progressive, true);
  assert.equal(worker.posted[0].snapshot, input.snapshot);
  let resolved = false;
  void job.then(() => { resolved = true; });
  const preview = {buffer: new ArrayBuffer(4), preview: true};
  const detail = {buffer: new ArrayBuffer(8), roadPaths: [{id: 'source-way'}]};
  worker.emit({id, stage: 'preview', result: preview});
  await Promise.resolve();
  assert.equal(resolved, false);
  worker.emit({id, stage: 'detail', result: detail});
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(progress, [preview, detail]);
  const overviewBuffer = new ArrayBuffer(12), trafficGraph = {arcs: [1, 2]};
  worker.emit({id, stage: 'complete', result: {overviewBuffer, trafficGraph}});
  assert.equal(await job, detail);
  assert.equal(progress[1].overviewBuffer, overviewBuffer);
  assert.equal(progress[1].trafficGraph, trafficGraph);
  assert.equal(progress.length, 2);
  compiler.destroy();
});

test('without a progress callback the request skips preview work but still merges staged detail', async () => {
  const {compiler, workers} = fixture();
  const job = compiler.compile({snapshot: {siteId: 'no-preview'}});
  const worker = workers[0], {id} = worker.posted[0], detail = {buffer: new ArrayBuffer(4)};
  assert.equal(worker.posted[0].progressive, false);
  complete(worker, id, detail, {stats: {buildings: 12}});
  assert.equal(await job, detail);
  assert.deepEqual(detail.stats, {buildings: 12});
  compiler.destroy();
});

test('abort sends worker cancellation, removes its listener and ignores every late stage', async () => {
  const {compiler, workers} = fixture(), controller = new AbortController(), progress = [];
  const job = compiler.compile({}, {signal: controller.signal, onProgress: value => progress.push(value)});
  const rejected = assert.rejects(job, {name: 'AbortError'});
  const worker = workers[0], {id} = worker.posted[0], detail = {initial: true};
  worker.emit({id, stage: 'detail', result: detail});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await rejected;
  assert.deepEqual(worker.posted[1], {id, cancel: true});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  worker.emit({id, stage: 'preview', result: {late: true}});
  worker.emit({id, stage: 'detail', result: {late: true}});
  worker.emit({id, stage: 'complete', result: {late: true}});
  assert.equal(progress.length, 1);
  assert.deepEqual(detail, {initial: true});
  const next = compiler.compile({}), nextId = worker.posted.at(-1).id;
  assert.notEqual(nextId, id);
  complete(worker, nextId, {fresh: true});
  assert.deepEqual(await next, {fresh: true});
  compiler.destroy();
});

test('a pre-aborted job never creates a worker; destroy rejects all pending work and releases listeners', async () => {
  const {compiler, workers} = fixture(), aborted = new AbortController();
  aborted.abort();
  await assert.rejects(compiler.compile({}, {signal: aborted.signal}), {name: 'AbortError'});
  assert.equal(workers.length, 0);
  const controller = new AbortController();
  const first = assert.rejects(compiler.compile({}, {signal: controller.signal}), {name: 'AbortError'});
  const second = assert.rejects(compiler.compile({}), {name: 'AbortError'});
  compiler.destroy();
  await Promise.all([first, second]);
  assert.equal(workers[0].terminated, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a worker crash rejects all its pending jobs, cleans listeners and creates a fresh worker next time', async () => {
  const {compiler, workers} = fixture(), controller = new AbortController();
  const first = assert.rejects(compiler.compile({}, {signal: controller.signal}), /broken transport/);
  const second = assert.rejects(compiler.compile({}), /broken transport/);
  workers[0].fail('broken transport');
  await Promise.all([first, second]);
  assert.equal(workers[0].terminated, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const next = compiler.compile({}), worker = workers[1], {id} = worker.posted[0];
  complete(worker, id, {fresh: true});
  assert.deepEqual(await next, {fresh: true});
  compiler.destroy();
});

test('late errors from a terminated worker cannot terminate a replacement or reject its job', async () => {
  const {compiler, workers} = fixture();
  const first = assert.rejects(compiler.compile({}), /first failure/);
  const oldWorker = workers[0];
  oldWorker.fail('first failure');
  await first;
  const next = compiler.compile({});
  const observed = next.then(value => ({value}), error => ({error}));
  const currentWorker = workers[1], {id} = currentWorker.posted[0];
  try {
    assert.doesNotThrow(() => oldWorker.fail('obsolete error'));
    assert.equal(currentWorker.terminated, 0);
    complete(currentWorker, id, {fresh: true});
    assert.deepEqual(await observed, {value: {fresh: true}});
  } finally { compiler.destroy(); }
});

test('factory and postMessage exceptions reject and detach abort listeners without leaving stale jobs', async () => {
  const worker = new StubWorker(), controller = new AbortController();
  let calls = 0;
  const compiler = createSceneCompiler(() => { if (++calls === 1) throw new Error('factory failure'); return worker; });
  await assert.rejects(compiler.compile({}, {signal: controller.signal}), /factory failure/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  worker.postError = new Error('clone failure');
  await assert.rejects(compiler.compile({}, {signal: controller.signal}), /clone failure/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  worker.postError = null;
  const next = compiler.compile({}), {id} = worker.posted[0];
  complete(worker, id, {fresh: true});
  assert.deepEqual(await next, {fresh: true});
  compiler.destroy();
});

test('job errors and missing detail reject cleanly without corrupting other pending jobs', async () => {
  const {compiler, workers} = fixture(), controller = new AbortController();
  const first = assert.rejects(compiler.compile({}, {signal: controller.signal}), /invalid source/);
  const worker = workers[0], firstId = worker.posted[0].id;
  const second = compiler.compile({}), secondId = worker.posted.at(-1).id;
  worker.emit({id: firstId, error: 'invalid source'});
  await first;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  complete(worker, secondId, {valid: true});
  assert.deepEqual(await second, {valid: true});
  const missing = assert.rejects(compiler.compile({}), /detail is missing/);
  worker.emit({id: worker.posted.at(-1).id, stage: 'complete', result: {overview: true}});
  await missing;
  compiler.destroy();
});

test('throwing progress callbacks reject and cancel their own job without breaking unrelated compilation', async () => {
  for (const stage of ['preview', 'detail']) {
    const {compiler, workers} = fixture(), controller = new AbortController();
    const job = compiler.compile({}, {signal: controller.signal, onProgress: () => { throw new Error(`${stage} callback failed`); }});
    const observed = job.then(value => ({value}), error => ({error}));
    const worker = workers[0], {id} = worker.posted[0];
    const next = compiler.compile({}), nextId = worker.posted.at(-1).id;
    const observedNext = next.then(value => ({value}), error => ({error}));
    try {
      assert.doesNotThrow(() => worker.emit({id, stage, result: {partial: true}}));
      const outcome = await observed;
      assert.match(outcome.error?.message || '', new RegExp(`${stage} callback failed`));
      assert.ok(worker.posted.some(message => message.id === id && message.cancel));
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      complete(worker, nextId, {unrelated: true});
      assert.deepEqual(await observedNext, {value: {unrelated: true}});
    } finally { compiler.destroy(); }
  }
});
