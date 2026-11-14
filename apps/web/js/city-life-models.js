// Original tiny vehicle/infrastructure meshes; +Y up, +Z forward. No external assets.
// Box vertices run around the bottom XZ rectangle, then the top rectangle.
// Every face is outward CCW; especially the roof must survive back-face culling.
const FACES = [[0,1,2,3],[4,7,6,5],[3,2,6,7],[0,4,5,1],[0,3,7,4],[1,5,6,2]];
function shape() {
  const groups = new Map();
  function face(points, color) {
    if (!groups.has(color)) groups.set(color, { p: [], n: [], i: [] });
    const group = groups.get(color);
    for (let j = 1; j < points.length - 1; j++) {
      const a = points[0], b = points[j], c = points[j+1], u=b.map((v,k)=>v-a[k]), v=c.map((v,k)=>v-a[k]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], length=Math.hypot(...normal)||1;
      for (const point of [a,b,c]) { group.i.push(group.p.length/3); group.p.push(...point); group.n.push(...normal.map((v)=>v/length)); }
    }
  }
  function box(x,y,z,w,h,d,color) {
    const points=[[-1,0,-1],[1,0,-1],[1,0,1],[-1,0,1],[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]].map(([a,b,c])=>[x+a*w/2,y+b*h,z+c*d/2]);
    for (const f of FACES) face(f.map((i)=>points[i]),color);
  }
  return {groups,face,box};
}
function glb(shape) {
  const doc={asset:{version:'2.0',generator:'Footprint Atlas original city life'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[]}],materials:[],buffers:[{byteLength:0}],bufferViews:[],accessors:[]};
  let offset=0; const chunks=[];
  function accessor(values,size) {
    const array=new Float32Array(values), bytes=new Uint8Array(array.buffer), view=doc.bufferViews.length;
    doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length,target:34962}); chunks.push(bytes);offset+=bytes.length;
    const min=new Array(size).fill(Infinity),max=new Array(size).fill(-Infinity);
    for(let i=0;i<values.length;i++){min[i%size]=Math.min(min[i%size],values[i]);max[i%size]=Math.max(max[i%size],values[i]);}
    const index=doc.accessors.length;doc.accessors.push({bufferView:view,componentType:5126,count:values.length/size,type:size===4?'VEC4':'VEC3',min,max});return index;
  }
  // Bake every paint/window/wheel color into one primitive. A car stays one
  // draw call rather than one draw for every tiny differently colored part.
  const positions=[],normals=[],colors=[];
  for(const [color,group] of shape.groups){
    const rgb=color.match(/../g).map((v)=>(parseInt(v,16)/255)**2.2);
    positions.push(...group.p);normals.push(...group.n);
    for(let i=0;i<group.p.length/3;i++)colors.push(...rgb,1);
  }
  doc.materials.push({name:'baked-city-colors',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],roughnessFactor:.85,metallicFactor:0},doubleSided:false});
  doc.meshes[0].primitives.push({attributes:{POSITION:accessor(positions,3),NORMAL:accessor(normals,3),COLOR_0:accessor(colors,4)},material:0,mode:4});
  doc.buffers[0].byteLength=offset;
  const json=new TextEncoder().encode(JSON.stringify(doc)), jsonLength=(json.length+3)&~3, binLength=(offset+3)&~3;
  const out=new Uint8Array(28+jsonLength+binLength), view=new DataView(out.buffer);
  view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,out.length,true);view.setUint32(12,jsonLength,true);view.setUint32(16,0x4e4f534a,true);
  out.fill(32,20,20+jsonLength);out.set(json,20);view.setUint32(20+jsonLength,binLength,true);view.setUint32(24+jsonLength,0x004e4942,true);
  let at=28+jsonLength;for(const chunk of chunks){out.set(chunk,at);at+=chunk.length;}return out.buffer;
}
function car(color) {
  const s=shape();s.box(0,.31,0,1.7,.53,4.15,color);s.box(0,.2,0,1.45,.16,3.6,'24323b');
  const cabin=[[-.75,.81,-.95],[.75,.81,-.95],[.75,.81,1],[-.75,.81,1],[-.62,1.46,-.53],[.62,1.46,-.53],[.62,1.46,.57],[-.62,1.46,.57]];
  for(let i=0;i<FACES.length;i++)s.face(FACES[i].map((j)=>cabin[j]),i===1?color:'304953');
  for(const x of [-.84,.84])for(const z of [-1.28,1.28])s.box(x,.08,z,.24,.55,.68,'19242a');
  for(const x of [-.55,.55]){s.box(x,.57,2.09,.35,.13,.055,'e3e5c7');s.box(x,.57,-2.09,.35,.13,.055,'a44d4a');}
  return glb(s);
}
function propPlane() {
  const s=shape();s.box(0,.3,0,.48,.48,4.6,'d5dedc');s.box(0,.64,.65,.43,.25,1.15,'365965');
  s.box(0,.44,.1,7.6,.1,1.05,'e3e7de');s.box(0,.51,-1.8,2.55,.08,.65,'648d8d');s.box(0,.52,-1.9,.1,.86,.95,'648d8d');
  s.box(-3.52,.45,.1,.56,.11,1.06,'c37862');s.box(3.52,.45,.1,.56,.11,1.06,'548b96');
  const nose=[[-.24,.3,2.3],[.24,.3,2.3],[.24,.78,2.3],[-.24,.78,2.3],[0,.54,2.85]];
  for(let i=0;i<4;i++)s.face([nose[i],nose[(i+1)%4],nose[4]],'d5dedc');
  s.box(0,.5,2.87,1.25,.08,.07,'30434b');return glb(s);
}
function van(color){
  const s=shape();s.box(0,.38,0,1.98,1.75,5.45,color);s.box(0,1.16,1.69,2.01,.72,1.28,'36505a');s.box(0,1.28,2.74,1.72,.62,.04,'36505a');
  s.box(0,2.08,-.22,1.94,.12,4.74,color);
  for(const x of [-.97,.97])for(const z of [-1.72,1.7])s.box(x,.08,z,.25,.65,.76,'19242a');
  for(const x of [-.63,.63])s.box(x,.65,2.76,.4,.17,.06,'eee5be');return glb(s);
}
function bus(){
  const s=shape();s.box(0,.42,0,2.4,2.55,10.5,'c8a66a');s.box(0,1.55,.1,2.43,.9,9.45,'304d56');
  s.box(0,1.55,5.27,2.17,1.0,.04,'304d56');
  s.box(0,2.85,0,2.37,.18,10.3,'cfb57e');s.box(1.23,.5,3.35,.06,1.95,1.25,'537077');
  for(const x of [-1.2,1.2])for(const z of [-3.3,3.3])s.box(x,.08,z,.27,.83,.98,'1b2930');return glb(s);
}
function delivery(color){
  const s=shape();s.box(0,.62,-.82,2.25,2.48,5.1,color);s.box(0,.5,2.58,2.12,1.8,2.08,'d4dbce');s.box(0,1.42,2.73,2.15,.64,1.76,'37505a');
  s.box(0,1.42,3.64,1.88,.64,.04,'37505a');
  for(const x of [-1.1,1.1])for(const z of [-2.4,2.56])s.box(x,.08,z,.29,.88,1.04,'1b2930');return glb(s);
}
function wing(s,polygon,y,thickness,color){
  let area=0;for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length];area+=a[0]*b[1]-b[0]*a[1];}
  const points=area>0?[...polygon].reverse():polygon,top=points.map(([x,z])=>[x,y+thickness,z]),bottom=points.map(([x,z])=>[x,y,z]);
  s.face(top,color);s.face([...bottom].reverse(),color);
  for(let i=0;i<top.length;i++){const j=(i+1)%top.length;s.face([bottom[i],bottom[j],top[j],top[i]],color);}
}
function jet(cargo=false){
  const s=shape(),length=cargo?31:25,width=cargo?3.6:2.7,span=cargo?34:27,color=cargo?'aabdc1':'dce1db';
  s.box(0,1.05,-1,width,2.3,length-4,color);s.box(0,1.25,length/2-2.4,width*.78,1.7,3.7,color);
  s.box(0,2.05,length/2-.5,width*.69,.65,.04,'345460');
  wing(s,[[-width/2,3.5],[-span/2,-3.5],[-span/2,-5.4],[-width/2,-1.8]],1.2,.2,cargo?'8ea9ac':'afc5c8');
  wing(s,[[width/2,3.5],[span/2,-3.5],[span/2,-5.4],[width/2,-1.8]],1.2,.2,cargo?'8ea9ac':'afc5c8');
  wing(s,[[-6.5,-length/2+1],[-.7,-length/2+4],[.7,-length/2+4],[6.5,-length/2+1],[0,-length/2]],2.7,.18,'6c959e');
  s.box(0,2.7,-length/2+2,.22,4.0,4.4,'6c959e');
  for(const x of cargo?[-10,-6,6,10]:[-5,5])s.box(x,.2,-.6,1.1,1.2,3.3,'536d75');
  return glb(s);
}
function lamp(){const s=shape();s.box(0,0,0,.13,6,.13,'536c71');s.box(0,5.8,.55,.13,.12,1.2,'536c71');s.box(0,5.7,1.1,.5,.16,.32,'e8d9a6');return glb(s);}
function sign(){const s=shape();s.box(0,0,0,.07,2.6,.07,'6e8587');s.box(0,2.05,0,.9,.62,.1,'487b69');s.box(0,2.28,.06,.56,.055,.02,'e5e9d8');return glb(s);}
let modelBuffers;
export function buildCityLifeModels(){
  const prop=propPlane();return {cars:['8cb6b0','ba7567','c4aa75','d8dfd8','7696b3','728286'].map(car),vans:['c6d5c9','8ca4b4'].map(van),bus:bus(),delivery:['d8c8a3','9aaeb4'].map(delivery),plane:prop,planes:{prop,regional:jet(),cargo:jet(true)},lamp:lamp(),sign:sign()};
}
export function createCityLifeModelPack(){
  const buffers=modelBuffers ||= buildCityLifeModels(), urls=[];
  const make=(buffer)=>{const url=URL.createObjectURL(new Blob([buffer],{type:'model/gltf-binary'}));urls.push(url);return url;};
  const pack={cars:buffers.cars.map(make),vans:buffers.vans.map(make),bus:make(buffers.bus),delivery:buffers.delivery.map(make),planes:{prop:make(buffers.planes.prop),regional:make(buffers.planes.regional),cargo:make(buffers.planes.cargo)},lamp:make(buffers.lamp),sign:make(buffers.sign)};
  pack.plane=pack.planes.prop;
  pack.vehicles=[...pack.cars.map((url)=>({url,kind:'car',length:4.2})),...pack.vans.map((url)=>({url,kind:'van',length:5.5})),{url:pack.bus,kind:'bus',length:10.5},...pack.delivery.map((url)=>({url,kind:'delivery',length:7.3}))];
  let destroyed=false;pack.destroy=()=>{if(destroyed)return;destroyed=true;for(const url of urls)URL.revokeObjectURL(url);};return pack;
}
