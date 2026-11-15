// Lossless at the Float32 precision uploaded to the GPU. Sharing vertices only
// when every rendered attribute matches preserves low-poly edges and colors.
export function packSurfaceVertices(group){
  const count=group.positions.length/3;if(count<24)return group;
  const stride=group.colors?10:6,values=new Float32Array(count*stride),bits=new Uint32Array(values.buffer);
  for(let i=0;i<count;i++){const j=i*stride;for(let k=0;k<3;k++){values[j+k]=group.positions[i*3+k];values[j+3+k]=group.normals[i*3+k];}if(group.colors)for(let k=0;k<4;k++)values[j+6+k]=group.colors[i*4+k];}
  let capacity=1;while(capacity<count*1.5)capacity*=2;
  const heads=new Uint32Array(capacity),links=new Uint32Array(count),representatives=new Uint32Array(count),remap=new Uint32Array(count);let unique=0;
  for(let i=0;i<count;i++){
    const start=i*stride;let hash=2166136261;for(let k=0;k<stride;k++)hash=Math.imul(hash^bits[start+k],16777619);hash^=hash>>>16;
    const bucket=(hash>>>0)&(capacity-1);let entry=heads[bucket],found=-1;
    while(entry){const candidate=entry-1,other=representatives[candidate]*stride;let same=true;for(let k=0;k<stride;k++)if(bits[start+k]!==bits[other+k]){same=false;break;}if(same){found=candidate;break;}entry=links[candidate];}
    if(found<0){found=unique++;representatives[found]=i;links[found]=heads[bucket];heads[bucket]=found+1;}remap[i]=found;
  }
  if(unique>=count*.97)return group;
  const positions=new Float32Array(unique*3),normals=new Float32Array(unique*3),colors=group.colors?new Float32Array(unique*4):undefined;
  for(let i=0;i<unique;i++){const j=representatives[i]*stride;positions.set(values.subarray(j,j+3),i*3);normals.set(values.subarray(j+3,j+6),i*3);if(colors)colors.set(values.subarray(j+6,j+10),i*4);}
  return {...group,positions,normals,...(colors?{colors}:{}),indices:Uint32Array.from(group.indices,index=>remap[index])};
}
