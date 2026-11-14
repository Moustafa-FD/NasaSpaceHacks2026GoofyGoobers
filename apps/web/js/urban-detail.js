// Mapped OSM paving and airports, with explicitly illustrative local detailing.
// Pads, parking paint, fences and entrance props are scenery, not cadastral data.
import {triangulateWaterPolygon} from './terrain-mesh.js';
import {buildRoadSurface,resolveRoadWidth} from './road-mesh.js';

const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function hash(value){let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
const box=(p)=>[Math.min(...p.map((v)=>v[0])),Math.min(...p.map((v)=>v[1])),Math.max(...p.map((v)=>v[0])),Math.max(...p.map((v)=>v[1]))];
function inside(p,ring){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
const inFeature=(p,f)=>inside(p,f.polygon)&&!(f.holes||[]).some((h)=>inside(p,h));
function closest(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1),0,1);return [a[0]+dx*t,a[1]+dy*t];}
function intersects(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);return x*y<=0&&z*w<=0&&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))+1e-8&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]))+1e-8;}
function hull(points){const p=[...points].sort((a,b)=>a[0]-b[0]||a[1]-b[1]),lo=[],hi=[];for(const q of p){while(lo.length>1&&cross(lo.at(-2),lo.at(-1),q)<=0)lo.pop();lo.push(q);}for(const q of p.toReversed()){while(hi.length>1&&cross(hi.at(-2),hi.at(-1),q)<=0)hi.pop();hi.push(q);}return lo.slice(0,-1).concat(hi.slice(0,-1));}
function expand(ring,margin){
  const ccw=ring.reduce((s,a,i)=>{const b=ring[(i+1)%ring.length];return s+a[0]*b[1]-b[0]*a[1];},0)>0;
  return ring.map((p,i)=>{const a=ring[(i+ring.length-1)%ring.length],b=ring[(i+1)%ring.length],u=dist(a,p),v=dist(p,b),sign=ccw?1:-1,n1=[(p[1]-a[1])/u*sign,-(p[0]-a[0])/u*sign],n2=[(b[1]-p[1])/v*sign,-(b[0]-p[0])/v*sign],nx=n1[0]+n2[0],ny=n1[1]+n2[1],n=Math.hypot(nx,ny)||1,scale=Math.min(margin*2,margin/Math.max(0.5,(nx*n2[0]+ny*n2[1])/n));return [p[0]+nx/n*scale,p[1]+ny/n*scale];});
}
function rectangle(b,margin=0){const c=Math.cos(b.angle||0),s=Math.sin(b.angle||0),w=b.width/2+margin,d=b.depth/2+margin;return [[-w,-d],[w,-d],[w,d],[-w,d]].map(([x,y])=>[b.x+x*c-y*s,b.y+x*s+y*c]);}
class Index{
  constructor(size=80){this.size=size;this.cells=new Map();}
  insert(item,b){for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++){const k=x+','+y;if(!this.cells.has(k))this.cells.set(k,[]);this.cells.get(k).push(item);}}
  query(b){const result=new Set();for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++)for(const item of this.cells.get(x+','+y)||[])result.add(item);return result;}
}
function context(snapshot,urban){
  const roads=new Index(),water=new Index(),tags=new Map((urban?.roadTags||[]).map((r)=>[r.id,r.tags]));
  for(const r of snapshot.roads||[]){if(/^(proposed|construction)$/.test(r.kind))continue;const width=resolveRoadWidth(r,tags.get(r.id.match(/^(way\/\d+)/)?.[1]||r.id)).width;for(let i=1;i<r.points.length;i++){const a=r.points[i-1],b=r.points[i],bounds=box([a,b]),pad=width/2+4;roads.insert({a,b,width,kind:r.kind},[bounds[0]-pad,bounds[1]-pad,bounds[2]+pad,bounds[3]+pad]);}}
  for(const a of snapshot.areas||[])if(a.kind==='water'&&a.polygon?.length>=3)water.insert(a,box(a.polygon));
  const wet=(p)=>[...water.query([p[0],p[1],p[0],p[1]])].some((f)=>inFeature(p,f));
  const nearRoad=(p,margin=0,publicOnly=false)=>[...roads.query([p[0],p[1],p[0],p[1]])].some((r)=>(!publicOnly||!/^service|footway|path|steps|cycleway|track$/.test(r.kind))&&dist(p,closest(p,r.a,r.b))<r.width/2+margin);
  const blocks=(a,b)=>{
    const bounds=box([a,b]);
    if([...roads.query(bounds)].some((r)=>! /^(service|footway|path|steps|cycleway|track)$/.test(r.kind)&&intersects(a,b,r.a,r.b)))return true;
    for(const f of water.query(bounds)){if(inFeature(a,f)||inFeature(b,f))return true;for(let i=0;i<f.polygon.length;i++)if(intersects(a,b,f.polygon[i],f.polygon[(i+1)%f.polygon.length]))return true;}
    return false;
  };
  return {roads,water,wet,nearRoad,blocks};
}

