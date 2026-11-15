import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SITE_HISTORY,describeSiteHistory,historyTransition,buildingHistoryState,mappedBuildingHistory} from '../apps/web/js/site-history.js';
import {resolveSiteEvidence,isWaterUseRecord,formatWaterRecord} from '../apps/web/js/site-evidence.js';
import {attachSceneEvidence,attachSiteEvidence,anchoredWaterText} from '../apps/web/js/scene-evidence.js';
import {planNeighborhood} from '../apps/web/js/neighborhood-core.js';
import {groupCampusBuildings} from '../apps/web/js/urban-detail.js';

test('history distinguishes conversion, construction, first opening and regional reference without fabricated day precision',()=>{
  assert.equal(SITE_HISTORY.colossus1.events[0].kind,'conversion-announced');
  assert.equal(SITE_HISTORY.abilene.events[0].kind,'construction-start');
  assert.equal(SITE_HISTORY.colossus2.events[0].kind,'construction-announced');
  assert.equal(SITE_HISTORY.thedalles.events[0].date,'2006');
  assert.equal(SITE_HISTORY.thedalles.events[0].precision,'year');
  assert.equal(SITE_HISTORY.ashburn.events[0].kind,'study-reference');
  assert.match(describeSiteHistory('ashburn',2003).notice,/not a universal opening/);
  for(const [site,history]of Object.entries(SITE_HISTORY)){
    assert.equal(describeSiteHistory(site,2010).historicalMap,false);
    assert.ok(history.events.every(event=>event.source.url&&event.confidence));
    assert.equal(history.verifiedBuildings.length,0,'no campus-wide milestone may date its individual halls');
  }
});

test('rewinding crosses actual event years while the former factory shell remains visible',()=>{
  const transition=historyTransition('colossus1',2025,2023);
  assert.equal(transition.direction,'backward');assert.equal(transition.crossed[0].date,'2024');
  const factory={id:'way/1381264361',history:{mappedStartDate:'2024'}};
  const previous=buildingHistoryState('colossus1',factory,2023);
  assert.equal(previous.visible,true);assert.match(previous.usageLabel,/Electrolux/);
  assert.equal(buildingHistoryState('colossus1',factory,2003).visible,true,'unknown original construction date cannot justify deleting the shell');
  assert.match(buildingHistoryState('colossus1',factory,2025).usageLabel,/conversion/);
});

test('selective hiding requires matching independently verified new construction, never OSM dates or conversions',()=>{
  const building={id:'way/one',history:mappedBuildingHistory({id:'way/one',tags:{start_date:'2022'}})};
  assert.equal(buildingHistoryState('ashburn',building,2003).visible,true);
  const record={buildingId:'way/one',date:'2022-05',kind:'new-construction',verified:true,source:{evidence:'primary'}};
  assert.equal(buildingHistoryState('ashburn',building,2021,{verifiedBuildings:[record]}).visible,false);
  assert.equal(buildingHistoryState('ashburn',building,2022,{verifiedBuildings:[record]}).visible,true);
  for(const changed of [{...record,buildingId:'way/other'},{...record,verified:false},{...record,kind:'conversion'},{...record,source:{evidence:'osm-contributed'}}]){
    assert.equal(buildingHistoryState('ashburn',building,2003,{verifiedBuildings:[changed]}).visible,true);
  }
});

test('water records retain units/accounting scope and never interpolate missing annual values or convert requests into use',()=>{
  const data=resolveSiteEvidence('thedalles',2021),records=data.water.records;
  assert.equal(data.water.selected.value,355100000);assert.equal(data.water.exact,true);
  assert.equal(records.find(record=>record.year===2017).value,124200000);
  const consumption=records.find(record=>record.metric==='reported-consumption');
  assert.equal(consumption.value,275000000);assert.equal(consumption.approximation,'almost');
  assert.equal(consumption.source.evidence,'operator-primary');assert.notEqual(consumption.metric,data.water.selected.metric);
  const gap=resolveSiteEvidence('thedalles',2019);assert.equal(gap.water.selected.year,2017);assert.equal(gap.water.exact,false);
  assert.equal(gap.water.availability,'historical-report-only');assert.match(anchoredWaterText(gap),/historical reference/);
  assert.equal(resolveSiteEvidence('thedalles',2005).water.selected,null);
  const request=resolveSiteEvidence('colossus2',2026);assert.equal(request.water.records[0].value,3700000);
  assert.equal(request.water.records[0].status,'requested');assert.equal(request.water.selected,null);assert.equal(anchoredWaterText(request),null);
  assert.equal(isWaterUseRecord({status:'reported',metric:'reported-water-use',value:null}),false);
  assert.match(formatWaterRecord(data.water.selected),/355\.1 million US gal/);
});

test('xAI peak/plan and resident noise reports remain qualified evidence, not daily series or outdoor contours',()=>{
  const evidence=resolveSiteEvidence('colossus1',2025);
  assert.equal(evidence.water.selected.status,'reported-peak');assert.equal(evidence.water.selected.aggregation,'reported-peak-rate');
  assert.equal(evidence.water.selected.value,381000);assert.equal(evidence.water.records[0].status,'planned');
  const noise=resolveSiteEvidence('colossus2',2025).noise;
  assert.equal(noise.spatialModel,false);assert.equal(noise.records[0].value,null);
  assert.equal(noise.records[0].location,null);assert.equal(noise.records[0].eligibleForSpatialModel,false);
  assert.equal(resolveSiteEvidence('unknown',2050).water.selected,null);
});

