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
function buildingFootprints(snapshot,buildings){
  const result=new Map((snapshot.buildings||[]).map((b)=>[b.id,b]));
  for(const b of buildings)if(!result.has(b.id)&&/^(illustrative-infill|infill)$/.test(b.source)&&Number.isFinite(b.x)&&Number.isFinite(b.y)&&b.width>0&&b.depth>0)result.set(b.id,{id:b.id,polygon:rectangle(b),source:'illustrative-infill'});
  return result;
}
function overlap(a,b){if(a.some((p)=>inside(p,b))||b.some((p)=>inside(p,a)))return true;for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)if(intersects(a[i],a[(i+1)%a.length],b[j],b[(j+1)%b.length]))return true;return false;}
class Index{
  constructor(size=80){this.size=size;this.cells=new Map();}
  insert(item,b){for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++){const k=x+','+y;if(!this.cells.has(k))this.cells.set(k,[]);this.cells.get(k).push(item);}}
  query(b){const result=new Set();for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++)for(const item of this.cells.get(x+','+y)||[])result.add(item);return result;}
}
function context(snapshot,urban){
  const roads=new Index(),water=new Index(),tags=new Map((urban?.roadTags||[]).map((r)=>[r.id,r.tags]));
  for(const r of snapshot.roads||[]){if(/^(proposed|construction)$/.test(r.kind))continue;const rt={...(r.tags||{}),...(tags.get(r.id.match(/^(way\/\d+)/)?.[1]||r.id)||{})},width=resolveRoadWidth(r,rt).width;for(let i=1;i<r.points.length;i++){const a=r.points[i-1],b=r.points[i],bounds=box([a,b]),pad=width/2+4;roads.insert({a,b,width,kind:r.kind,id:r.id,service:rt.service},[bounds[0]-pad,bounds[1]-pad,bounds[2]+pad,bounds[3]+pad]);}}
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

/** Safe, short illustrative house connections. They do not establish ownership or
 * surveyed entrances. Mapped driveways are retained as source paths, not redrawn.
 */
export function planHouseConnections(snapshot,buildings,{urban,context:provided,footprintIndex,sourceMap,maxDriveways=900,drivewayRadiusM=1600,residentialFocus={x:0,y:0}}={}){
  const ctx=provided||context(snapshot,urban),footprints=footprintIndex||new Index(),source=sourceMap||buildingFootprints(snapshot,buildings),result=[],byId=new Map(buildings.map((b)=>[b.id,b]));
  if(!footprintIndex)for(const b of source.values())if(b.polygon?.length>=3)footprints.insert(b,box(b.polygon));
  const corridor=(a,b,width)=>{const len=dist(a,b),nx=-(b[1]-a[1])/(len||1)*width/2,ny=(b[0]-a[0])/(len||1)*width/2;return [[a[0]+nx,a[1]+ny],[a[0]-nx,a[1]-ny],[b[0]-nx,b[1]-ny],[b[0]+nx,b[1]+ny]];};
  const clear=(a,b,width,id)=>{
    if(ctx.blocks(a,b))return false;const poly=corridor(a,b,width),bounds=box(poly);
    for(const f of footprints.query(bounds))if(f.id!==id&&overlap(poly,f.polygon))return false;
    for(const f of ctx.water.query(bounds))if(poly.some((p)=>inFeature(p,f))||overlap(poly,f.polygon)&&!poly.every((p)=>(f.holes||[]).some((h)=>inside(p,h))))return false;
    for(const r of ctx.roads.query(bounds))if(/^(motorway|trunk|primary|secondary)/.test(r.kind)&&(overlap(poly,corridor(r.a,r.b,r.width+1))))return false;
    return true;
  };
  const ordered=buildings.filter((b)=>b.kind==='house').sort((a,b)=>(a.x-residentialFocus.x)**2+(a.y-residentialFocus.y)**2-(b.x-residentialFocus.x)**2-(b.y-residentialFocus.y)**2||a.id.localeCompare(b.id));
  for(const b of ordered){
    if(result.length>=maxDriveways)break;if(b.kind!=='house'||!source.has(b.id)||Math.hypot(b.x-residentialFocus.x,b.y-residentialFocus.y)>drivewayRadiusM)continue;
    const center=[b.x,b.y],search=[b.x-b.width/2-36,b.y-b.depth/2-36,b.x+b.width/2+36,b.y+b.depth/2+36],candidates=[...ctx.roads.query(search)];let mapped=null,mappedDistance=Infinity;
    for(const r of candidates)if(r.service==='driveway'){
      const q=closest(center,r.a,r.b),distance=dist(q,center),polygon=source.get(b.id).polygon,edgeGap=Math.min(...polygon.map((p,i)=>dist(q,closest(q,p,polygon[(i+1)%polygon.length]))));
      if((inside(q,polygon)||edgeGap<3.5)&&distance<mappedDistance){mappedDistance=distance;mapped={houseId:b.id,source:'mapped',sourceId:r.id,width:r.width,points:[r.a,r.b]};}
    }
    if(mapped){result.push(mapped);continue;}
    let best=null,bestLength=Infinity;
    for(const r of candidates){
      if(!/^(residential|living_street|unclassified|service)$/.test(r.kind)||r.width>8||r.service==='parking_aisle')continue;
      const q=closest(center,r.a,r.b),d=dist(center,q);if(d<1)continue;const ux=(q[0]-b.x)/d,uy=(q[1]-b.y)/d,c=Math.cos(b.angle||0),s=Math.sin(b.angle||0),lx=ux*c+uy*s,ly=-ux*s+uy*c,t=Math.min(b.width/2/Math.max(Math.abs(lx),1e-8),b.depth/2/Math.max(Math.abs(ly),1e-8)),a=[b.x+ux*(t+0.15),b.y+uy*(t+0.15)],end=[q[0]-ux*(r.width/2-0.1),q[1]-uy*(r.width/2-0.1)],length=dist(a,end);
      if(length<0.7||length>35||length>=bestLength||!clear(a,end,2.7,b.id))continue;
      bestLength=length;const walkA=[a[0]-uy*2.2,a[1]+ux*2.2],walkB=[end[0]-uy*2.2,end[1]+ux*2.2];
      best={houseId:b.id,source:'illustrative',sourceId:r.id,width:2.7,points:[a,end],walk:clear(walkA,walkB,1,b.id)?[walkA,walkB]:null};
    }
    if(best)result.push(best);
  }
  for(const item of result){const b=byId.get(item.houseId),ring=rectangle(b,2.2),target=item.points.at(-1);let gate=null;
    for(let i=1;i<item.points.length&&!gate;i++)for(let j=0;j<ring.length;j++){
      const a=item.points[i-1],b=item.points[i],c=ring[j],d=ring[(j+1)%ring.length];if(!intersects(a,b,c,d))continue;const dx=b[0]-a[0],dy=b[1]-a[1],ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;if(Math.abs(den)>1e-8){const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den;gate=[a[0]+dx*t,a[1]+dy*t];break;}
    }
    item.gate=gate||ring.map((p,i)=>closest(target,p,ring[(i+1)%ring.length])).sort((a,b)=>dist(a,target)-dist(b,target))[0];
  }
  return result;
}

/** Illustrative backyards extend away from the nearest frontage. This reserves
 * usable land, not cadastral property: depth/width shrink around mapped neighbors,
 * other generated yards, roads, water, natural cover and recreation footprints.
 */
export function planBackyards(snapshot,buildings,{urban={},recreation={},context:provided,sourceMap,footprintIndex,connections=[],residentialFocus={x:0,y:0},maxGardens=1000,maxGardenTriangles=32000,maxYardCandidates=1600,gardenRadiusM=1600}={}){
  const ctx=provided||context(snapshot,urban),source=sourceMap||buildingFootprints(snapshot,buildings),footprints=footprintIndex||new Index(),protectedLand=new Index(160),claimed=new Index(),byConnection=new Map(connections.map((d)=>[d.houseId,d])),yards=[];
  if(!footprintIndex)for(const f of source.values())if(f.polygon?.length>=3)footprints.insert(f,box(f.polygon));
  for(const f of [...(snapshot.areas||[]).filter((f)=>['forest','farmland','orchard','park','industrial','scrub'].includes(f.kind)),...(urban.surfaces||[]),...(urban.airports||[]),...(recreation.features||[])])if(f.polygon?.length>=3)protectedLand.insert(f,box(f.polygon));
  const stats={examined:0,attempts:0,shrunk:0,blocked:0},limit=Math.min(maxGardens,Math.ceil(maxGardenTriangles/65)),ordered=buildings.filter((b)=>b.kind==='house'&&source.has(b.id)&&[b.x,b.y,b.width,b.depth].every(Number.isFinite)&&b.width>0&&b.depth>0).sort((a,b)=>(a.x-residentialFocus.x)**2+(a.y-residentialFocus.y)**2-(b.x-residentialFocus.x)**2-(b.y-residentialFocus.y)**2||a.id.localeCompare(b.id));
  const touches=(poly,f)=>poly.some((p)=>inFeature(p,f))||f.polygon.some((p)=>inside(p,poly))||poly.some((a,i)=>f.polygon.some((b,j)=>intersects(a,poly[(i+1)%poly.length],b,f.polygon[(j+1)%f.polygon.length])));
  const roadTouches=(poly,r)=>inside(r.a,poly)||inside(r.b,poly)||poly.some((p,i)=>dist(p,closest(p,r.a,r.b))<r.width/2+.65||intersects(p,poly[(i+1)%poly.length],r.a,r.b)||dist(r.a,closest(r.a,p,poly[(i+1)%poly.length]))<r.width/2+.65||dist(r.b,closest(r.b,p,poly[(i+1)%poly.length]))<r.width/2+.65);
  const clear=(poly,id)=>{const bounds=box(poly);if(poly.some((p)=>Math.abs(p[0])>(snapshot.radiusM||3300)-3||Math.abs(p[1])>(snapshot.radiusM||3300)-3))return false;
    for(const f of footprints.query(bounds))if(f.id!==id&&overlap(poly,f.polygon))return false;
    for(const f of claimed.query(bounds))if(overlap(poly,f.polygon))return false;
    for(const f of protectedLand.query(bounds))if(touches(poly,f))return false;
    for(const f of ctx.water.query(bounds))if(touches(poly,f))return false;
    for(const r of ctx.roads.query(bounds))if(roadTouches(poly,r))return false;
    return true;
  };
  for(const b of ordered){
    if(yards.length>=limit||stats.examined>=maxYardCandidates)break;if(Math.hypot(b.x-residentialFocus.x,b.y-residentialFocus.y)>gardenRadiusM)continue;stats.examined++;
    const connection=byConnection.get(b.id),center=[b.x,b.y];let target=null;
    if(connection)target=[...connection.points].sort((p,q)=>dist(q,center)-dist(p,center))[0];
    if(!target){let nearest=Infinity;for(const r of ctx.roads.query([b.x-85,b.y-85,b.x+85,b.y+85])){
      if(!/^(residential|living_street|unclassified|service|tertiary|secondary)$/.test(r.kind))continue;if(b.frontage?.roadId&&r.id!==b.frontage.roadId)continue;const p=closest(center,r.a,r.b),d=dist(p,center);if(d<nearest){nearest=d;target=p;}
    }}
    const angle=b.angle||0,defaultFront=[Math.sin(angle),-Math.cos(angle)],delta=target?[target[0]-b.x,target[1]-b.y]:defaultFront,len=Math.hypot(...delta)||1,front=[delta[0]/len,delta[1]/len],back=[-front[0],-front[1]],side=[-front[1],front[0]],footprint=source.get(b.id).polygon,project=(p,axis)=>(p[0]-b.x)*axis[0]+(p[1]-b.y)*axis[1],rear=Math.max(...footprint.map((p)=>project(p,back)))+.35,halfWidth=Math.max(...footprint.map((p)=>Math.abs(project(p,side)))),frontExtent=Math.max(...footprint.map((p)=>project(p,front))),desiredDepth=12+(hash(b.id+':yard-depth')%9),desiredWidth=halfWidth*2+5;
    const depths=[desiredDepth,12,9,6.5,4.5].filter((d,i,a)=>d<=desiredDepth&&a.indexOf(d)===i),widths=[desiredWidth,halfWidth*2+2,halfWidth*2,Math.max(5,halfWidth*1.5)].filter((w,i,a)=>a.indexOf(w)===i);let yard=null;
    for(const depth of depths){for(const width of widths){stats.attempts++;const at=(s,d)=>[b.x+side[0]*s+back[0]*(rear+d),b.y+side[1]*s+back[1]*(rear+d)],polygon=[at(-width/2,0),at(width/2,0),at(width/2,depth),at(-width/2,depth)];
      if(!clear(polygon,b.id))continue;const gateSign=connection&&project(connection.points[0],side)<0?-1:1,gate=at(gateSign*width/2,Math.min(1.5,depth*.3));
      yard={houseId:b.id,x:b.x,y:b.y,polygon,widthM:width,depthM:depth,desiredDepthM:desiredDepth,front,back,side,rearM:rear,origin:at(0,0),gate,drivewayGate:connection?.gate||null,fenceEdges:[[polygon[1],polygon[2]],[polygon[2],polygon[3]],[polygon[3],polygon[0]]],illustrative:true,shrunk:depth<desiredDepth||width<desiredWidth};
      if(connection){
        const connectionStart=[...connection.points].sort((a,b)=>dist(a,center)-dist(b,center))[0];
        for(const sign of [gateSign,-gateSign]){
          const trialGate=at(sign*width/2,Math.min(1.5,depth*.3)),outerSide=Math.max(halfWidth+.95,width/2+.3)*sign,a=[connectionStart[0]+front[0]*.6,connectionStart[1]+front[1]*.6],c=[b.x+side[0]*outerSide+front[0]*(frontExtent+.9),b.y+side[1]*outerSide+front[1]*(frontExtent+.9)],d=[b.x+side[0]*outerSide+back[0]*(rear+.65),b.y+side[1]*outerSide+back[1]*(rear+.65)];
          const path=[a,c,d,trialGate],safe=path.slice(1).every((q,i)=>{const p=path[i],size=dist(p,q),nx=-(q[1]-p[1])/(size||1)*.45,ny=(q[0]-p[0])/(size||1)*.45,poly=[[p[0]+nx,p[1]+ny],[p[0]-nx,p[1]-ny],[q[0]-nx,q[1]-ny],[q[0]+nx,q[1]+ny]],bounds=box(poly);return ![...footprints.query(bounds)].some((f)=>overlap(poly,f.polygon))&&![...ctx.water.query(bounds),...protectedLand.query(bounds)].some((f)=>touches(poly,f))&&![...claimed.query(bounds)].some((f)=>overlap(poly,f.polygon))&&![...ctx.roads.query(bounds)].some((r)=>!(r.id===connection.sourceId&&r.service==='driveway')&&roadTouches(poly,r));});
          if(safe){yard.gate=trialGate;yard.accessPath=path;break;}
        }
      }
      break;
    }if(yard)break;}
    if(yard){yards.push(yard);claimed.insert(yard,box(yard.polygon));if(yard.accessPath)for(let i=1;i<yard.accessPath.length;i++){const a=yard.accessPath[i-1],b=yard.accessPath[i],size=dist(a,b),nx=-(b[1]-a[1])/(size||1)*.45,ny=(b[0]-a[0])/(size||1)*.45,polygon=[[a[0]+nx,a[1]+ny],[a[0]-nx,a[1]-ny],[b[0]-nx,b[1]-ny],[b[0]+nx,b[1]+ny]];claimed.insert({polygon},box(polygon));}if(yard.shrunk)stats.shrunk++;}else stats.blocked++;
  }
  return {yards,stats};
}

/** Missing physical dimensions remain explicitly estimated display dimensions. */
export function infrastructureHeight(feature){
  const raw=String(feature.tags?.height||''),match=raw.match(/^\s*([\d.]+)/),mapped=match?Number(match[1])*(/ft|'/.test(raw)?0.3048:1):NaN;
  if(Number.isFinite(mapped)&&mapped>=2&&mapped<=100)return {height:mapped,heightSource:'osm:height'};
  const voltage=Number(String(feature.tags?.voltage||'').match(/\d+/)?.[0]||0),height=feature.kind==='traffic_signals'?5.2:feature.kind==='pole'||feature.kind==='minor_line'?10:voltage>=230000?45:voltage>=110000?35:30;
  return {height,heightSource:'illustrative infrastructure-class estimate'};
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

export const CAMPUS_PAD_LIFT_M=.42;

/** Illustrative service equipment stays inside the shared campus boundary. It
 * does not claim a surveyed substation, voltage, capacity or grid connection. */
export function planCampusSwitchyards(snapshot,buildings,campuses,{urban={},context:provided,footprintIndex,sourceMap,maxCampusSwitchyards=12,residentialFocus={x:0,y:0}}={}){
  const ctx=provided||context(snapshot,urban),source=sourceMap||buildingFootprints(snapshot,buildings),footprints=footprintIndex||new Index(),yards=[];
  if(!footprintIndex)for(const f of source.values())if(f.polygon?.length>=3)footprints.insert(f,box(f.polygon));
  const ordered=[...campuses].sort((a,b)=>{const p=box(a.polygon),q=box(b.polygon);return Math.hypot((p[0]+p[2])/2-residentialFocus.x,(p[1]+p[3])/2-residentialFocus.y)-Math.hypot((q[0]+q[2])/2-residentialFocus.x,(q[1]+q[3])/2-residentialFocus.y)||a.id.localeCompare(b.id);});
  const clear=(ring,campus)=>{
    if(!ring.every((p)=>inside(p,campus.polygon)))return false;
    const bounds=box(ring);
    for(const f of footprints.query(bounds))if(overlap(ring,f.polygon))return false;
    for(const f of ctx.water.query(bounds)){
      if(ring.some((p)=>inFeature(p,f))||f.polygon.some((p)=>inside(p,ring)))return false;
      for(const boundary of [f.polygon,...(f.holes||[])])for(let i=0;i<boundary.length;i++)for(let j=0;j<ring.length;j++)if(intersects(boundary[i],boundary[(i+1)%boundary.length],ring[j],ring[(j+1)%ring.length]))return false;
    }
    for(const r of ctx.roads.query(bounds)){
      const length=dist(r.a,r.b);if(!length)continue;
      const nx=-(r.b[1]-r.a[1])/length*(r.width/2+1),ny=(r.b[0]-r.a[0])/length*(r.width/2+1);
      if(overlap(ring,[[r.a[0]+nx,r.a[1]+ny],[r.a[0]-nx,r.a[1]-ny],[r.b[0]-nx,r.b[1]-ny],[r.b[0]+nx,r.b[1]+ny]]))return false;
    }
    return true;
  };
  for(const campus of ordered){
    if(yards.length>=clamp(maxCampusSwitchyards,0,24))break;
    const bounds=box(campus.polygon),large=campus.buildings.length>=3||(bounds[2]-bounds[0])*(bounds[3]-bounds[1])>14000;
    const ccw=campus.polygon.reduce((sum,a,i)=>{const b=campus.polygon[(i+1)%campus.polygon.length];return sum+a[0]*b[1]-b[0]*a[1];},0)>0;
    let placed=null;
    for(const width of large?[16,10.5]:[10.5]){
      for(let i=0;i<campus.polygon.length&&!placed;i++){
        const a=campus.polygon[i],b=campus.polygon[(i+1)%campus.polygon.length],length=dist(a,b),depth=5.4;if(length<width+3)continue;
        const dx=(b[0]-a[0])/length,dy=(b[1]-a[1])/length,sign=ccw?1:-1;
        for(const fraction of [.5,.25,.75]){
          const along=clamp(length*fraction,width/2+1.3,length-width/2-1.3),inset=depth/2+1.25,x=a[0]+dx*along-dy*inset*sign,y=a[1]+dy*along+dx*inset*sign,angle=Math.atan2(dy,dx),polygon=rectangle({x,y,width,depth,angle});
          // A clearance envelope keeps tall equipment away from halls, roads,
          // water edges and the fence, not just its centre point.
          if(!clear(rectangle({x,y,width:width+.8,depth:depth+.8,angle}),campus))continue;
          placed={id:campus.id+':switchyard',campusId:campus.id,x,y,width,depth,angle,polygon,transformerBanks:width>=16?2:1,switchgearCabinets:width>=16?3:2,illustrative:true};break;
        }
      }
      if(placed)break;
    }
    if(placed)yards.push(placed);
  }
  return yards;
}

export function buildUrbanDetail(snapshot,heightAt,{detail='close',buildings=[],urban,...options}={}){
  if(typeof heightAt!=='function')throw new TypeError('buildUrbanDetail requires the rendered ground sampler');
  urban=urban||snapshot.urban||{};
  const ctx=context(snapshot,urban),groups=new Map(),source=buildingFootprints(snapshot,buildings),budget=options.maxTriangles??(detail==='overview'?45000:160000);
  let drawLimit=budget;
  const sourceFootprints=detail==='overview'?null:new Index();if(sourceFootprints)for(const f of source.values())if(f.polygon?.length>=3)sourceFootprints.insert(f,box(f.polygon));
  const stats={mappedSurfaces:0,parkingLots:0,parkingStripes:0,parkedCars:0,buildingPads:0,campuses:0,campusHalls:0,campusFences:0,campusSwitchyards:0,transformerBanks:0,switchgearCabinets:0,campusEquipmentTriangles:0,gardenFences:0,gardenBeds:0,patios:0,hedges:0,mappedDriveways:0,illustrativeDriveways:0,frontWalks:0,sourcePowerLines:(urban.powerLines||[]).length,powerSpans:0,powerTowers:0,powerPoles:0,trafficSignals:0,infrastructureTriangles:0,entranceProps:0,benches:0,runways:0,taxiways:0,aprons:0,triangles:0,skippedBudget:0};
  const material=(name,color)=>{if(!groups.has(name))groups.set(name,{name,positions:[],normals:[],indices:[],color,category:0});return groups.get(name);};
  const concrete=material('urban-concrete','#aaa99e'),asphalt=material('urban-asphalt','#485055'),white=material('urban-white-paint','#e4e1d0'),yellow=material('urban-yellow-paint','#d5b64d'),metal=material('urban-fence-metal','#727d78'),wood=material('urban-garden-fence','#8e8069');
  const carPaint=[material('urban-car-blue','#58768a'),material('urban-car-cream','#c4c2ad'),material('urban-car-red','#9d6154')],parkedCars=[],infrastructure=[],wireSpans=[],gardens=[],switchyards=[];
  const hedge=material('urban-garden-green','#637c4d');hedge.category=1;
  const signalGreen=material('urban-signal-green','#57946a');
  function tri(mesh,points,lift=0.16,avoidRoad=false){
    if(stats.triangles>=drawLimit){stats.skippedBudget++;return false;}
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
    while(queue.length&&stats.triangles<drawLimit){const t=queue.pop(),lengths=[dist(t[0],t[1]),dist(t[1],t[2]),dist(t[2],t[0])],i=lengths.indexOf(Math.max(...lengths));if(lengths[i]>spacing){const a=t[i],b=t[(i+1)%3],c=t[(i+2)%3],m=[(a[0]+b[0])/2,(a[1]+b[1])/2];queue.push([a,m,c],[m,b,c]);}else done=tri(mesh,t,lift,avoidRoad)||done;}
    if(queue.length)stats.skippedBudget++;return done;
  }
  function ribbon(mesh,a,b,width,lift=0.2,feature,avoidRoad=false){
    const len=dist(a,b);if(len<0.01)return;const nx=-(b[1]-a[1])/len*width/2,ny=(b[0]-a[0])/len*width/2,steps=Math.max(1,Math.ceil(len/20));
    for(let i=0;i<steps;i++){const p=[a[0]+(b[0]-a[0])*i/steps,a[1]+(b[1]-a[1])*i/steps],q=[a[0]+(b[0]-a[0])*(i+1)/steps,a[1]+(b[1]-a[1])*(i+1)/steps],quad=[[p[0]+nx,p[1]+ny],[p[0]-nx,p[1]-ny],[q[0]-nx,q[1]-ny],[q[0]+nx,q[1]+ny]];if(feature&&!quad.every((v)=>inFeature(v,feature)))continue;tri(mesh,[quad[0],quad[1],quad[2]],lift,avoidRoad);tri(mesh,[quad[0],quad[2],quad[3]],lift,avoidRoad);}
  }
  function quad3(mesh,points,doubleSided=false){
    if(stats.triangles+2>drawLimit)return;const start=mesh.positions.length/3;for(const p of points){mesh.positions.push(p[0],p[1],-p[2]);mesh.normals.push(0,0,1);}mesh.indices.push(start,start+1,start+2,start,start+2,start+3);stats.triangles+=2;
    const a=[points[1][0]-points[0][0],points[1][1]-points[0][1],-points[1][2]+points[0][2]],b=[points[2][0]-points[0][0],points[2][1]-points[0][1],-points[2][2]+points[0][2]],n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],len=Math.hypot(...n)||1;
    for(let i=0;i<4;i++)for(let k=0;k<3;k++)mesh.normals[(start+i)*3+k]=n[k]/len;
    if(doubleSided&&stats.triangles+2<=drawLimit){const back=mesh.positions.length/3;for(const p of points){mesh.positions.push(p[0],p[1],-p[2]);mesh.normals.push(...n.map((v)=>-v/len));}mesh.indices.push(back,back+2,back+1,back,back+3,back+2);stats.triangles+=2;}
  }
  function post(mesh,p,height,width=0.12,lift=0){const ground=heightAt(...p),h=ground+lift;if(!Number.isFinite(ground))return;for(const [dx,dy] of [[1,0],[0,1]])quad3(mesh,[[p[0]-dx*width/2,h,p[1]-dy*width/2],[p[0]+dx*width/2,h,p[1]+dy*width/2],[p[0]+dx*width/2,h+height,p[1]+dy*width/2],[p[0]-dx*width/2,h+height,p[1]-dy*width/2]],true);}
  function fence(ring,height,mesh,garden=false,gatePoint=null,lift=0){
    const bounds=box(ring),focus=options.residentialFocus||{x:0,y:0},distant=!garden&&Math.hypot((bounds[0]+bounds[2])/2-focus.x,(bounds[1]+bounds[3])/2-focus.y)>850,spacing=garden?6:distant?16:8,flatPosts=garden||distant,rails=garden||distant?[height*.7]:[height*.35,height*.85];
    const estimated=ring.reduce((n,a,i)=>n+Math.ceil(dist(a,ring[(i+1)%ring.length])/spacing)*((flatPosts?4:8)+rails.length*4),0);
    if(stats.triangles+estimated>budget)return false;
    let count=0;for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length],len=dist(a,b),steps=Math.max(1,Math.ceil(len/spacing));
      for(let j=0;j<steps;j++){const p=[a[0]+(b[0]-a[0])*j/steps,a[1]+(b[1]-a[1])*j/steps],q=[a[0]+(b[0]-a[0])*(j+1)/steps,a[1]+(b[1]-a[1])*(j+1)/steps],mid=[(p[0]+q[0])/2,(p[1]+q[1])/2],gates=gatePoint?(Array.isArray(gatePoint[0])?gatePoint:[gatePoint]):[];if(ctx.wet(mid)||ctx.blocks(p,q)||ctx.nearRoad(mid,garden?1:3)||gates.some((g)=>dist(g,closest(g,p,q))<(garden?1.8:7)))continue;
        const groundP=heightAt(...p),groundQ=heightAt(...q),hp=groundP+lift,hq=groundQ+lift;if(!Number.isFinite(groundP)||!Number.isFinite(groundQ))continue;
        if(flatPosts){const nx=-(q[1]-p[1])/dist(p,q)*0.05,ny=(q[0]-p[0])/dist(p,q)*0.05;quad3(mesh,[[p[0]-nx,hp,p[1]-ny],[p[0]+nx,hp,p[1]+ny],[p[0]+nx,hp+height,p[1]+ny],[p[0]-nx,hp+height,p[1]-ny]],true);}else post(mesh,p,height,0.16,lift);
        for(const level of rails)quad3(mesh,[[p[0],hp+level,p[1]],[q[0],hq+level,q[1]],[q[0],hq+level+0.06,q[1]],[p[0],hp+level+0.06,p[1]]],true);count++;
      }
    }return count>0;
  }
  function cuboid(mesh,cx,cy,base,w,d,h,angle){
    const ring=rectangle({x:cx,y:cy,width:w,depth:d,angle}),lo=ring.map(([x,y])=>[x,base,y]),hi=ring.map(([x,y])=>[x,base+h,y]);
    quad3(mesh,[hi[0],hi[1],hi[2],hi[3]]);quad3(mesh,[lo[0],lo[3],lo[2],lo[1]]);
    for(let i=0;i<4;i++)quad3(mesh,[lo[i],lo[(i+1)%4],hi[(i+1)%4],hi[i]]);
  }
  function backyardFence(yard){
    const height=1.25+(hash(yard.houseId+':fence')%25)/100,before=stats.triangles,sections=yard.fenceEdges.reduce((n,[a,b])=>n+Math.ceil(dist(a,b)/8)+2,0);
    if(stats.triangles+sections*8+12>drawLimit)return false;
    for(const [a,b] of yard.fenceEdges){const len=dist(a,b),gx=yard.gate[0]-a[0],gy=yard.gate[1]-a[1],along=(gx*(b[0]-a[0])+gy*(b[1]-a[1]))/(len||1),onGate=dist(yard.gate,closest(yard.gate,a,b))<.01,cut=onGate?[Math.max(0,along-.7),Math.min(len,along+.7)]:null,ranges=cut?[[0,cut[0]],[cut[1],len]]:[[0,len]];
      for(const [start,end] of ranges){if(end-start<.1)continue;const steps=Math.ceil((end-start)/8);for(let i=0;i<steps;i++){
        const t=(start+(end-start)*i/steps)/len,u=(start+(end-start)*(i+1)/steps)/len,p=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],q=[a[0]+(b[0]-a[0])*u,a[1]+(b[1]-a[1])*u],hp=heightAt(...p),hq=heightAt(...q);if(!Number.isFinite(hp)||!Number.isFinite(hq))continue;
        // Broad wooden panels make the three-sided boundary readable. Only panel
        // ends receive small posts; the budget goes to usable yards, not pickets.
        quad3(wood,[[p[0],hp+.1,p[1]],[q[0],hq+.1,q[1]],[q[0],hq+height-.05,q[1]],[p[0],hp+height-.05,p[1]]],true);
        const nx=-(q[1]-p[1])/dist(p,q)*.055,ny=(q[0]-p[0])/dist(p,q)*.055;quad3(wood,[[p[0]-nx,hp,p[1]-ny],[p[0]+nx,hp,p[1]+ny],[p[0]+nx,hp+height,p[1]+ny],[p[0]-nx,hp+height,p[1]-ny]],true);
      }}
    }return stats.triangles>before;
  }
  function beam(mesh,a,b,width){
    const dx=b[0]-a[0],dz=b[2]-a[2],len=Math.hypot(dx,dz),nx=len?-dz/len*width/2:width/2,nz=len?dx/len*width/2:0;
    if(Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2])<0.01)return;
    quad3(mesh,[[a[0]+nx,a[1],a[2]+nz],[a[0]-nx,a[1],a[2]-nz],[b[0]-nx,b[1],b[2]-nz],[b[0]+nx,b[1],b[2]+nz]],true);
  }
  function campusEquipment(campuses){
    if(detail==='overview')return;
    const planned=planCampusSwitchyards(snapshot,buildings,campuses,{...options,urban,context:ctx,footprintIndex:sourceFootprints,sourceMap:source});
    for(const yard of planned){
      const probes=[...yard.polygon,[yard.x,yard.y],...yard.polygon.map((p,i)=>{const q=yard.polygon[(i+1)%4];return [(p[0]+q[0])/2,(p[1]+q[1])/2];})],heights=probes.map((p)=>heightAt(...p));
      if(!heights.every(Number.isFinite))continue;
      const low=Math.min(...heights),high=Math.max(...heights),estimate=yard.transformerBanks===2?1500:1000;
      if(high-low>1.2||stats.triangles+estimate>budget||stats.campusEquipmentTriangles+estimate>(options.maxCampusEquipmentTriangles??16000))continue;
      const before=stats.triangles,equipment=material('urban-electrical-equipment','#829196'),c=Math.cos(yard.angle),s=Math.sin(yard.angle),level=high+CAMPUS_PAD_LIFT_M+.22;
      const at=(x,y)=>[yard.x+x*c-y*s,yard.y+x*s+y*c];
      const solid=(paint,x,y,z,w,d,h,rotation=0)=>{const p=at(x,y);cuboid(paint,p[0],p[1],level+z,w,d,h,yard.angle+rotation);};
      const conductor=(a,b,width=.09)=>{const p=at(a[0],a[2]),q=at(b[0],b[2]);beam(equipment,[p[0],level+a[1],p[1]],[q[0],level+b[1],q[1]],width);};
      // A level plinth covers the actual sloping ground; heights already include
      // the scene's ellipsoid/DEM offset, so no second +4m adjustment is applied.
      cuboid(concrete,yard.x,yard.y,low+CAMPUS_PAD_LIFT_M-.03,yard.width,yard.depth,high-low+.25,yard.angle);
      const banks=yard.transformerBanks===2?[-yard.width*.27,0]:[-yard.width*.23];
      for(const x of banks){
        solid(equipment,x,0,0,2.1,2.7,2.15);solid(equipment,x,0,2.15,2.3,2.9,.12);
        // Visible radiator fins and three ceramic bushing stacks distinguish an
        // oil transformer from another anonymous utility cabinet.
        for(const side of [-1,1])for(const y of [-.84,-.28,.28,.84])solid(asphalt,x+side*1.25,y,.32,.32,.42,1.55);
        for(const [phase,dx] of [-.65,0,.65].entries()){
          solid(asphalt,x+dx,.1,2.27,.10,.10,.76);
          for(let disc=0;disc<3;disc++)solid(white,x+dx,.1,2.38+disc*.19,.30,.30,.07,Math.PI/4);
          conductor([x+dx,3.04,.1],[x+dx,3.48,(phase-1)*.8],.065);
        }
      }
      for(const side of [-1,1]){
        const x=side*(yard.width/2-.75);
        solid(equipment,x,1.65,0,.18,.18,3.8);solid(equipment,x,.1,3.13,.18,3.55,.16);
        for(const y of [-.8,0,.8]){
          solid(asphalt,x,y,3.29,.09,.09,.24);
          for(let disc=0;disc<2;disc++)solid(white,x,y,3.31+disc*.12,.25,.25,.055,Math.PI/4);
        }
      }
      for(const y of [-.8,0,.8])conductor([-yard.width/2+.75,3.55,y],[yard.width/2-.75,3.55,y],.10);
      for(let i=0;i<yard.switchgearCabinets;i++){
        const x=yard.width*.36,y=(i-(yard.switchgearCabinets-1)/2)*1.15;
        solid(equipment,x,y,0,.85,.95,1.85);solid(asphalt,x,y-.485,.19,.67,.025,1.45);
        solid(yellow,x,y-.505,1.05,.26,.025,.27);
      }
      const triangles=stats.triangles-before;
      stats.campusSwitchyards++;stats.transformerBanks+=yard.transformerBanks;stats.switchgearCabinets+=yard.switchgearCabinets;stats.campusEquipmentTriangles+=triangles;
      switchyards.push({...yard,groundMinHeight:low,groundMaxHeight:high,equipmentBaseHeight:level,padLiftM:CAMPUS_PAD_LIFT_M,triangles});
    }
  }
  function mappedInfrastructure(){
    const startTriangles=stats.triangles,limit=Math.min(budget,startTriangles+(options.maxInfrastructureTriangles??28000)),hardwareLimit=startTriangles+(limit-startTriangles)*.55,nodeKey=(x,y)=>Math.round(x*5)+','+Math.round(y*5),nodes=urban.infrastructureNodes||[],nodeMap=new Map(nodes.filter((n)=>n.kind!=='traffic_signals').map((n)=>[nodeKey(n.x,n.y),n]));
    const sorted=[...nodes].sort((a,b)=>({tower:0,traffic_signals:1,pole:2}[a.kind]-{tower:0,traffic_signals:1,pole:2}[b.kind])||Math.hypot(a.x,a.y)-Math.hypot(b.x,b.y)||a.id.localeCompare(b.id));
    for(const node of sorted){
      const overview=detail==='overview',far=Math.hypot(node.x,node.y)>1600;if(overview&&node.kind!=='tower')continue;
      if(node.kind==='traffic_signals'&&stats.trafficSignals>=(options.maxTrafficSignals??200)||node.kind==='pole'&&stats.powerPoles>=(options.maxPowerPoles??500))continue;
      const cost=node.kind==='tower'?160:node.kind==='traffic_signals'?72:20;if(stats.triangles+cost>hardwareLimit)continue;
      const {height,heightSource}=infrastructureHeight(node),base=heightAt(node.x,node.y);if(!Number.isFinite(base))continue;
      if(node.kind==='tower'){
        const levels=overview||far?2:4,w=Math.min(5,height*.11),at=(side,f)=>[node.x+side[0]*(w*(1-f)+.35),base+height*f,node.y+side[1]*(w*(1-f)+.35)],corners=[[-1,-1],[1,-1],[1,1],[-1,1]];
        for(let i=0;i<4;i++)beam(metal,at(corners[i],0),at(corners[i],1),.14);
        for(let j=0;j<levels;j++)for(let i=0;i<4;i++){
          const f=j/levels,g=(j+1)/levels;beam(metal,at(corners[i],f),at(corners[(i+1)%4],g),.09);
          if(!overview&&!far)beam(metal,at(corners[(i+1)%4],f),at(corners[i],g),.09);
        }
        for(const f of [.68,.88])beam(metal,[node.x-w*1.6,base+height*f,node.y],[node.x+w*1.6,base+height*f,node.y],.23);
        stats.powerTowers++;
      }else if(node.kind==='pole'){
        post(wood,[node.x,node.y],height,.26);beam(wood,[node.x-1.1,base+height*.91,node.y],[node.x+1.1,base+height*.91,node.y],.16);stats.powerPoles++;
      }else{
        let road=null,nearest=Infinity;
        for(const r of ctx.roads.query([node.x-25,node.y-25,node.x+25,node.y+25])){const d=dist([node.x,node.y],closest([node.x,node.y],r.a,r.b));if(d<nearest&&!/footway|path|steps|cycleway/.test(r.kind)){nearest=d;road=r;}}
        const angle=road?Math.atan2(road.b[1]-road.a[1],road.b[0]-road.a[0]):0,nx=-Math.sin(angle),ny=Math.cos(angle),offset=road?road.width/2+.65:0,p=[node.x+nx*offset,node.y+ny*offset],poleBase=heightAt(...p);if(!Number.isFinite(poleBase))continue;
        post(metal,p,height,.18);beam(metal,[p[0],poleBase+height,p[1]],[node.x,base+height,node.y],.16);
        cuboid(asphalt,node.x,node.y,base+height-1,.34,.28,.95,angle+Math.PI/2);
        for(const [i,paint] of [carPaint[2],yellow,signalGreen].entries())cuboid(paint,node.x+Math.cos(angle)*.18,node.y+Math.sin(angle)*.18,base+height-.28-i*.27,.17,.10,.16,angle+Math.PI/2);
        stats.trafficSignals++;
      }
      infrastructure.push({id:node.id,kind:node.kind,x:node.x,y:node.y,height,heightSource});
    }
    const lines=[...(urban.powerLines||[])].sort((a,b)=>Math.min(...a.points.map((p)=>Math.hypot(...p)))-Math.min(...b.points.map((p)=>Math.hypot(...p)))||a.id.localeCompare(b.id));
    for(const line of lines){if(detail==='overview'&&line.kind==='minor_line')continue;
      for(let i=1;i<line.points.length;i++){
        if(stats.powerSpans>=(options.maxPowerSpans??800))break;
        const a=line.points[i-1],b=line.points[i],len=dist(a,b);if(len<1)continue;const steps=detail==='overview'?4:Math.min(10,Math.max(3,Math.ceil(len/35))),conductors=detail==='overview'?[0]:[-1,0,1],cost=steps*conductors.length*4;
        if(stats.triangles+cost>limit)continue;
        const groundA=heightAt(...a),groundB=heightAt(...b);if(!Number.isFinite(groundA)||!Number.isFinite(groundB))continue;
        const hA=groundA+infrastructureHeight(nodeMap.get(nodeKey(...a))||line).height*.9,hB=groundB+infrastructureHeight(nodeMap.get(nodeKey(...b))||line).height*.9,sag=Math.min(line.kind==='minor_line'?3.5:10,len*.035),nx=-(b[1]-a[1])/len,ny=(b[0]-a[0])/len,span=[];
        for(let j=0;j<=steps;j++){const t=j/steps,x=a[0]+(b[0]-a[0])*t,y=a[1]+(b[1]-a[1])*t,ground=heightAt(x,y),height=hA*(1-t)+hB*t-4*sag*t*(1-t);span.push([x,y,Number.isFinite(ground)?Math.max(height,ground+(line.kind==='minor_line'?4.5:9)):height]);}
        for(const conductor of conductors)for(let j=1;j<span.length;j++){const offset=conductor*(line.kind==='minor_line'?.75:2.4),p=span[j-1],q=span[j];beam(asphalt,[p[0]+nx*offset,p[2],p[1]+ny*offset],[q[0]+nx*offset,q[2],q[1]+ny*offset],line.kind==='minor_line'?.07:.10);}
        wireSpans.push({sourceId:line.id,points:span,estimatedSagM:sag});stats.powerSpans++;
      }
    }
    stats.infrastructureTriangles=stats.triangles-startTriangles;
  }
  function car(feature,x,y,angle,seed){
    if(stats.parkedCars>=(options.maxCars??320)||stats.triangles+48>budget)return;
    const scale=.76,width=1.75*scale,depth=4.1*scale,ring=rectangle({x,y,width,depth,angle}),p=[x,y];if(!inFeature(p,feature)||!ring.every((q)=>inFeature(q,feature)&&!ctx.wet(q)&&!ctx.nearRoad(q,0.25))||ctx.nearRoad(p,0.5))return;
    const h=heightAt(x,y);if(!Number.isFinite(h))return;const paint=carPaint[seed%carPaint.length];cuboid(paint,x,y,h+0.4*scale,width,depth,0.55*scale,angle);cuboid(asphalt,x,y,h+0.95*scale,1.42*scale,1.9*scale,0.6*scale,angle);
    const c=Math.cos(angle),s=Math.sin(angle);for(const side of [-1,1])for(const along of [-1.25,1.25]){const a=[x+(c*side*0.88-s*(along-0.28))*scale,h+0.17*scale,y+(s*side*0.88+c*(along-0.28))*scale],b=[x+(c*side*0.88-s*(along+0.28))*scale,h+0.17*scale,y+(s*side*0.88+c*(along+0.28))*scale];quad3(asphalt,[a,b,[b[0],h+0.67*scale,b[2]],[a[0],h+0.67*scale,a[2]]],true);}
    stats.parkedCars++;parkedCars.push({sourceId:feature.id,x,y,angle,width,depth});
  }
  function parkingPaint(feature){
    if(detail==='overview')return;const ring=feature.polygon;let angle=0,longest=0;for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],length=dist(a,b);if(length>longest){longest=length;angle=Math.atan2(b[1]-a[1],b[0]-a[0]);}}
    const c=Math.cos(angle),s=Math.sin(angle),local=ring.map(([x,y])=>[x*c+y*s,-x*s+y*c]),bounds=box(local),world=(x,y)=>[x*c-y*s,x*s+y*c];let count=0;
    let cars=0;for(let y=bounds[1]+1;y+5.2<bounds[3]-1;y+=16.4)for(let x=bounds[0]+1;x<bounds[2]-1;x+=2.6){
      if(count>=300||stats.parkingStripes>=7000||stats.triangles+2>budget)return;const a=world(x,y),b=world(x,y+5.2);if([a,b,world(x+0.2,y+2.6)].every((p)=>inFeature(p,feature))){const before=stats.triangles;ribbon(white,a,b,0.10,0.185,feature);if(stats.triangles>before){count++;stats.parkingStripes++;}}
      if(count%3===1&&cars<24){const p=world(x+1.3,y+2.6),before=stats.parkedCars;car(feature,p[0],p[1],angle,hash(feature.id+':'+count));if(stats.parkedCars>before)cars++;}
    }
  }
  // Reserve the shared-campus structure before optional large parking overlays.
  const campuses=groupCampusBuildings(snapshot,buildings,{...options,urban,context:ctx}),campusIds=new Set(campuses.flatMap((c)=>c.buildings));
  for(const campus of campuses){if(polygon(concrete,campus,CAMPUS_PAD_LIFT_M,true)){stats.campuses++;stats.campusHalls+=campus.buildings.length;}if(detail!=='overview'&&fence(campus.polygon,2.1,metal,false,null,CAMPUS_PAD_LIFT_M))stats.campusFences++;}
  // Concrete beneath nonresidential structures takes precedence over cars,
  // parking paint and garden ornaments when a dense patch reaches its mesh budget.
  for(const b of buildings)if(!campusIds.has(b.id)&&source.has(b.id)&&!/^(house|apartment)$/.test(b.kind)){
    const f=source.get(b.id);if(polygon(concrete,{...f,polygon:expand(f.polygon,Math.min(2,Math.max(1,b.width*0.015)))},0.12,true))stats.buildingPads++;
  }
  campusEquipment(campuses);
  mappedInfrastructure();
  const driveways=detail==='overview'?[]:planHouseConnections(snapshot,buildings,{...options,urban,context:ctx,sourceMap:source,footprintIndex:sourceFootprints});
  for(const driveway of driveways){
    if(driveway.source==='mapped'){stats.mappedDriveways++;continue;}
    const before=stats.triangles;ribbon(asphalt,...driveway.points,driveway.width,0.22);if(stats.triangles>before)stats.illustrativeDriveways++;
    if(driveway.walk){const beforeWalk=stats.triangles;ribbon(concrete,...driveway.walk,1,0.23);if(stats.triangles>beforeWalk)stats.frontWalks++;}
  }
  const yardPlan=detail==='overview'?{yards:[],stats:{examined:0,attempts:0,shrunk:0,blocked:0}}:planBackyards(snapshot,buildings,{...options,urban,context:ctx,sourceMap:source,footprintIndex:sourceFootprints,connections:driveways,maxGardenTriangles:Math.min(options.maxGardenTriangles??32000,budget)}),yardByHouse=new Map(yardPlan.yards.map((yard)=>[yard.houseId,yard]));
  stats.backyardsPlanned=yardPlan.yards.length;stats.shrunkBackyards=0;stats.backyardAreaM2=0;
  localProps();
  let airportFocus=null,longestRunway=0;
  function mappedSurfaces(){const parking=[];for(const f of urban.surfaces||[]){
    if(!f.polygon?.length)continue;const paved=polygon(f.kind==='apron'||f.kind==='paved'?concrete:asphalt,f,0.16);if(!paved)continue;stats.mappedSurfaces++;
    if(f.kind==='parking'){stats.parkingLots++;parking.push(f);}if(f.kind==='apron'){stats.aprons++;if(!airportFocus){const xs=f.polygon.map((p)=>p[0]),ys=f.polygon.map((p)=>p[1]);airportFocus={x:xs.reduce((a,b)=>a+b,0)/xs.length,y:ys.reduce((a,b)=>a+b,0)/ys.length,sourceId:f.id};}}
    if(f.kind==='runway'){stats.runways++;const bounds=box(f.polygon);if(Math.hypot(bounds[2]-bounds[0],bounds[3]-bounds[1])>longestRunway){longestRunway=Math.hypot(bounds[2]-bounds[0],bounds[3]-bounds[1]);airportFocus={x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2,sourceId:f.id};}}
  }for(const f of parking)parkingPaint(f);}
  if(urban.airways?.length){
    const air=buildRoadSurface({roads:urban.airways.map((a)=>({...a,kind:'service'}))},heightAt,{detail,asphaltLiftM:0.18});
    for(const g of air.groups){if(stats.triangles+g.indices.length/3>budget){stats.skippedBudget++;continue;}const existing=asphalt,start=existing.positions.length/3;for(const p of g.positions)existing.positions.push(p);for(const n of g.normals)existing.normals.push(n);for(const index of g.indices)existing.indices.push(index+start);stats.triangles+=g.indices.length/3;}
    for(const airway of urban.airways){
      let distance=0;for(let i=1;i<airway.points.length;i++){const a=airway.points[i-1],b=airway.points[i],len=dist(a,b);if(airway.kind==='taxiway')ribbon(yellow,a,b,0.18,0.205);else for(let d=0;d<len;d+=30){if(Math.floor((distance+d)/30)%2===0){const end=Math.min(len,d+30),p=[a[0]+(b[0]-a[0])*d/len,a[1]+(b[1]-a[1])*d/len],q=[a[0]+(b[0]-a[0])*end/len,a[1]+(b[1]-a[1])*end/len];ribbon(white,p,q,0.6,0.205);}}distance+=len;}
      if(airway.kind==='runway'){stats.runways++;if(distance>longestRunway){longestRunway=distance;let remaining=distance/2,p=airway.points[0];for(let i=1;i<airway.points.length;i++){const a=airway.points[i-1],b=airway.points[i],len=dist(a,b);if(remaining<=len){p=[a[0]+(b[0]-a[0])*remaining/len,a[1]+(b[1]-a[1])*remaining/len];break;}remaining-=len;}airportFocus={x:p[0],y:p[1],sourceId:airway.id,lengthM:distance};}}else stats.taxiways++;
    }
  }
  mappedSurfaces();
  function localProps(){
  if(detail==='overview')return;
  function gardenDetail(b,yard){
    if(stats.gardenBeds>=(options.maxGardenExtras??250)||stats.triangles+50>drawLimit)return;
    const at=(s,d)=>[yard.origin[0]+yard.side[0]*s+yard.back[0]*d,yard.origin[1]+yard.side[1]*s+yard.back[1]*d],angle=Math.atan2(yard.side[1],yard.side[0]);
    const safe=(ring)=>ring.every((p)=>inside(p,yard.polygon)&&!ctx.wet(p)&&!ctx.nearRoad(p,.5))&&![...sourceFootprints.query(box(ring))].some((f)=>overlap(ring,f.polygon));
    const p=at(0,1.4),patio={x:p[0],y:p[1],width:Math.min(2.6,yard.widthM-.8),depth:1.8,angle},patioRing=rectangle(patio);
    if(safe(patioRing)&&polygon(concrete,{polygon:patioRing},.13))stats.patios++;
    const q=at(-yard.widthM/2+.9,yard.depthM-1.2),bed={x:q[0],y:q[1],width:1.35,depth:.6,angle},bedRing=rectangle(bed),h=heightAt(bed.x,bed.y);
    if(safe(bedRing)&&Number.isFinite(h)){cuboid(wood,bed.x,bed.y,h+.12,1.35,.6,.14,angle);cuboid(hedge,bed.x,bed.y,h+.26,1.12,.43,.35,angle);stats.gardenBeds++;}
    const r=at(0,yard.depthM-.5),hedgeBox={x:r[0],y:r[1],width:2.1,depth:.42,angle},hedgeRing=rectangle(hedgeBox),hh=heightAt(hedgeBox.x,hedgeBox.y);
    if(safe(hedgeRing)&&Number.isFinite(hh)){cuboid(hedge,hedgeBox.x,hedgeBox.y,hh+.12,2.1,.42,.75,angle);stats.hedges++;}
  }
  let gardenTriangles=0;
  const focus=options.residentialFocus||{x:0,y:0},ordered=[...buildings].sort((a,b)=>Number(b.kind==='house')-Number(a.kind==='house')||Math.hypot(a.x-focus.x,a.y-focus.y)-Math.hypot(b.x-focus.x,b.y-focus.y)||a.id.localeCompare(b.id));
  for(const b of ordered){
    if(campusIds.has(b.id)||!source.has(b.id))continue;
    const residential=/^(house|apartment)$/.test(b.kind);
    if(detail==='overview')continue;
    if(b.kind==='house'&&yardByHouse.has(b.id)&&gardenTriangles<(options.maxGardenTriangles??32000)){
      const yard=yardByHouse.get(b.id),before=stats.triangles;
      drawLimit=Math.min(budget,stats.triangles+(options.maxGardenTriangles??32000)-gardenTriangles);
      if(backyardFence(yard)){stats.gardenFences++;stats.backyardAreaM2+=yard.widthM*yard.depthM;if(yard.shrunk)stats.shrunkBackyards++;
        if(yard.accessPath)for(let i=1;i<yard.accessPath.length;i++)ribbon(concrete,yard.accessPath[i-1],yard.accessPath[i],.9,.23);
        const beds=stats.gardenBeds,patios=stats.patios,hedges=stats.hedges;gardenDetail(b,yard);gardenTriangles+=stats.triangles-before;gardens.push({...yard,bed:stats.gardenBeds>beds,patio:stats.patios>patios,hedge:stats.hedges>hedges});}
      drawLimit=budget;
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
  stats.gardenTriangles=gardenTriangles;
  }
  const result=[...groups.values()].filter((g)=>g.indices.length);stats.materialGroups=result.length;
  return {groups:result,stats,campuses,airportFocus,parkedCars,driveways,infrastructure,wireSpans,gardens,switchyards};
}
