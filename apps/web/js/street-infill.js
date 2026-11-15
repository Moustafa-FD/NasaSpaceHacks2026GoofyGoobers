// Illustrative street-front architecture; never new OSM records or named campuses.
// Source footprints (including buildings outside the draw budget), natural land,
// mapped paving, airport operations and transmission corridors remain protected.
import {resolveRoadWidth} from './road-mesh.js';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function hash(value){let h=2166136261;for(const c of String(value))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
const random=(value)=>hash(value)/4294967296;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const cross=(a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
const bounds=(p)=>[Math.min(...p.map((v)=>v[0])),Math.min(...p.map((v)=>v[1])),Math.max(...p.map((v)=>v[0])),Math.max(...p.map((v)=>v[1]))];
function contains(p,ring){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
const inArea=(p,a)=>contains(p,a.polygon)&&!(a.holes||[]).some((hole)=>contains(p,hole));
function segmentDistance(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dy*t);}
function intersects(a,b,c,d){if(cross(a,b,c)*cross(a,b,d)>0||cross(c,d,a)*cross(c,d,b)>0)return false;return Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))+1e-8&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]))+1e-8;}
function overlaps(poly,area){
  if(poly.some((p)=>inArea(p,area))||area.polygon.some((p)=>contains(p,poly)))return true;
  for(let i=0;i<poly.length;i++)for(let j=0;j<area.polygon.length;j++)if(intersects(poly[i],poly[(i+1)%poly.length],area.polygon[j],area.polygon[(j+1)%area.polygon.length]))return true;
  return false;
}
function rectangle(b,margin=0){const c=Math.cos(b.angle),s=Math.sin(b.angle),w=b.width/2+margin,d=b.depth/2+margin;return [[-w,-d],[w,-d],[w,d],[-w,d]].map(([u,v])=>[b.x+u*c-v*s,b.y+u*s+v*c]);}
class Index{
  constructor(size=100){this.size=size;this.cells=new Map();}
  insert(item,b){for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++){const key=x+','+y;if(!this.cells.has(key))this.cells.set(key,[]);this.cells.get(key).push(item);}}
  query(b){const found=new Set();for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++)for(const item of this.cells.get(x+','+y)||[])found.add(item);return found;}
  at(p){return this.cells.get(Math.floor(p[0]/this.size)+','+Math.floor(p[1]/this.size))||[];}
}
function lineTouches(poly,line,padding){
  if(contains(line.a,poly)||contains(line.b,poly))return true;
  for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];if(intersects(a,b,line.a,line.b)||segmentDistance(a,line.a,line.b)<padding||segmentDistance(line.a,a,b)<padding||segmentDistance(line.b,a,b)<padding)return true;}return false;
}

/** Cumulative source-way stations survive redundant source point subdivision. */
export function sampleStreetFrontage(road,{spacingM=24}={}){
  const points=road.points||[];if(points.length<2||points.some((p)=>!p?.length||!Number.isFinite(p[0])||!Number.isFinite(p[1])))return {samples:[],lengthM:0};
  const segments=[];let total=0;
  for(let i=1;i<points.length;i++){const length=dist(points[i-1],points[i]);if(length>.05){segments.push({a:points[i-1],b:points[i],length,start:total});total+=length;}}
  const samples=[],start=16+hash(road.id)%10;let i=0;
  for(let station=start;station<total-12;station+=spacingM){while(i<segments.length-1&&segments[i].start+segments[i].length<station)i++;const s=segments[i],t=(station-s.start)/s.length;samples.push({stationM:station,x:Math.round((s.a[0]+(s.b[0]-s.a[0])*t)*1e6)/1e6,y:Math.round((s.a[1]+(s.b[1]-s.a[1])*t)*1e6)/1e6,dx:(s.b[0]-s.a[0])/s.length,dy:(s.b[1]-s.a[1])/s.length});}
  return {samples,lengthM:total};
}