/** Nearby mapped data-centre halls share one illustrative campus boundary.
 * Public roads, water and different recognized operators prevent a merge.
 */
export function groupCampusBuildings(snapshot,buildings,options={}){
  const ctx=options.context||context(snapshot,options.urban),source=new Map((snapshot.buildings||[]).map((b)=>[b.id,b])),items=buildings.filter((b)=>b.kind==='data-center'&&b.source!=='infill').map((b)=>({...b,polygon:source.get(b.id)?.polygon||rectangle(b)})),parent=items.map((_,i)=>i);
  const find=(i)=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const operator=(b)=>(String(source.get(b.id)?.tags?.name||b.name||'').toLowerCase().match(/amazon|aws|google|microsoft|digital realty|equinix|vantage|qts|ntt|cyrusone|flexential|xai/)||[])[0]?.replace('amazon','aws');
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
    const a=items[i],b=items[j],ab=box(a.polygon),bb=box(b.polygon),gap=Math.hypot(Math.max(0,ab[0]-bb[2],bb[0]-ab[2]),Math.max(0,ab[1]-bb[3],bb[1]-ab[3]));
    if(gap>(options.campusGapM??65)||Math.hypot(a.x-b.x,a.y-b.y)>700||(operator(a)&&operator(b)&&operator(a)!==operator(b))||ctx.blocks([a.x,a.y],[b.x,b.y]))continue;
    parent[find(j)]=find(i);
  }
  const groups=new Map();items.forEach((b,i)=>{const root=find(i);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(b);});
  return [...groups.values()].map((bs)=>({id:'campus:'+bs.map((b)=>b.id).sort().join('+'),buildings:bs.map((b)=>b.id),polygon:expand(hull(bs.flatMap((b)=>b.polygon)),options.campusMarginM??8)}));
}

