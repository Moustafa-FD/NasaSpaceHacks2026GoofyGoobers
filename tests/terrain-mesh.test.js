import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrainSurface, triangulateWaterPolygon, createTerrainColorSampler } from '../apps/web/js/terrain-mesh.js';

const lake = { id: 'water/lake', kind: 'water', polygon: [[-80,-60],[80,-60],[80,-10],[0,-10],[0,80],[-80,80]], holes: [[[-50,0],[-20,0],[-20,30],[-50,30]]] };
const data = { siteId: 'terrain-test', radiusM: 200, areas: [lake] };
const landscape = { groundKindAt: (x) => x<0?'forest':'farmland' };
const heightAt = (x,y) => 40+x*0.01+y*0.02;
const orient = (a,b,p) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
function triangles(mesh) {
  const result=[];
  for(let i=0;i<mesh.indices.length;i+=3) result.push(mesh.indices.slice(i,i+3).map((k)=>[mesh.positions[k*3],-mesh.positions[k*3+2]]));
  return result;
}
function covers(mesh, point) {return triangles(mesh).some(([a,b,c])=>orient(a,b,point)>=-1e-8&&orient(b,c,point)>=-1e-8&&orient(c,a,point)>=-1e-8);}
function area(mesh) {return triangles(mesh).reduce((sum,[a,b,c])=>sum+Math.abs(orient(a,b,c))/2,0);}

test('mapped concave water follows its shoreline and preserves islands rather than filling its bounding box', () => {
  const result=buildTerrainSurface(data,landscape,heightAt,{spacingM:80});
  const water=result.groups.find((g)=>g.category===4),ground=result.groups.find((g)=>g.category===3);
  assert.ok(covers(water,[-60,50]));
  assert.equal(covers(water,[-35,15]),false,'island hole must remain dry');
  assert.equal(covers(water,[40,30]),false,'concave inlet bounding-box corner must remain dry');
  assert.equal(covers(ground,[-60,50]),false,'ground must be cut out beneath mapped water');
  assert.ok(covers(ground,[-35,15]),'island ground must remain');
  assert.ok(covers(ground,[40,30]),'land inside concave void must remain');
  assert.ok(Math.abs(area(water)-14300)<1e-6);
  assert.ok(Math.abs(area(ground)+area(water)-160000)<1e-5,'clipping must conserve total covered area without gaps or overlaps');
});

test('water triangulation rejects invalid outer geometry instead of converting a hole into a lake', () => {
  const result=triangulateWaterPolygon({polygon:[[0,0],[10,0]],holes:[[[0,0],[10,0],[10,10],[0,10]]]});
  assert.equal(result.triangles.length,0);
});

test('terrain colors blend continuously across land-use boundaries and are already linear RGBA', () => {
  const sample=createTerrainColorSampler(data,landscape,{colorSpacingM:100,blendM:50});
  const left=sample(-0.00001,0),right=sample(0.00001,0);
  assert.ok(left.every((v,i)=>Math.abs(v-right[i])<1e-6));
  assert.ok(Math.abs(sample(-120,0)[0]-sample(120,0)[0])>0.01);
  assert.equal(left[3],1);
  assert.ok(left.slice(0,3).every((v)=>v>0&&v<0.5));
});

test('shared terrain positions have identical colors, upward facet normals and deterministic generation', () => {
  const a=buildTerrainSurface(data,landscape,heightAt,{spacingM:80}),b=buildTerrainSurface(data,landscape,heightAt,{spacingM:80});
  assert.deepEqual(a,b);
  const ground=a.groups.find((g)=>g.category===3),seen=new Map();
  for(let i=0;i<ground.positions.length/3;i++){
    const key=ground.positions.slice(i*3,i*3+3).map((v)=>v.toFixed(6)).join(',');
    const color=ground.colors.slice(i*4,i*4+4);
    if(seen.has(key))assert.ok(color.every((v,k)=>Math.abs(v-seen.get(key)[k])<1e-6));
    else seen.set(key,color);
    assert.ok(ground.normals[i*3+1]>0.99);
  }
});

test('default 6.6km ground stays within a useful mesh budget and has irregular interior vertices', () => {
  const result=buildTerrainSurface({siteId:'budget',radiusM:3300,areas:[]},{groundKindAt:()=> 'grass'},()=>0);
  assert.equal(result.stats.baseTriangles,7200);
  assert.equal(result.stats.groundTriangles,7200);
  assert.equal(result.groups.length,1);
  const ground=result.groups[0];
  assert.ok(ground.positions.some((v,i)=>i%3===0&&Math.abs(v)<3200&&Math.abs((v+3300)/110-Math.round((v+3300)/110))>0.01));
  assert.ok(ground.positions.every(Number.isFinite));
  assert.ok(ground.colors.every(Number.isFinite));
});
