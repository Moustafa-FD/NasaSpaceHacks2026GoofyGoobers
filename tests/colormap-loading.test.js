import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('colormap requests share pending work, cache success and allow retries after invalid responses',async()=>{
  const source=await readFile(new URL('../apps/web/js/layers.js',import.meta.url),'utf8');
  let calls=0,release,invalid=false;
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,fetch:async()=>{calls++;await new Promise(resolve=>release=resolve);return {ok:true,text:async()=>''};},DOMParser:class{parseFromString(){return {getElementsByTagName:()=>invalid?[]:[{getAttribute:key=>({value:'[0,2]',rgb:'0,255,0'})[key]??null}]};}}});
  vm.runInContext(source,context);
  const first=vm.runInContext("loadLut('shared')",context),second=vm.runInContext("loadLut('shared')",context);
  assert.equal(calls,1);release();
  const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(a.get(0x00ff00),1);
  assert.equal(await vm.runInContext("loadLut('shared')",context),a);assert.equal(calls,1);
  invalid=true;const bad=vm.runInContext("loadLut('retry')",context);release();await assert.rejects(bad,/no decodable values/);
  invalid=false;const retry=vm.runInContext("loadLut('retry')",context);release();assert.equal((await retry).size,1);assert.equal(calls,3);
});
