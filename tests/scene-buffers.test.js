import test from 'node:test';
import assert from 'node:assert/strict';
import {compactSceneBuffers} from '../apps/web/js/scene-buffers.js';

test('scenery packing removes unused kit data and preserves shared strided geometry and GPU instance bytes',()=>{
  const bytes=Uint8Array.from({length:128},(_,i)=>i),gltf={
    nodes:[{mesh:1,extensions:{EXT_mesh_gpu_instancing:{attributes:{TRANSLATION:3}}}},{mesh:1}],
    meshes:[{primitives:[{attributes:{POSITION:0},material:0}]},{primitives:[{attributes:{POSITION:1,NORMAL:2},indices:4,material:1}]}],
    materials:[{name:'unused'},{name:'live'}],
    accessors:[{bufferView:0},{bufferView:1,byteOffset:0},{bufferView:1,byteOffset:12},{bufferView:2},{bufferView:3}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:32},{buffer:0,byteOffset:32,byteLength:48,byteStride:24},{buffer:0,byteOffset:80,byteLength:24},{buffer:0,byteOffset:104,byteLength:6}],buffers:[{byteLength:128}]
  };
  const before=structuredClone(gltf),result=compactSceneBuffers(gltf,[bytes]);
  assert.equal(gltf.meshes.length,1);assert.equal(gltf.materials.length,1);assert.equal(gltf.materials[0].name,'live');assert.equal(gltf.accessors.length,4);assert.equal(gltf.bufferViews.length,3);
  assert.ok(result.savedBytes>=48);assert.equal(result.byteLength%4,0);assert.equal(gltf.nodes[0].mesh,gltf.nodes[1].mesh);
  const combined=new Uint8Array(result.byteLength);let offset=0;for(const part of result.chunks){combined.set(part,offset);offset+=part.length;}
  const pairs=[[3,gltf.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION],[1,gltf.meshes[0].primitives[0].attributes.POSITION],[2,gltf.meshes[0].primitives[0].attributes.NORMAL],[4,gltf.meshes[0].primitives[0].indices]];
  for(const [oldId,newId] of pairs){const oldView=before.bufferViews[before.accessors[oldId].bufferView],newView=gltf.bufferViews[gltf.accessors[newId].bufferView];assert.deepEqual(combined.slice(newView.byteOffset,newView.byteOffset+newView.byteLength),bytes.slice(oldView.byteOffset,oldView.byteOffset+oldView.byteLength));assert.equal(newView.byteStride,oldView.byteStride);}
  assert.ok(gltf.bufferViews.every(view=>view.byteOffset%4===0));
});

test('packing refuses animated or textured assets instead of silently dropping required references',()=>{
  for(const field of ['skins','animations','images'])assert.throws(()=>compactSceneBuffers({[field]:[{}]},[]),/static, texture-free/);
});
