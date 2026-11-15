import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {applySkyLighting,validSkyCoefficients} from '../apps/web/js/sky-lighting.js';
const environments=JSON.parse(readFileSync(new URL('../apps/web/assets/sky/environments.json',import.meta.url))).environments;
test('all EXR-derived skies retain valid provenance and bounded GPU imagery',()=>{
  assert.deepEqual(environments.map(e=>e.id),['clear','cloudy','overcast']);
  let bytes=0;
  for(const e of environments){assert(validSkyCoefficients(e));assert.equal(e.source.license,'CC0-1.0');assert.match(e.source.download,/\.exr$/);
    assert.equal(e.width,1024);assert.equal(e.height,512);bytes+=statSync(new URL('../apps/web/'+e.image,import.meta.url)).size;
    assert(e.diffuseSH[0].every(v=>v>=.3&&v<=1));assert(e.diffuseSH.slice(1).flat().every(v=>v===0));}
  assert(bytes<100000);
});
test('ambient application rejects malformed coefficients and updates each model-owned lighting instance',()=>{
  const C={Cartesian3:class{constructor(...v){this.values=v;}},Cartesian2:class{constructor(...v){this.values=v;}}};
  const model={imageBasedLighting:{}};
  assert(!applySkyLighting(C,model,{diffuseSH:[[NaN,0,0]]}));assert(!applySkyLighting(C,{},environments[0]));
  assert(applySkyLighting(C,model,environments[0]));assert.equal(model.imageBasedLighting.sphericalHarmonicCoefficients.length,9);
  assert.deepEqual(model.imageBasedLighting.imageBasedLightingFactor.values,[.55,.7]);
});