test('planner and grouped campuses preserve contributed start dates solely as unverified metadata',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../apps/web/assets/low-poly/manifest.json',import.meta.url)));
  const snapshot={schemaVersion:1,siteId:'ashburn',center:{lat:39,lon:-77},radiusM:200,roads:[],areas:[],trees:[],buildings:[
    {id:'way/a',polygon:[[-20,-20],[20,-20],[20,20],[-20,20]],tags:{building:'data_center',start_date:'2022'}},
    {id:'way/b',polygon:[[55,-20],[95,-20],[95,20],[55,20]],tags:{building:'data_center'}},
  ]};
  const plan=planNeighborhood(snapshot,manifest,{maxTrees:0,maxCrops:0,maxGrass:0,maxInfillBuildings:0});
  assert.equal(plan.campuses.length,2);
  const campus=plan.campuses.find(c=>c.id==='way/a');
  assert.equal(campus.history.mappedStartDate,'2022');assert.equal(campus.history.verified,false);assert.equal(campus.history.canHide,false);
  assert.equal(campus.sourceFootprintId,'way/a');
  const groups=groupCampusBuildings(snapshot,plan.instances);
  assert.ok(groups.every(group=>!group.historicalGeometry));
  const metadata=groups.flatMap(group=>group.buildingEvidence).find(record=>record.sourceFootprintId==='way/a');
  assert.equal(metadata.mappedStartDate,'2022');assert.equal(metadata.canHide,false);
});

test('scene labels stay bounded, depth tested, year qualified and fully released with their patch',t=>{
  const previous=globalThis.Cesium,entities=[];
  class Vector{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(x,y,z=0){return new Vector(x,y,z);}}
  globalThis.Cesium={Cartesian3:Vector,Cartesian2:Vector,Transforms:{eastNorthUpToFixedFrame:()=>({})},Matrix4:{multiplyByPoint:(_,point)=>point},
    Color:{WHITE:{},BLACK:{},fromCssColorString:()=>({withAlpha:()=>({})})},DistanceDisplayCondition:class{constructor(near,far){Object.assign(this,{near,far});}},LabelStyle:{FILL_AND_OUTLINE:1}};
  t.after(()=>{if(previous===undefined)delete globalThis.Cesium;else globalThis.Cesium=previous;});
  const viewer={entities:{add(entity){entities.push(entity);return entity;},remove(entity){assert.ok(entities.includes(entity));entities.splice(entities.indexOf(entity),1);}}};
  const data={center:{lat:45,lon:-121},campuses:[{id:'way/campus',x:12,y:14,height:20,baseHeight:30}],heightOffset:()=>3};
  const layer=attachSceneEvidence(viewer,{id:'thedalles'},data);assert.equal(layer.count,2);
  assert.ok(entities.every(entity=>!entity.show&&entity.label.disableDepthTestDistance===0&&entity.lowPoly));
  layer.setYear(2017);layer.setActive(true);assert.ok(entities.every(entity=>entity.show));
  assert.match(entities[1].label.text,/124\.2 million US gal/);assert.match(entities[1].label.text,/all Google The Dalles facilities/);
  assert.equal(entities[0].position.z,59);
  layer.setYear(2003);assert.equal(entities[0].show,true);assert.equal(entities[1].show,false);
  layer.setYear(2050);assert.match(entities[1].label.text,/2021/);assert.match(entities[1].label.text,/historical reference/);
  assert.equal(entities.length,2);layer.destroy();layer.destroy();assert.equal(entities.length,0);
  const other=attachSceneEvidence(viewer,{id:'thedalles'},data,{base:false});assert.equal(other.count,0);assert.equal(entities.length,0);
});

test('global evidence events follow selected site/year and unsubscribe cleanly without DOM or a renderer',t=>{
  const previous={window:globalThis.window,CustomEvent:globalThis.CustomEvent};
  globalThis.window=new EventTarget();globalThis.CustomEvent=class extends Event{constructor(type,{detail}){super(type);this.detail=detail;}};
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const seen=[];window.addEventListener('cs:facility-evidence',event=>seen.push(event.detail));
  const layer=attachSiteEvidence({site:{id:'abilene'},year:2025});assert.equal(seen.length,1);
  window.dispatchEvent(new CustomEvent('cs:year',{detail:{siteId:'abilene',year:2023}}));
  assert.equal(seen.at(-1).transition.direction,'backward');assert.equal(seen.at(-1).transition.crossed[0].date,'2024-06');
  const count=seen.length;window.dispatchEvent(new CustomEvent('cs:year',{detail:{siteId:'other',year:2050}}));assert.equal(seen.length,count);
  layer.destroy();window.dispatchEvent(new CustomEvent('cs:year',{detail:{siteId:'abilene',year:2020}}));assert.equal(seen.length,count);
});