export function buildUrbanDetail(snapshot,heightAt,{detail='close',buildings=[],urban,...options}={}){
  if(typeof heightAt!=='function')throw new TypeError('buildUrbanDetail requires the rendered ground sampler');
  urban=urban||snapshot.urban||{};
  const ctx=context(snapshot,urban),groups=new Map(),source=new Map((snapshot.buildings||[]).map((b)=>[b.id,b])),budget=options.maxTriangles??(detail==='overview'?45000:160000);
  const stats={mappedSurfaces:0,parkingLots:0,parkingStripes:0,parkedCars:0,buildingPads:0,campuses:0,campusHalls:0,campusFences:0,gardenFences:0,entranceProps:0,benches:0,runways:0,taxiways:0,aprons:0,triangles:0,skippedBudget:0};
  const material=(name,color)=>{if(!groups.has(name))groups.set(name,{name,positions:[],normals:[],indices:[],color,category:0});return groups.get(name);};
  const concrete=material('urban-concrete','#aaa99e'),asphalt=material('urban-asphalt','#485055'),white=material('urban-white-paint','#e4e1d0'),yellow=material('urban-yellow-paint','#d5b64d'),metal=material('urban-fence-metal','#727d78'),wood=material('urban-garden-fence','#8e8069');
  const carPaint=[material('urban-car-blue','#58768a'),material('urban-car-cream','#c4c2ad'),material('urban-car-red','#9d6154')],parkedCars=[];
  function tri(mesh,points,lift=0.16,avoidRoad=false){
    if(stats.triangles>=budget){stats.skippedBudget++;return false;}
    const probes=[...points,[(points[0][0]+points[1][0]+points[2][0])/3,(points[0][1]+points[1][1]+points[2][1])/3]];
    if(probes.some((p)=>ctx.wet(p)||(avoidRoad&&ctx.nearRoad(p,0.4))))return false;
    const inTriangle=(p)=>{const signs=points.map((a,i)=>cross(a,points[(i+1)%3],p));return signs.every((v)=>v>=-1e-8)||signs.every((v)=>v<=1e-8);};
    for(const f of ctx.water.query(box(points))){
      if(f.polygon.some(inTriangle))return false;
      for(let i=0;i<f.polygon.length;i++)for(let j=0;j<3;j++)if(intersects(f.polygon[i],f.polygon[(i+1)%f.polygon.length],points[j],points[(j+1)%3]))return false;
    }
    if(avoidRoad)for(const r of ctx.roads.query(box(points))){
      if(inTriangle(r.a)||inTriangle(r.b))return false;
      for(let i=0;i<3;i++){const a=points[i],b=points[(i+1)%3];if(intersects(a,b,r.a,r.b)||Math.min(dist(r.a,closest(r.a,a,b)),dist(r.b,closest(r.b,a,b)))<r.width/2+0.4)return false;}
    }
    let vertices=points.map((p)=>{const h=heightAt(p[0],p[1]);return Number.isFinite(h)?[p[0],h+lift,-p[1]]:null;});if(vertices.some((p)=>!p))return false;
    if(cross(...points)<0)vertices=[vertices[0],vertices[2],vertices[1]];
    const [a,b,c]=vertices,u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n);if(length<1e-8)return false;
    const start=mesh.positions.length/3;for(const p of vertices){mesh.positions.push(...p);mesh.normals.push(...n.map((v)=>v/length));}mesh.indices.push(start,start+1,start+2);stats.triangles++;return true;
  }
  function polygon(mesh,feature,lift=0.16,avoidRoad=false){
    const {triangles}=triangulateWaterPolygon(feature,{shoreSimplificationM:0}),spacing=detail==='overview'?45:24,queue=[...triangles];let done=false;
    while(queue.length&&stats.triangles<budget){const t=queue.pop(),lengths=[dist(t[0],t[1]),dist(t[1],t[2]),dist(t[2],t[0])],i=lengths.indexOf(Math.max(...lengths));if(lengths[i]>spacing){const a=t[i],b=t[(i+1)%3],c=t[(i+2)%3],m=[(a[0]+b[0])/2,(a[1]+b[1])/2];queue.push([a,m,c],[m,b,c]);}else done=tri(mesh,t,lift,avoidRoad)||done;}
    if(queue.length)stats.skippedBudget++;return done;
  }
  function ribbon(mesh,a,b,width,lift=0.2,feature,avoidRoad=false){
    const len=dist(a,b);if(len<0.01)return;const nx=-(b[1]-a[1])/len*width/2,ny=(b[0]-a[0])/len*width/2,steps=Math.max(1,Math.ceil(len/20));
    for(let i=0;i<steps;i++){const p=[a[0]+(b[0]-a[0])*i/steps,a[1]+(b[1]-a[1])*i/steps],q=[a[0]+(b[0]-a[0])*(i+1)/steps,a[1]+(b[1]-a[1])*(i+1)/steps],quad=[[p[0]+nx,p[1]+ny],[p[0]-nx,p[1]-ny],[q[0]-nx,q[1]-ny],[q[0]+nx,q[1]+ny]];if(feature&&!quad.every((v)=>inFeature(v,feature)))continue;tri(mesh,[quad[0],quad[1],quad[2]],lift,avoidRoad);tri(mesh,[quad[0],quad[2],quad[3]],lift,avoidRoad);}
  }
  function quad3(mesh,points,doubleSided=false){
    if(stats.triangles+2>budget)return;const start=mesh.positions.length/3;for(const p of points){mesh.positions.push(p[0],p[1],-p[2]);mesh.normals.push(0,0,1);}mesh.indices.push(start,start+1,start+2,start,start+2,start+3);stats.triangles+=2;
    const a=[points[1][0]-points[0][0],points[1][1]-points[0][1],-points[1][2]+points[0][2]],b=[points[2][0]-points[0][0],points[2][1]-points[0][1],-points[2][2]+points[0][2]],n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],len=Math.hypot(...n)||1;
    for(let i=0;i<4;i++)for(let k=0;k<3;k++)mesh.normals[(start+i)*3+k]=n[k]/len;
    if(doubleSided&&stats.triangles+2<=budget){const back=mesh.positions.length/3;for(const p of points){mesh.positions.push(p[0],p[1],-p[2]);mesh.normals.push(...n.map((v)=>-v/len));}mesh.indices.push(back,back+2,back+1,back,back+3,back+2);stats.triangles+=2;}
  }
  function post(mesh,p,height,width=0.12){const h=heightAt(...p);if(!Number.isFinite(h))return;for(const [dx,dy] of [[1,0],[0,1]])quad3(mesh,[[p[0]-dx*width/2,h,p[1]-dy*width/2],[p[0]+dx*width/2,h,p[1]+dy*width/2],[p[0]+dx*width/2,h+height,p[1]+dy*width/2],[p[0]-dx*width/2,h+height,p[1]-dy*width/2]],true);}
  function fence(ring,height,mesh,garden=false,gatePoint=null){
    const estimated=ring.reduce((n,a,i)=>n+Math.ceil(dist(a,ring[(i+1)%ring.length])/(garden?6:8))*(garden?8:16),0);
    if(stats.triangles+estimated>budget)return false;
    let count=0;for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length],len=dist(a,b),steps=Math.max(1,Math.ceil(len/(garden?6:8)));
      for(let j=0;j<steps;j++){const p=[a[0]+(b[0]-a[0])*j/steps,a[1]+(b[1]-a[1])*j/steps],q=[a[0]+(b[0]-a[0])*(j+1)/steps,a[1]+(b[1]-a[1])*(j+1)/steps],mid=[(p[0]+q[0])/2,(p[1]+q[1])/2];if(ctx.wet(mid)||ctx.blocks(p,q)||ctx.nearRoad(mid,garden?1:3)||gatePoint&&dist(mid,gatePoint)<(garden?2.2:7))continue;
        const hp=heightAt(...p),hq=heightAt(...q);if(!Number.isFinite(hp)||!Number.isFinite(hq))continue;
        if(garden){const nx=-(q[1]-p[1])/dist(p,q)*0.05,ny=(q[0]-p[0])/dist(p,q)*0.05;quad3(mesh,[[p[0]-nx,hp,p[1]-ny],[p[0]+nx,hp,p[1]+ny],[p[0]+nx,hp+height,p[1]+ny],[p[0]-nx,hp+height,p[1]-ny]],true);}else post(mesh,p,height,0.16);
        for(const level of garden?[height*.7]:[height*0.35,height*0.85])quad3(mesh,[[p[0],hp+level,p[1]],[q[0],hq+level,q[1]],[q[0],hq+level+0.06,q[1]],[p[0],hp+level+0.06,p[1]]],true);count++;
      }
    }return count>0;
  }
  function cuboid(mesh,cx,cy,base,w,d,h,angle){
    const ring=rectangle({x:cx,y:cy,width:w,depth:d,angle}),lo=ring.map(([x,y])=>[x,base,y]),hi=ring.map(([x,y])=>[x,base+h,y]);
    quad3(mesh,[hi[0],hi[1],hi[2],hi[3]]);quad3(mesh,[lo[0],lo[3],lo[2],lo[1]]);
    for(let i=0;i<4;i++)quad3(mesh,[lo[i],lo[(i+1)%4],hi[(i+1)%4],hi[i]]);
  }
  function car(feature,x,y,angle,seed){
    if(stats.parkedCars>=(options.maxCars??320)||stats.triangles+48>budget)return;
    const ring=rectangle({x,y,width:1.75,depth:4.1,angle}),p=[x,y];if(!inFeature(p,feature)||!ring.every((q)=>inFeature(q,feature)&&!ctx.wet(q)&&!ctx.nearRoad(q,0.25))||ctx.nearRoad(p,0.5))return;
    const h=heightAt(x,y);if(!Number.isFinite(h))return;const paint=carPaint[seed%carPaint.length];cuboid(paint,x,y,h+0.4,1.75,4.1,0.55,angle);cuboid(asphalt,x,y,h+0.95,1.42,1.9,0.6,angle);
    const c=Math.cos(angle),s=Math.sin(angle);for(const side of [-1,1])for(const along of [-1.25,1.25]){const a=[x+c*side*0.88-s*(along-0.28),h+0.17,y+s*side*0.88+c*(along-0.28)],b=[x+c*side*0.88-s*(along+0.28),h+0.17,y+s*side*0.88+c*(along+0.28)];quad3(asphalt,[a,b,[b[0],h+0.67,b[2]],[a[0],h+0.67,a[2]]],true);}
    stats.parkedCars++;parkedCars.push({sourceId:feature.id,x,y,angle,width:1.75,depth:4.1});
  }
  function parkingPaint(feature){
    if(detail==='overview')return;const ring=feature.polygon;let angle=0,longest=0;for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],length=dist(a,b);if(length>longest){longest=length;angle=Math.atan2(b[1]-a[1],b[0]-a[0]);}}
    const c=Math.cos(angle),s=Math.sin(angle),local=ring.map(([x,y])=>[x*c+y*s,-x*s+y*c]),bounds=box(local),world=(x,y)=>[x*c-y*s,x*s+y*c];let count=0;
    let cars=0;for(let y=bounds[1]+1;y+5.2<bounds[3]-1;y+=16.4)for(let x=bounds[0]+1;x<bounds[2]-1;x+=2.6){
      if(count>=300||stats.parkingStripes>=7000)return;const a=world(x,y),b=world(x,y+5.2);if([a,b,world(x+0.2,y+2.6)].every((p)=>inFeature(p,feature))){ribbon(white,a,b,0.10,0.185,feature);count++;stats.parkingStripes++;}
      if(count%3===1&&cars<24){const p=world(x+1.3,y+2.6),before=stats.parkedCars;car(feature,p[0],p[1],angle,hash(feature.id+':'+count));if(stats.parkedCars>before)cars++;}
    }
  }
  // Reserve the shared-campus structure before optional large parking overlays.
  const campuses=groupCampusBuildings(snapshot,buildings,{...options,urban,context:ctx}),campusIds=new Set(campuses.flatMap((c)=>c.buildings));
  for(const campus of campuses){if(polygon(concrete,campus,0.12,true)){stats.campuses++;stats.campusHalls+=campus.buildings.length;}if(detail!=='overview'&&fence(campus.polygon,2.1,metal))stats.campusFences++;}
  // Concrete beneath mapped nonresidential structures takes precedence over cars,
  // parking paint and garden ornaments when a dense patch reaches its mesh budget.
  for(const b of buildings)if(b.source!=='infill'&&!campusIds.has(b.id)&&source.has(b.id)&&!/^(house|apartment)$/.test(b.kind)){
    const f=source.get(b.id);if(polygon(concrete,{...f,polygon:expand(f.polygon,Math.min(2,Math.max(1,b.width*0.015)))},0.12,true))stats.buildingPads++;
  }
  let airportFocus=null,longestRunway=0;
  function mappedSurfaces(){for(const f of urban.surfaces||[]){
    if(!f.polygon?.length)continue;const paved=polygon(f.kind==='apron'||f.kind==='paved'?concrete:asphalt,f,0.16);if(!paved)continue;stats.mappedSurfaces++;
    if(f.kind==='parking'){stats.parkingLots++;parkingPaint(f);}if(f.kind==='apron'){stats.aprons++;if(!airportFocus){const xs=f.polygon.map((p)=>p[0]),ys=f.polygon.map((p)=>p[1]);airportFocus={x:xs.reduce((a,b)=>a+b,0)/xs.length,y:ys.reduce((a,b)=>a+b,0)/ys.length,sourceId:f.id};}}
    if(f.kind==='runway'){stats.runways++;const bounds=box(f.polygon);if(Math.hypot(bounds[2]-bounds[0],bounds[3]-bounds[1])>longestRunway){longestRunway=Math.hypot(bounds[2]-bounds[0],bounds[3]-bounds[1]);airportFocus={x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2,sourceId:f.id};}}
  }}
  if(urban.airways?.length){
    const air=buildRoadSurface({roads:urban.airways.map((a)=>({...a,kind:'service'}))},heightAt,{detail,asphaltLiftM:0.18});
    for(const g of air.groups){if(stats.triangles+g.indices.length/3>budget){stats.skippedBudget++;continue;}const existing=asphalt,start=existing.positions.length/3;for(const p of g.positions)existing.positions.push(p);for(const n of g.normals)existing.normals.push(n);for(const index of g.indices)existing.indices.push(index+start);stats.triangles+=g.indices.length/3;}
    for(const airway of urban.airways){
      let distance=0;for(let i=1;i<airway.points.length;i++){const a=airway.points[i-1],b=airway.points[i],len=dist(a,b);if(airway.kind==='taxiway')ribbon(yellow,a,b,0.18,0.205);else for(let d=0;d<len;d+=30){if(Math.floor((distance+d)/30)%2===0){const end=Math.min(len,d+30),p=[a[0]+(b[0]-a[0])*d/len,a[1]+(b[1]-a[1])*d/len],q=[a[0]+(b[0]-a[0])*end/len,a[1]+(b[1]-a[1])*end/len];ribbon(white,p,q,0.6,0.205);}}distance+=len;}
      if(airway.kind==='runway'){stats.runways++;if(distance>longestRunway){longestRunway=distance;let remaining=distance/2,p=airway.points[0];for(let i=1;i<airway.points.length;i++){const a=airway.points[i-1],b=airway.points[i],len=dist(a,b);if(remaining<=len){p=[a[0]+(b[0]-a[0])*remaining/len,a[1]+(b[1]-a[1])*remaining/len];break;}remaining-=len;}airportFocus={x:p[0],y:p[1],sourceId:airway.id,lengthM:distance};}}else stats.taxiways++;
    }
  }
  mappedSurfaces();
  const occupied=new Index();for(const b of buildings){if(!Number.isFinite(b.x)||!Number.isFinite(b.y))continue;occupied.insert(b,box(rectangle(b)));}
  let gardenTriangles=0;
  for(const b of buildings){
    if(b.source==='infill'||campusIds.has(b.id)||!source.has(b.id))continue;
    const residential=/^(house|apartment)$/.test(b.kind);
    if(detail==='overview')continue;
    if(b.kind==='house'&&gardenTriangles<(options.maxGardenTriangles??32000)&&stats.gardenFences<(options.maxGardens??1000)&&Math.hypot(b.x,b.y)<(options.gardenRadiusM??1600)){
      const ring=rectangle(b,2.2),bounds=box(ring),neighbors=[...occupied.query(bounds)].filter((other)=>other.id!==b.id),safe=ring.every((p)=>!ctx.wet(p)&&!ctx.nearRoad(p,1)&&!neighbors.some((other)=>inside(p,rectangle(other,0.6))));
      if(safe){const gate=ring[0].map((v,k)=>(v+ring[1][k])/2),before=stats.triangles;if(fence(ring,0.95,wood,true,gate)){stats.gardenFences++;gardenTriangles+=stats.triangles-before;}}
    }else if(!residential&&stats.entranceProps<(options.maxEntranceProps??220)&&stats.triangles+64<=budget){
      const c=Math.cos(b.angle||0),s=Math.sin(b.angle||0),p=[b.x+s*(b.depth/2+1.1),b.y-c*(b.depth/2+1.1)];
      if(!ctx.wet(p)&&!ctx.nearRoad(p,1)){
        polygon(concrete,{polygon:rectangle({x:p[0],y:p[1],angle:b.angle,width:1.4,depth:2.3})},0.13,true);post(metal,p,0.85,0.18);stats.entranceProps++;
        if(/^(shop|mall|office|civic)$/.test(b.kind)){
          const q=[p[0]+c*1.25,p[1]+s*1.25],ring=rectangle({x:q[0],y:q[1],width:1.6,depth:0.45,angle:b.angle});
          if(ring.every((v)=>!ctx.wet(v)&&!ctx.nearRoad(v,0.5))){const h=heightAt(...q);if(Number.isFinite(h)){cuboid(wood,q[0],q[1],h+0.5,1.6,0.45,0.09,b.angle);for(const sign of [-1,1])cuboid(metal,q[0]+c*0.58*sign,q[1]+s*0.58*sign,h+0.13,0.10,0.36,0.37,b.angle);stats.benches++;}}
        }
      }
    }
  }
  const result=[...groups.values()].filter((g)=>g.indices.length);stats.materialGroups=result.length;
  return {groups:result,stats,campuses,airportFocus,parkedCars};
}
