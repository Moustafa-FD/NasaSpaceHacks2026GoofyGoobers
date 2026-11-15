import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRecreationDetail,recreationSport} from '../apps/web/js/recreation-detail.js';
const rectangle=(x,y,w,d)=>[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
const snapshot=(extra={})=>({schemaVersion:1,radiusM:3300,center:{lat:35,lon:-90},buildings:[],roads:[],areas:[],...extra});
const supplement=(features)=>({schemaVersion:1,status:'ready',source:{name:'OpenStreetMap',license:'ODbL-1.0'},features});
const feature=(id,kind,x,y,w,d,tags={})=>({id,kind,polygon:rectangle(x,y,w,d),tags});

test('sport details require explicit source sport tags and retain ambiguous/missing classifications',()=>{
  assert.equal(recreationSport({tags:{sport:'soccer;american_football'}}),'soccer');
  assert.equal(recreationSport({tags:{sport:'american_football'}}),'american_football');
  assert.equal(recreationSport({tags:{sport:'football'}}),null);assert.equal(recreationSport({tags:{}}),null);
  assert.equal(recreationSport({tags:{sport:'skateboard'}}),null);
});

test('mapped sport/play/shelter features generate varied recognizable geometry in one finite color batch',()=>{
  const roof=feature('mapped-pavilion','pavilion',0,115,12,10,{amenity:'shelter',building:'roof',shelter_type:'picnic_shelter'}),community=feature('community','community',190,115,24,18,{amenity:'community_centre',building:'yes'});
  const doc=snapshot({buildings:[{id:roof.id,polygon:roof.polygon},{id:community.id,polygon:community.polygon}]});
  const recreation=supplement([feature('tennis','pitch',-120,0,16,32,{sport:'tennis'}),feature('basketball','pitch',-40,0,18,34,{sport:'basketball'}),feature('soccer','pitch',65,0,50,82,{sport:'soccer'}),feature('baseball','pitch',180,0,70,72,{sport:'baseball'}),feature('play','playground',-120,115,32,32),roof,community,{id:'bench',kind:'bench',x:45,y:115,tags:{}},{id:'table',kind:'picnic_table',x:75,y:115,tags:{}},{id:'exercise',kind:'fitness',x:110,y:115,tags:{}}]);
  const options={recreation,buildings:[{id:'community',x:190,y:115,width:24,depth:18,height:8,angle:0}]},close=buildRecreationDetail(doc,(x,y)=>100+x*.01+y*.015,options),far=buildRecreationDetail(doc,(x,y)=>100+x*.01+y*.015,{...options,detail:'overview'});
  assert.equal(close.groups.length,1);assert.equal(close.stats.drawCalls,1);assert.equal(close.stats.sportsFields,4);assert.equal(close.stats.playgrounds,1);
  assert.ok(close.stats.pavilions===1&&close.stats.picnicTables>=2&&close.stats.benches>=1&&close.stats.fitness===1&&close.stats.communityBuildings===1);
  assert.deepEqual(close.replacementBuildingIds,['mapped-pavilion']);
  const kinds=new Set(close.placements.map(p=>p.kind));for(const kind of ['tennis-net','basketball-hoop','soccer-goal','baseball-backstop','play-equipment','pavilion','fitness-bars'])assert.ok(kinds.has(kind),kind);
  const g=close.groups[0];assert.equal(g.color,'#ffffff');assert.equal(g.category,0);assert.equal(g.positions.length,g.normals.length);assert.equal(g.colors.length,g.positions.length/3*4);assert.equal(g.indices.length/3,close.stats.triangles);
  assert.ok(g.positions.every(Number.isFinite));assert.ok(g.colors.every(v=>v>=0&&v<=1));assert.ok(g.positions.filter((v,i)=>i%3===1).every(h=>h>95));
  for(let i=0;i<g.normals.length;i+=3)assert.ok(Math.abs(Math.hypot(...g.normals.slice(i,i+3))-1)<1e-6);
  assert.ok(far.stats.triangles<close.stats.triangles*.8);assert.equal(far.stats.sportsFields,4);assert.ok(close.focus&&['pitch','play-equipment','pavilion','fitness-bars'].includes(close.focus.kind));
  assert.deepEqual(buildRecreationDetail(doc,(x,y)=>100+x*.01+y*.015,options),close,'stable source IDs yield deterministic placements and colors');
});

function inBox(point,b){return point[0]>b[0]&&point[0]<b[2]&&point[1]>b[1]&&point[1]<b[3];}
function triangleIntersectsBox(triangle,b){
  const rectangle=[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]],axes=[[1,0],[0,1],...triangle.map((a,i)=>{const c=triangle[(i+1)%3];return [a[1]-c[1],c[0]-a[0]];})];
  for(const [x,y]of axes){const a=triangle.map(p=>p[0]*x+p[1]*y),c=rectangle.map(p=>p[0]*x+p[1]*y);if(Math.max(...a)<=Math.min(...c)+1e-7||Math.max(...c)<=Math.min(...a)+1e-7)return false;}return true;
}
test('rendered field triangles preserve mapped holes, small enclosed water, buildings and full road corridors',()=>{
  const hole=rectangle(-75,70,18,18),pond=rectangle(0,0,8,8),building=rectangle(55,-45,12,16),doc=snapshot({buildings:[{id:'house',polygon:building}],areas:[{id:'pond',kind:'water',polygon:pond}],roads:[{id:'road',kind:'residential',width:8,widthSource:'osm:width',points:[[-180,45],[180,45]]}]});
  const f={...feature('unknown-sport','pitch',0,0,260,260),holes:[hole]},result=buildRecreationDetail(doc,()=>75,{recreation:supplement([f])});
  assert.ok(result.stats.triangles>10);const obstacles=[[-84,61,-66,79],[-4,-4,4,4],[49,-53,61,-37],[-181,40.7,181,49.3]],g=result.groups[0];
  for(let i=0;i<g.indices.length;i+=3){const t=g.indices.slice(i,i+3).map(j=>[g.positions[j*3],-g.positions[j*3+2]]);for(const b of obstacles)assert.equal(triangleIntersectsBox(t,b),false,'surface cannot bridge an excluded region');}
  assert.equal(result.placements.some(p=>/goal|net|hoop/.test(p.kind)),false,'an unknown sport receives no invented equipment');
});

