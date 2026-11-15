// Compact the authored, texture-free scenery format. Retain exact accessor bytes
// (including GPU instances and interleaved strides), dropping unused kit assets.
export function compactSceneBuffers(gltf,chunks){
  if(gltf.skins?.length||gltf.animations?.length||gltf.images?.length)throw new Error('Scenery compaction requires static, texture-free meshes');
  const oldMeshes=gltf.meshes,oldMaterials=gltf.materials,oldAccessors=gltf.accessors,oldViews=gltf.bufferViews;
  const meshIds=new Map(),materialIds=new Map(),accessorIds=new Map(),viewIds=new Map();
  const keep=(map,id)=>{if(!Number.isInteger(id))throw new Error('Invalid scenery reference');if(!map.has(id))map.set(id,map.size);return map.get(id);};
  for(const node of gltf.nodes){if(node.mesh!==undefined)keep(meshIds,node.mesh);for(const id of Object.values(node.extensions?.EXT_mesh_gpu_instancing?.attributes||{}))keep(accessorIds,id);}
  const meshes=[...meshIds.keys()].map(id=>oldMeshes[id]);
  for(const mesh of meshes)for(const primitive of mesh.primitives){
    for(const id of Object.values(primitive.attributes))keep(accessorIds,id);
    if(primitive.indices!==undefined)keep(accessorIds,primitive.indices);
    if(primitive.material!==undefined)keep(materialIds,primitive.material);
    for(const target of primitive.targets||[])for(const id of Object.values(target))keep(accessorIds,id);
  }
  const accessors=[...accessorIds.keys()].map(id=>oldAccessors[id]);
  for(const accessor of accessors){
    if(accessor.bufferView!==undefined)keep(viewIds,accessor.bufferView);
    if(accessor.sparse){keep(viewIds,accessor.sparse.indices.bufferView);keep(viewIds,accessor.sparse.values.bufferView);}
  }
  const parts=[];let originalBytes=0;
  for(const bytes of chunks){parts.push({start:originalBytes,end:originalBytes+bytes.byteLength,bytes});originalBytes+=bytes.byteLength;}
  let byteLength=0;const packed=[];
  const views=[...viewIds.keys()].map(id=>{
    const view=oldViews[id],start=view.byteOffset||0,end=start+view.byteLength;
    let lo=0,hi=parts.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(parts[mid].start<=start)lo=mid;else hi=mid-1;}
    const part=parts[lo];if(!part||view.buffer!==0||end>part.end)throw new Error('Invalid scenery buffer range');
    const copy={...view,buffer:0,byteOffset:byteLength};packed.push(part.bytes.subarray(start-part.start,end-part.start));byteLength+=view.byteLength;
    const padding=(4-byteLength%4)%4;if(padding){packed.push(new Uint8Array(padding));byteLength+=padding;}return copy;
  });
  for(const node of gltf.nodes){if(node.mesh!==undefined)node.mesh=meshIds.get(node.mesh);const attributes=node.extensions?.EXT_mesh_gpu_instancing?.attributes;for(const key of Object.keys(attributes||{}))attributes[key]=accessorIds.get(attributes[key]);}
  for(const mesh of meshes)for(const primitive of mesh.primitives){
    for(const key of Object.keys(primitive.attributes))primitive.attributes[key]=accessorIds.get(primitive.attributes[key]);
    if(primitive.indices!==undefined)primitive.indices=accessorIds.get(primitive.indices);
    if(primitive.material!==undefined)primitive.material=materialIds.get(primitive.material);
    for(const target of primitive.targets||[])for(const key of Object.keys(target))target[key]=accessorIds.get(target[key]);
  }
  for(const accessor of accessors){if(accessor.bufferView!==undefined)accessor.bufferView=viewIds.get(accessor.bufferView);if(accessor.sparse){accessor.sparse.indices.bufferView=viewIds.get(accessor.sparse.indices.bufferView);accessor.sparse.values.bufferView=viewIds.get(accessor.sparse.values.bufferView);}}
  gltf.meshes=meshes;gltf.materials=[...materialIds.keys()].map(id=>oldMaterials[id]);gltf.accessors=accessors;gltf.bufferViews=views;gltf.buffers=[{byteLength}];
  return {chunks:packed,byteLength,savedBytes:originalBytes-byteLength};
}
