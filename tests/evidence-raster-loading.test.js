import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceTexture} from '../apps/web/js/evidence-map.js';
import {normalizeEvidenceTexture} from '../apps/web/js/landscape-shader.js';

test('decoded source readiness distinguishes missing pixels from failed tiles and wraps the dateline',async()=>{
  const previousImage=globalThis.Image,previousDocument=globalThis.document;
  let failed=false,missing=false;
  globalThis.Image=class {
    width=256;height=256;
    set src(value){if(value)queueMicrotask(()=>failed?this.onerror?.():this.onload?.());}
  };
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData(){const data=new Uint8ClampedArray(256*256*4);if(!missing)for(let i=0;i<data.length;i+=4){data[i+1]=255;data[i+3]=255;}return {data};}})})};
  const options={center:{lat:35,lon:179.9},url:'test-dateline/{z}/{x}/{y}',lut:new Map([[0x00ff00,.5]]),variable:'NDVI',maximumLevel:1};
  try{
    const raster=await evidenceTexture(options);
    assert.ok(raster.bounds[0]>raster.bounds[2]);
    assert.ok(normalizeEvidenceTexture(raster));
    assert.ok(raster.loadedTileCount>0);assert.equal(raster.failedTileCount,0);assert.equal(raster.validPixelCount,256*256);
    missing=true;
    const gap=await evidenceTexture({...options,url:'test-missing/{z}/{x}/{y}'});
    assert.ok(gap.loadedTileCount>0);assert.equal(gap.validPixelCount,0);assert.equal(gap.active,false);
    failed=true;
    await assert.rejects(evidenceTexture({...options,url:'test-offline/{z}/{x}/{y}'}),/could not be loaded/);
  }finally{if(previousImage===undefined)delete globalThis.Image;else globalThis.Image=previousImage;if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
});
