import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceColor,recolorEvidence,comparisonDates,MAP_SCALES} from '../apps/web/js/evidence-map.js';
import {plumeRaster,powerGridRaster} from '../apps/web/js/environment-map.js';
test('NASA change maps subtract decoded values, preserving gaps and units',()=>{
  const lut=new Map([[0xff0000,300],[0x00ff00,290],[0x0000ff,295]]);
  const data=new Uint8Array([255,0,0,255,0,255,0,255,1,2,3,255,255,0,0,0]);
  const baseline=new Uint8Array([0,0,255,255,0,0,255,255,0,0,255,255,0,0,255,255]);
  const actual=recolorEvidence(data,baseline,lut,{scale:MAP_SCALES.LST_Day,offset:-273.15,change:true});
  assert.deepEqual([...actual.slice(0,4)],evidenceColor(5,MAP_SCALES.LST_Day,true));
  assert.deepEqual([...actual.slice(4,8)],evidenceColor(-5,MAP_SCALES.LST_Day,true));
  assert.deepEqual([...actual.slice(8)],[0,0,0,0,0,0,0,0]);
  const abs=recolorEvidence(data,null,lut,{scale:MAP_SCALES.LST_Day,offset:-273.15});
  assert.deepEqual([...abs.slice(0,4)],evidenceColor(26.85,MAP_SCALES.LST_Day));
});
test('future and early comparisons stay within observed product coverage',()=>{
  assert.deepEqual(comparisonDates('NO2',2050,2005,2025),{current:'2025-07-15',baseline:'2023-07-15',historical:false});
  assert.equal(comparisonDates('NDVI',2003,2020).baseline,'2003-07-15');
});
test('plume raster preserves north/south orientation and missing cells',()=>{
  const raster=plumeRaster({site:{lat:35,lon:-90},grid:{n:2,halfWidthM:100,values:[[1,null],[.01,0]]}});
  assert.equal(raster.rgba[7],0);assert.ok(raster.rgba[11]>raster.rgba[3]);assert.equal(raster.rgba[15],0);
  assert.ok(raster.bounds[0]<-90&&raster.bounds[2]>-90);
  assert.equal(plumeRaster({}),null);
});
test('native weather grids preserve source extent, orientation and missing cells',()=>{
  const raster=powerGridRaster({grid:{variable:'T2M',units:'C',date:'2025-07',latitudes:[39,39.5],longitudes:[-78,-77.375],values:[0,10,null,25]}});
  assert.deepEqual(raster.bounds,[-78.3125,38.75,-77.0625,39.75]);assert.equal(raster.rgba[11],0);assert.ok(raster.rgba[15]>0);
  assert.equal(powerGridRaster({grid:{latitudes:[1],longitudes:[2],values:[5]}}),null);
});