test('generic park furniture is bounded inside mapped park land and avoids holes, water, houses and streets',()=>{
  const park={id:'mapped-park',kind:'park',polygon:rectangle(0,0,360,360),holes:[rectangle(0,0,80,80)]},water={id:'water',kind:'water',polygon:rectangle(115,-110,30,35)},house={id:'house',polygon:rectangle(-110,100,22,24)};
  const result=buildRecreationDetail(snapshot({areas:[park,water],buildings:[house],roads:[{id:'road',kind:'residential',width:8,points:[[-180,-60],[180,-60]]}]}),()=>50,{maxProps:12});
  assert.ok(result.stats.benches+result.stats.picnicTables>0);assert.ok(result.stats.props<=12);
  for(const p of result.placements){assert.equal(p.source,'illustrative-park');assert.equal(p.sourceId,'mapped-park');assert.equal(p.name,undefined);for(const v of p.footprint){assert.ok(inBox(v,[-180,-180,180,180]));assert.equal(inBox(v,[-40,-40,40,40]),false);assert.equal(inBox(v,[100,-127.5,130,-92.5]),false);assert.equal(inBox(v,[-121,88,-99,112]),false);assert.equal(inBox(v,[-180,-64.3,180,-55.7]),false);}}
});

test('only successfully rendered mapped pavilions replace generic building bodies',()=>{
  const f=feature('building/roof','pavilion',0,0,12,10,{amenity:'shelter',building:'roof'}),doc=snapshot({buildings:[{id:f.id,polygon:f.polygon}]});
  assert.deepEqual(buildRecreationDetail(doc,()=>50,{recreation:supplement([f])}).replacementBuildingIds,[f.id]);
  const road={id:'crossing-road',kind:'residential',width:8,points:[[-20,0],[20,0]]};
  for(const result of [buildRecreationDetail({...doc,roads:[road]},()=>50,{recreation:supplement([f])}),buildRecreationDetail(doc,()=>50,{recreation:supplement([f]),maxTriangles:40}),buildRecreationDetail(doc,()=>null,{recreation:supplement([f])}),buildRecreationDetail(doc,()=>50,{recreation:supplement([{...f,tags:{...f.tags,shelter_type:'public_transport'}}])})])assert.deepEqual(result.replacementBuildingIds,[]);
});

test('missing terrain and absent source sport features never become fabricated facilities',()=>{
  const doc=snapshot({areas:[{id:'park',kind:'park',polygon:rectangle(0,0,300,300)}]}),missing=buildRecreationDetail(doc,()=>null,{recreation:supplement([feature('play','playground',0,0,25,25)])});
  assert.equal(missing.groups.length,0);assert.ok(missing.stats.skippedMissingTerrain>0);assert.equal(missing.focus,null);
  const noSource=buildRecreationDetail(doc,()=>0,{recreation:{status:'failed',features:[]},maxTriangles:300});
  assert.equal(noSource.stats.sportsFields,0);assert.equal(noSource.stats.playgrounds,0);assert.ok(noSource.stats.triangles<=300);assert.equal(noSource.stats.sourceStatus,'failed');
});

for(const id of ['colossus1','colossus2','ashburn','abilene','thedalles'])test(id+': saved recreation source has provenance and produces a bounded protected scene',()=>{
  const root=new URL('../data/cloudshadow/neighborhoods/',import.meta.url),doc=JSON.parse(readFileSync(new URL(id+'.json',root))),recreation=JSON.parse(readFileSync(new URL('recreation-'+id+'.json',root)));
  assert.equal(recreation.status,'ready');assert.equal(recreation.source.license,'ODbL-1.0');assert.match(recreation.source.responseSha256,/^[a-f0-9]{64}$/);assert.ok(recreation.source.osmTimestamp&&recreation.source.queryScope);
  const result=buildRecreationDetail(doc,()=>100,{recreation});assert.ok(result.stats.triangles<=65000);assert.ok(result.groups.length<=1);assert.ok(result.stats.sportsFields>0);
  assert.ok(result.focus);assert.ok(result.placements.every(p=>recreation.features.some(f=>f.id===p.sourceId)||(doc.areas||[]).some(f=>f.id===p.sourceId&&f.kind==='park')));
});
