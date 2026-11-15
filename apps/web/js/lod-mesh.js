// Deliberately faceted distance substitutes; close-up authored models stay intact.
// Vertex colors are linear, like the batched detailed meshes.
export function coarseMesh(template, addAccessor, gltf, palette = 0) {
  const positions = [], normals = [], colors = [], indices = [];
  const linear = (rgb) => rgb.map((v) => v ** 2.2).concat(1);
  const paints = [[.70,.74,.63],[.76,.63,.45],[.56,.67,.72],[.72,.49,.35]];
  const wall = linear(paints[palette]), roof = linear([.20,.29,.32]);
  const leaf = linear([.30,.48,.23]), bark = linear([.31,.23,.15]);
  function tri(a,b,c,color) {
    const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n)||1,start=positions.length/3;
    for (const p of [a,b,c]) { positions.push(...p); normals.push(...n.map((x)=>x/len)); colors.push(...color); }
    indices.push(start,start+1,start+2);
  }
  function box(x,y,z,w,h,d,color) {
    const p=[[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y+h,z-d/2],[x-w/2,y+h,z-d/2],[x-w/2,y,z+d/2],[x+w/2,y,z+d/2],[x+w/2,y+h,z+d/2],[x-w/2,y+h,z+d/2]];
    for(const [a,b,c,d] of [[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2]]) { tri(p[a],p[b],p[c],color);tri(p[a],p[c],p[d],color); }
  }
  const w=template.width,d=template.depth,h=template.height;
  if (['tree','shrub'].includes(template.kind)) {
    // Crown metadata shares the authored irregular layout with the distance
    // substitute, including its mixed species silhouettes and leaf colors.
    const grove=template.style==='grove';
    const fallback=[[-.32,-.19],[-.10,-.33],[.22,-.27],[.33,.01],[.20,.30],[-.12,.33],[-.30,.10],[-.02,-.02],[.06,.16]];
    const crowns=grove ? template.canopies ?? fallback.map(([x,z],k)=>({x:x*w,z:z*d,height:h*(.83+(k%3)*.08),rx:Math.min(w,d)/7,rz:Math.min(w,d)/7,shape:k%3===1?'conifer':'broadleaf'})) : [{x:0,z:0,height:h*.83,rx:Math.min(w,d)/2,rz:Math.min(w,d)/2,shape:'conifer'}];
    // Authored bounds/centers are rounded to 0.01 mm. Keep that rounding
    // from letting a reconstructed crown exceed its declared footprint.
    const crownPoint=(x,y,z)=>[Math.max(-w/2,Math.min(w/2,x)),y,Math.max(-d/2,Math.min(d/2,z))];
    for(const crown of crowns){
      const {x,z,rx,rz,shape}=crown,top=crown.height;
      const color=crown.color ? linear(crown.color) : leaf;
      box(x,0,z,grove ? .35 : .5,grove ? top*.43 : h*.5,grove ? .35 : .5,bark);
      const sides=grove && shape==='conifer'?6:5;
      if(grove && shape==='broadleaf'){
        const lower=[],upper=[];
        for(let i=0;i<sides;i++){
          const a=i*Math.PI*2/sides;
          lower.push(crownPoint(x+Math.cos(a+.11)*rx,top*.6675,z+Math.sin(a+.11)*rz));
          upper.push(crownPoint(x+Math.cos(a)*rx*.63,top*.8775,z+Math.sin(a)*rz*.63));
        }
        for(let i=0;i<sides;i++){
          const j=(i+1)%sides;
          tri(lower[i],upper[i],lower[j],color);
          tri(lower[j],upper[i],upper[j],color);
          tri(upper[i],[x,top,z],upper[j],color);
        }
      }else{
        for(let i=0;i<sides;i++){
          const a=i*Math.PI*2/sides,b=(i+1)*Math.PI*2/sides;
          tri(crownPoint(x+Math.cos(a)*rx,top*.35,z+Math.sin(a)*rz),[x,top,z],crownPoint(x+Math.cos(b)*rx,top*.35,z+Math.sin(b)*rz),color);
        }
      }
    }
  } else {
    const pitched=['house','farm','warehouse'].includes(template.kind),base=pitched?h*.72:h;
    box(0,0,0,w,base,d,wall);
    if(pitched){
      const a=[-w/2,base,-d/2],b=[w/2,base,-d/2],c=[w/2,base,d/2],e=[-w/2,base,d/2],r1=[0,h,-d/2],r2=[0,h,d/2];
      tri(a,r1,b,wall);tri(e,c,r2,wall);tri(a,e,r2,roof);tri(a,r2,r1,roof);tri(r1,r2,c,roof);tri(r1,c,b,roof);
    }
  }
  const material=gltf.materials.length;
  gltf.materials.push({name:'distance-faceted-'+template.kind,pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],roughnessFactor:1,metallicFactor:0},doubleSided:false});
  return {name:'distance-'+template.id,primitives:[{attributes:{POSITION:addAccessor(positions,3),NORMAL:addAccessor(normals,3),COLOR_0:addAccessor(colors,4)},indices:addAccessor(indices,1,5125),material}]};
}