export function planStreetInfill(snapshot,{urban={},recreation={},sourceBuildings=[],maxInfillBuildings=1600,maxCandidates=52000,radius=snapshot.radiusM||3300}={}){
  const limit=clamp(Math.floor(maxInfillBuildings),0,2400),buildings=[],stats={candidates:0,eligibleWays:0,landRejected:0,protectedRejected:0,occupiedRejected:0,roadRejected:0,inferredUrban:0,sectors:Array(8).fill(0),rings:Array(3).fill(0),byKind:{house:0,shop:0,apartment:0,office:0}};
  if(!limit)return {buildings,stats};
  const land=new Index(160),protectedAreas=new Index(160),occupied=new Index(80),roads=new Index(80),reservedLines=new Index(160),adjacency=new Index(140),metadata=new Map((urban.roadTags||[]).map((r)=>[r.id,r.tags||{}]));
  for(const area of snapshot.areas||[]){if(!area.polygon?.length)continue;land.insert(area,bounds(area.polygon));if(!['residential','commercial','grass'].includes(area.kind))protectedAreas.insert(area,bounds(area.polygon));if(['residential','commercial'].includes(area.kind))for(const hole of area.holes||[])protectedAreas.insert({polygon:hole},bounds(hole));}
  for(const area of [...(urban.surfaces||[]),...(urban.airports||[]),...(recreation.features||[])])if(area.polygon?.length)protectedAreas.insert(area,bounds(area.polygon));
  for(const b of snapshot.buildings||[])if(b.polygon?.length>=3&&b.polygon.every((p)=>p.every(Number.isFinite)))occupied.insert(b,bounds(b.polygon));
  for(const b of sourceBuildings){
    if(['data-center','warehouse','farm'].includes(b.kind)){const reserved={polygon:rectangle(b,b.kind==='data-center'?65:12)};protectedAreas.insert(reserved,bounds(reserved.polygon));}
    if(['house','apartment','shop','office','civic'].includes(b.kind))adjacency.insert(b,[b.x-190,b.y-190,b.x+190,b.y+190]);
  }
  const insertLine=(index,a,b,padding,item={})=>{if(dist(a,b)<.05)return;index.insert({a,b,padding,...item},[Math.min(a[0],b[0])-padding,Math.min(a[1],b[1])-padding,Math.max(a[0],b[0])+padding,Math.max(a[1],b[1])+padding]);};
  for(const a of urban.airways||[])for(let i=1;i<a.points.length;i++)insertLine(reservedLines,a.points[i-1],a.points[i],(a.width||30)/2+(a.kind==='runway'?35:12));
  for(const a of urban.powerLines||[])if(a.kind==='line')for(let i=1;i<a.points.length;i++)insertLine(reservedLines,a.points[i-1],a.points[i],20);
  for(const a of snapshot.waterways||[])for(let i=1;i<a.points.length;i++)insertLine(reservedLines,a.points[i-1],a.points[i],a.kind==='river'?20:5);
  const ways=[];
  for(const road of snapshot.roads||[]){
    if(!Array.isArray(road.points)||road.points.length<2||road.points.some((p)=>!p?.length||!Number.isFinite(p[0])||!Number.isFinite(p[1])))continue;
    if(/^(proposed|construction|abandoned)$/.test(road.kind))continue;
    const tags={...(road.tags||{}),...(metadata.get(road.id.match(/^(way\/\d+)/)?.[1]||road.id)||{})},width=resolveRoadWidth(road,tags).width;
    for(let i=1;i<road.points.length;i++)insertLine(roads,road.points[i-1],road.points[i],width/2+1,{id:road.id});
    if(!/^(residential|living_street|unclassified|tertiary|secondary|primary|service)$/.test(road.kind)||width>22||/^(driveway|parking_aisle|emergency_access)$/.test(tags.service||'')||/^(yes|true|1)$/.test(tags.bridge||'')||/^(yes|true|1)$/.test(tags.tunnel||'')||tags.layer&&Number(tags.layer)!==0)continue;
    const sampled=sampleStreetFrontage(road);if(road.kind==='service'&&sampled.lengthM<100)continue;
    ways.push({...road,tags,width,...sampled,rank:Math.min(...road.points.slice(1).map((p,i)=>segmentDistance([0,0],road.points[i],p)))});
  }
  const priority={water:30,forest:25,farmland:25,orchard:25,industrial:24,park:20,residential:10,commercial:11,grass:2,scrub:1};
  const landAt=(p)=>{let kind=null,score=-1;for(const a of land.at(p))if((priority[a.kind]||0)>score&&inArea(p,a)){kind=a.kind;score=priority[a.kind]||0;}return kind;};
  function urbanUse(p){
    const kind=landAt(p);if(kind==='residential'||kind==='commercial')return {kind,inferred:false};if(kind&&kind!=='grass')return null;
    let count=0,commercial=0,strongResidential=0;
    for(const b of adjacency.at(p))if((b.x-p[0])**2+(b.y-p[1])**2<190**2){count++;if(b.kind==='shop'||b.kind==='office')commercial++;if(/house|residential|detached|terrace|bungalow|apartments/.test(b.tags?.building||''))strongResidential++;}
    if(count<2)return null;return {kind:commercial>=2&&commercial>=count/2?'commercial':'residential',inferred:true,strongResidential};
  }
  // Near-to-far rings take turns between angular sectors. Suitable streets in one
  // dense neighborhood cannot consume the whole allowance before the other side.
  const buckets=Array.from({length:24},()=>[]),stations=[];
  for(const way of ways)for(const s of way.samples){const sector=Math.floor((Math.atan2(s.y,s.x)+Math.PI)/(Math.PI*2)*8)%8,ring=Math.min(2,Math.floor(Math.hypot(s.x,s.y)/(radius/3)));buckets[ring*8+sector].push({way,s,rank:s.x*s.x+s.y*s.y,sector,ring});}
  for(const bucket of buckets)bucket.sort((a,b)=>a.rank-b.rank||a.way.id.localeCompare(b.way.id)||a.s.stationM-b.s.stationM);
  for(let ring=0;ring<3;ring++){let index=0,more=true;while(more){more=false;for(let sector=0;sector<8;sector++){const item=buckets[ring*8+sector][index];if(item){stations.push(item);more=true;}}index++;}}
  stats.eligibleWays=ways.length;
  stationLoop:for(const {way,s,sector,ring} of stations){
    for(const side of [-1,1]){
      if(buildings.length>=limit||stats.candidates>=maxCandidates)break stationLoop;stats.candidates++;
      const id='infill:'+way.id+':'+s.stationM+':'+side,rough=[s.x-s.dy*side*(way.width/2+14),s.y+s.dx*side*(way.width/2+14)],use=urbanUse(rough);
      if(!use||way.kind==='service'&&use.kind!=='commercial'&&use.inferred&&use.strongResidential<2){stats.landRejected++;continue;}
      const roll=random(id+':kind'),kind=use.kind==='commercial'?(roll<.85?'shop':'office'):(roll<.93?'house':'apartment');
      const width=kind==='house'?10+random(id+'w')*4:kind==='shop'?14+random(id+'w')*10:18+random(id+'w')*7,depth=kind==='house'?11+random(id+'d')*6:kind==='shop'?11+random(id+'d')*7:14+random(id+'d')*7,setback=kind==='house'?5:kind==='shop'?4:6,off=way.width/2+setback+depth/2;
      const b={id,x:Math.round((s.x-s.dy*off*side)*1000)/1000,y:Math.round((s.y+s.dx*off*side)*1000)/1000,width,depth,angle:Math.atan2(s.dy,s.dx)+(side<0?Math.PI:0),kind,tags:{},roadId:way.id,stationM:s.stationM,side,inferredUrban:use.inferred};
      const poly=rectangle(b),clearance=rectangle(b,2.5),box=bounds(clearance),samples=[...poly,[b.x,b.y],...poly.map((p,i)=>[(p[0]+poly[(i+1)%4][0])/2,(p[1]+poly[(i+1)%4][1])/2])];
      if(samples.some((p)=>{const k=landAt(p);return Math.abs(p[0])>radius-8||Math.abs(p[1])>radius-8||(use.inferred?![null,'grass',use.kind].includes(k):k!==use.kind);})){stats.landRejected++;continue;}
      if([...protectedAreas.query(box)].some((a)=>overlaps(clearance,a))||[...reservedLines.query(box)].some((a)=>lineTouches(clearance,a,a.padding))){stats.protectedRejected++;continue;}
      if([...occupied.query(box)].some((a)=>overlaps(clearance,a))){stats.occupiedRejected++;continue;}
      if([...roads.query(box)].some((a)=>lineTouches(poly,a,a.padding))){stats.roadRejected++;continue;}
      buildings.push(b);occupied.insert({polygon:poly},bounds(poly));stats.byKind[kind]++;stats.sectors[sector]++;stats.rings[ring]++;if(use.inferred)stats.inferredUrban++;
    }
  }
  stats.limitReached=buildings.length>=limit||stats.candidates>=maxCandidates;
  return {buildings,stats};
}
