import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRoadSurface,resolveRoadWidth} from '../apps/web/js/road-mesh.js';

const road=(id,kind,points,width=6)=>({id,kind,points,width,widthSource:'osm:width'});
const orient=(a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
function covers(mesh,p){
  for(let i=0;i<mesh.indices.length;i+=3){
    const [a,b,c]=mesh.indices.slice(i,i+3).map((n)=>[mesh.positions[n*3],-mesh.positions[n*3+2]]),sign=orient(a,b,c);
    if(Math.abs(sign)>1e-9&&[orient(a,b,p),orient(b,c,p),orient(c,a,p)].every((v)=>v*Math.sign(sign)>=-1e-8))return true;
  }return false;
}

test('continuous ribbons cover bends and a shared T junction without separated rectangular ends',()=>{
  const data={roads:[road('way/1','residential',[[-70,0],[0,0],[35,35],[35,70]]),road('way/2','service',[[0,0],[0,-50]],4)]};
  const result=buildRoadSurface(data,()=>14),asphalt=result.groups.find((g)=>g.name==='road-asphalt');
  for(const p of [[0,0],[-1,-1],[1,-1],[35,35],[34,36],[36,34]])assert.ok(covers(asphalt,p),'joined surface should cover '+p);
  assert.equal(covers(asphalt,[60,-40]),false,'no road should appear away from source geometry');
  assert.ok(result.groups.some((g)=>g.name==='road-sidewalk'));
  assert.ok(result.groups.some((g)=>g.name==='road-curb'));
  assert.equal(result.stats.renderedRoads,2);
});

test('traffic samples and explicit asphalt centre vertices follow the supplied terrain surface exactly',()=>{
  const heightAt=(x,y)=>40+x*0.04+Math.abs(y)*0.5;
  const result=buildRoadSurface({roads:[road('way/curve','secondary',[[0,0],[30,4],[50,20],[70,40]],9)]},heightAt);
  const asphalt=result.groups.find((g)=>g.name==='road-asphalt'),path=result.paths[0];
  for(let i=0;i<path.points.length;i++){
    const [x,y,h]=path.points[i];assert.equal(h,heightAt(x,y)+0.28);
    assert.ok(asphalt.positions.some((v,k)=>k%3===0&&Math.abs(v-x)<1e-8&&Math.abs(asphalt.positions[k+1]-h)<1e-8&&Math.abs(asphalt.positions[k+2]+y)<1e-8));
    if(i)assert.ok(Math.hypot(x-path.points[i-1][0],y-path.points[i-1][1])<=12.000001);
  }
  for(const mesh of result.groups){
    assert.equal(mesh.normals.length,mesh.positions.length);
    assert.ok(mesh.positions.every(Number.isFinite));assert.ok(mesh.normals.every(Number.isFinite));
    for(let i=1;i<mesh.normals.length;i+=3)assert.ok(mesh.normals[i]>0.5);
    assert.ok(mesh.indices.every((i)=>i>=0&&i<mesh.positions.length/3));assert.equal(mesh.category,0);
  }
});

test('mapped service drives and all minor path classes remain source-identifiable and retain their narrow widths',()=>{
  const kinds=['service','footway','path','steps','cycleway','track','bridleway'];
  const roads=kinds.map((kind,i)=>road('way/'+i,kind,[[0,i*10],[40,i*10]],i?1.3:4));
  roads.push(road('way/future','proposed',[[0,80],[40,80]],8),road('way/site','construction',[[0,90],[40,90]],8));
  const result=buildRoadSurface({roads},()=>0);
  assert.deepEqual(result.paths.map((p)=>p.id),roads.slice(0,7).map((r)=>r.id));
  assert.deepEqual(result.paths.map((p)=>p.width),roads.slice(0,7).map((r)=>r.width));
  assert.ok(result.paths.every((p)=>p.widthSource==='osm:width'));
  assert.equal(result.stats.minorPaths,6);assert.equal(result.stats.skippedPlannedRoads,2);
  const paths=result.groups.find((g)=>g.name==='road-path');assert.ok(covers(paths,[20,10]));assert.equal(covers(paths,[20,15]),false);
  assert.equal(result.groups.some((g)=>/markings/.test(g.name)),false,'narrow access roads and paths must not acquire highway paint');
});

test('generation is deterministic, respects explicit lifts, and batches materials rather than creating one mesh per way',()=>{
  const data={roads:[road('way/a','primary',[[0,0],[80,0],[110,10]],10),road('way/b','residential',[[30,-30],[30,30]],6)]};
  const options={asphaltLiftM:0.42},a=buildRoadSurface(data,()=>7,options),b=buildRoadSurface(data,()=>7,options);
  assert.deepEqual(a,b);assert.ok(a.groups.length<=6);assert.equal(a.paths[0].points[0][2],7.42);
  assert.ok(a.groups.some((g)=>g.name==='road-center-markings'));assert.ok(a.groups.some((g)=>g.name==='road-edge-markings'));
  assert.ok(a.groups.find((g)=>g.name==='road-center-markings').positions.every((v,i)=>i%3!==1||Math.abs(v-7.445)<1e-8));
});

test('empty or unknown ground produces no invented roads and overview remains bounded and source based',()=>{
  assert.deepEqual(buildRoadSurface({roads:[]},()=>0).groups,[]);
  const data={roads:[road('way/known','service',[[0,0],[100,0]],4),road('way/invalid','service',[[0,1]],4)]};
  const missing=buildRoadSurface(data,()=>null);assert.equal(missing.paths.length,0);assert.equal(missing.groups.length,0);
  const close=buildRoadSurface(data,()=>0),overview=buildRoadSurface(data,()=>0,{detail:'overview'});
  assert.ok(overview.stats.triangles<close.stats.triangles);assert.equal(overview.paths[0].id,'way/known');
  assert.equal(overview.stats.invalidRoads,1);assert.equal(overview.paths[0].points.at(-1)[0],100);
});

test('explicit mapped widths win over lanes while lane-based widths are labelled estimates',()=>{
  assert.deepEqual(resolveRoadWidth({kind:'primary',width:10,widthSource:'osm:width'},{lanes:'4'}),{width:10,widthSource:'osm:width'});
  assert.deepEqual(resolveRoadWidth({kind:'service',width:4},{width:'12 ft',lanes:'2'}),{width:3.6576000000000004,widthSource:'osm:width'});
  const estimated=resolveRoadWidth({kind:'residential',width:6,widthSource:'illustrative road-class default'},{lanes:'1'});
  assert.equal(estimated.width,3.6);assert.match(estimated.widthSource,/estimate from OSM lanes/);
  const urban={roadTags:[{id:'way/100',tags:{lanes:'1',sidewalk:'no'}}]};
  const result=buildRoadSurface({roads:[road('way/100/1','residential',[[0,0],[30,0]],6)]},()=>0,{urban});
  assert.equal(result.paths[0].width,6,'explicit cached OSM width must survive supplemental lane counts');
  assert.equal(result.groups.some((g)=>g.name==='road-sidewalk'),false,'mapped sidewalk=no must be respected');
});

test('zebra paint requires a nearby mapped crossing and respects explicitly unmarked crossings',()=>{
  const data={roads:[road('way/4','residential',[[-40,0],[40,0]],6)]};
  const plain=buildRoadSurface(data,()=>0);assert.equal(plain.stats.paintedCrossings,0);
  const urban={crossings:[{id:'node/1',x:0,y:0,tags:{crossing:'marked'}},{id:'node/2',x:15,y:0,tags:{crossing:'unmarked'}},{id:'node/3',x:500,y:500,tags:{}}]};
  const marked=buildRoadSurface(data,()=>0,{urban});assert.equal(marked.stats.mappedCrossings,3);assert.equal(marked.stats.paintedCrossings,1);
  assert.ok(marked.groups.some((g)=>g.name==='road-edge-markings'));
  assert.equal(buildRoadSurface(data,()=>0,{urban,detail:'overview'}).stats.paintedCrossings,0);
});
