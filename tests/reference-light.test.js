import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceSunDirection} from '../apps/web/js/reference-light.js';

test('reference lighting stays finite and unit-length at all longitudes without a calendar clock',()=>{
  for(const lon of [-180,-121,-90,0,120,180])for(const mode of ['golden','night']){
    const direction=referenceSunDirection({lon},mode);
    assert.ok(direction.every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...direction)-1)<1e-12);
  }
  referenceSunDirection({lon:-180}).forEach((n,i)=>assert.ok(Math.abs(n-referenceSunDirection({lon:180})[i])<1e-12));
});

test('golden-hour reference light is low above the horizon while night is below it',()=>{
  const lat=35*Math.PI/180,lon=-90*Math.PI/180,up=[Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)];
  const altitude=mode=>-referenceSunDirection({lon:-90},mode).reduce((sum,v,i)=>sum+v*up[i],0);
  assert.ok(altitude('golden')>0&&altitude('golden')<.2);
  assert.ok(altitude('night')<0);
});
