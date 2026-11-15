import test from 'node:test';import assert from 'node:assert/strict';
import {screeningSpatialRaster,noiseContourPlan,attachEvidenceScene} from '../apps/web/js/evidence-scene.js';
import {readoutPlacement} from '../apps/web/js/scene-readout.js';
import {futureScenePresentation} from '../apps/web/js/future-scene.js';
const site={id:'example',lat:40,lon:-90};
test('screening map is calculated from the real dilution grid and fixes the scale across supplied years',()=>{
 const source={spatial:{dispersion:{site,grid:{n:2,halfWidthM:1000,values:[[1,0],[.2,null]]}},scales:[{year:2030,heatMultiplier:1},{year:2040,heatMultiplier:2}]}};
 const first=screeningSpatialRaster(source,2030,'heat'),last=screeningSpatialRaster(source,2040,'heat');assert.match(first.note,/0 to 2.00/);assert.match(last.note,/0 to 2.00/);assert.notDeepEqual(first.rgba,last.rgba);assert.equal(first.rgba[3],60);assert.equal(first.rgba[7],0);assert.equal(screeningSpatialRaster(source,2035,'heat'),null);assert.equal(screeningSpatialRaster(source,2030,'water'),null);
});
test('noise contours display only actual chosen levels within the supported range and selected year',()=>{
 const result={years:[{year:2030,noiseContours:[{levelDbA:40,radiusM:500,status:'conditional-screening'},{levelDbA:10,radiusM:null,status:'outside-supported-distance'}]}]};assert.equal(noiseContourPlan(result,2030).length,1);assert.equal(noiseContourPlan(result,2040).length,0);
});
test('scene text avoids the sidebar and neighborhood controls and hides when no readable space remains',()=>{
 const placed=readoutPlacement({x:600,y:400,width:330,height:130,viewportWidth:1440,viewportHeight:900,panelRight:400,top:75,bottom:645,obstacle:{left:418,right:768,top:90,bottom:330}});assert.ok(placed.x>=780||placed.y>=342);assert.equal(readoutPlacement({x:100,y:100,width:330,height:130,viewportWidth:390,viewportHeight:844,panelRight:390}),null);
});
test('explicit local screening remains separate from climate and missing scenario years never inherit results',()=>{
 const raw={site,years:[{year:2030,source:{evidence:'assumed'},metrics:[{domain:'heat',label:'Temperature rise',value:0,unit:'°C'}]}]};const state={site,siteId:site.id,year:2030,showScreening:true,screeningDomain:'heat',products:{'environment-screening':raw}};
 const plan=futureScenePresentation(state);assert.equal(plan.kind,'screening');assert.match(plan.label,/0 °C/);assert.match(plan.label,/Assumed inputs/);assert.equal(futureScenePresentation({...state,year:2040}),null);
});
test('measured gauge markers follow the rendered DEM and update on streamed scenery without leaking entities',()=>{
 const original=globalThis.Cesium;
 globalThis.Cesium={Cartesian3:{fromDegrees:(lon,lat,height=0)=>({lon,lat,height})},Cartographic:{fromDegrees:(lon,lat)=>({lon,lat})},Cartesian2:class{constructor(x,y){this.x=x;this.y=y;}},HeadingPitchRange:class{},Color:{BLACK:'black',fromCssColorString:value=>value}};
 try{
  const bus=new EventTarget(),items=new Set();let ground=73;bus.CloudShadowNeighborhood={groundHeightAt:()=>ground};
  const viewer={entities:{add:item=>{items.add(item);return item;},remove:item=>items.delete(item)},scene:{requestRender(){},globe:{getHeight:()=>0}},flyTo(){}};
  const points=Array.from({length:365},(_,i)=>({date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),value:10}));
  const state={siteId:site.id,site,year:2025,audit:{stations:[{id:'USGS-example',name:'Example source gauge',lat:40,lon:-90,series:[{id:'00060',statisticId:'00003',unit:'ft^3/s',points}]}]},products:{}};
  const layer=attachEvidenceScene(viewer,{eventTarget:bus});layer.setState(state);bus.dispatchEvent(new CustomEvent('cs:audit-water-view',{detail:{siteId:site.id}}));
  assert.equal(items.size,1);assert.equal([...items][0].position.height,81);
  ground=100;bus.dispatchEvent(new CustomEvent('cs:scene-mode',{detail:{active:true}}));assert.equal(items.size,1);assert.equal([...items][0].position.height,108);layer.destroy();assert.equal(items.size,0);
 }finally{globalThis.Cesium=original;}
});
