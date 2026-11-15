import test from 'node:test';
import assert from 'node:assert/strict';
import {packSurfaceVertices} from '../apps/web/js/surface-packing.js';

test('surface packing preserves every rendered triangle, color and hard normal while shrinking repeated faces',()=>{
 const group={positions:[],normals:[],colors:[],indices:[],category:0};
 for(let tile=0;tile<20;tile++)for(const [x,z] of [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]){
   group.indices.push(group.positions.length/3);group.positions.push(x+tile,0,z);group.normals.push(0,1,0);group.colors.push(tile%2,0.5,0.25,1);
 }
 // An overlapping face with a different normal must not merge across its edge.
 for(let i=0;i<6;i++){group.indices.push(group.positions.length/3);group.positions.push(...group.positions.slice(i*3,i*3+3));group.normals.push(0,0,1);group.colors.push(...group.colors.slice(i*4,i*4+4));}
 const packed=packSurfaceVertices(group);assert.ok(packed.positions.length<group.positions.length*.75);assert.equal(packed.indices.length,group.indices.length);
 for(let i=0;i<group.indices.length;i++)for(const [name,stride] of [['positions',3],['normals',3],['colors',4]])for(let k=0;k<stride;k++)assert.equal(packed[name][packed.indices[i]*stride+k],Math.fround(group[name][group.indices[i]*stride+k]));
 assert.deepEqual(packSurfaceVertices(group),packed,'packing must be deterministic');
});

test('already unique surfaces preserve their data without a second vertex allocation',()=>{
 const group={positions:Array.from({length:90},(_,i)=>i),normals:Array.from({length:90},(_,i)=>i%3===1?1:0),indices:Array.from({length:30},(_,i)=>i)};
 assert.equal(packSurfaceVertices(group),group);
});
