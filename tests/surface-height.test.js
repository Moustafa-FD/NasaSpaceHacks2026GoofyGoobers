import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceHeightSampler} from '../apps/web/js/surface-height.js';
test('road heights match rendered sloping facets, including shared edges and the north axis',()=>{
  const ground={category:3,positions:[0,10,0,100,30,0,0,50,-100,100,20,-100],indices:[0,1,2,1,3,2]};
  const sample=createSurfaceHeightSampler([ground],()=>-100);
  assert.equal(sample(25,25),25);
  assert.equal(sample(50,50),40);
  assert.equal(sample(100,100),20);
  assert.equal(sample(75,75),30);
  assert.equal(sample(-1,0),-100);
});
test('water and empty holes never become elevated road terrain samples',()=>{
  const water={category:4,positions:[0,100,0,100,100,0,0,100,-100],indices:[0,1,2]};
  const sample=createSurfaceHeightSampler([water],(x,y)=>x+y);
  assert.equal(sample(5,10),15);
});
