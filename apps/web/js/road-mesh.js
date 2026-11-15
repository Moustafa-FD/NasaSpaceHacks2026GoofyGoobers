// Continuous, terrain-draped surfaces from cached OpenStreetMap highway ways.
// Widths without OSM width tags and all markings/sidewalk styling are illustrative;
// this module adds no routes or parking lots. Coordinates are local east/north metres.
const WIDTHS = {motorway:14,motorway_link:7,trunk:12,trunk_link:7,primary:10,primary_link:7,secondary:9,secondary_link:7,tertiary:8,tertiary_link:6,residential:6,living_street:5,unclassified:6,service:4,track:3,footway:1.5,path:1.3,cycleway:2,pedestrian:4,steps:1.2,bridleway:2,raceway:8};
const MINOR = /^(footway|path|steps|cycleway|track|bridleway)$/;
const SIDEWALK = /^(residential|living_street|primary|secondary|tertiary|unclassified|pedestrian)$/;
const MARKED = /^(motorway|trunk|primary|secondary|tertiary)$/;
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
const length = (a,b) => Math.hypot(b[0]-a[0],b[1]-a[1]);
const key = (p) => Math.round(p[0]*4)+','+Math.round(p[1]*4);

/** OSM widths win. Lane-derived widths are display estimates, never measurements. */
export function resolveRoadWidth(road,tags={}) {
  tags={...(road.tags||{}),...tags};
  const raw=String(tags.width||''),match=raw.match(/^\s*([0-9]+(?:\.[0-9]+)?)/);
  if(match){const width=Number(match[1])*(/ft|'/.test(raw)?0.3048:1);if(width>=0.3&&width<=100)return {width,widthSource:'osm:width'};}
  if(road.widthSource==='osm:width'&&Number(road.width)>0)return {width:Number(road.width),widthSource:'osm:width'};
  const value=String(tags.lanes||''),lanes=/^\d+$/.test(value)?Number(value):0;
  if(lanes>=1&&lanes<=16&&!MINOR.test(road.kind)){
    const major=/^(motorway|trunk)/.test(road.kind),arterial=/^(primary|secondary)/.test(road.kind),lane=major?3.6:arterial?3.3:road.kind==='service'?2.7:3;
    let width=lane*lanes+(major?2:arterial?1:0.6);
    if(tags['parking:lane:both']==='parallel')width+=4.6;
    else for(const side of ['left','right'])if(tags['parking:lane:'+side]==='parallel')width+=2.3;
    return {width,widthSource:'illustrative estimate from OSM lanes'};
  }
  if(road.kind==='service'&&/^(driveway|parking_aisle)$/.test(tags.service||'')&&(!road.widthSource||road.widthSource.includes('illustrative')))
    return {width:tags.service==='driveway'?3:5.5,widthSource:'illustrative service-type default'};
  return {width:Number(road.width)>0?Number(road.width):(WIDTHS[road.kind]||4),widthSource:road.widthSource||(Number(road.width)>0?'cached source width':'illustrative road-class default')};
}

function cleanPoints(points) {
  const result=[];
  for(const p of points||[]) if(Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&(!result.length||length(p,result.at(-1))>0.05)) result.push([p[0],p[1]]);
  return result;
}
function resample(points, spacing) {
  const result=[points[0]];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],steps=Math.max(1,Math.ceil(length(a,b)/spacing));
    for(let j=1;j<=steps;j++) result.push([a[0]+(b[0]-a[0])*j/steps,a[1]+(b[1]-a[1])*j/steps]);
  }
  return result;
}
function offsets(points) {
  const closed=points.length>3&&length(points[0],points.at(-1))<0.05, end=points.length-1;
  return points.map((p,i)=>{
    const before=points[i>0?i-1:closed?end-1:0],after=points[i<end?i+1:closed?1:end];
    const al=length(before,p),bl=length(p,after);
    const ax=al?(p[0]-before[0])/al:(after[0]-p[0])/bl,ay=al?(p[1]-before[1])/al:(after[1]-p[1])/bl;
    const bx=bl?(after[0]-p[0])/bl:ax,by=bl?(after[1]-p[1])/bl:ay;
    const nx=-ay-by,ny=ax+bx,nl=Math.hypot(nx,ny);
    if(nl<0.001)return [-by,bx];
    const mx=nx/nl,my=ny/nl,scale=Math.min(2,1/Math.max(0.2,mx*-by+my*bx));
    return [mx*scale,my*scale];
  });
}

/**
 * Build batched road meshes. `heightAt(east,north)` must return the actual rendered
 * ground height (including any scene offset). It is not offset by 4 m here.
 * `paths` retains source identities and includes the asphalt-top centre height for
 * traffic: [east,north,height]. Default spacing is 12 m close / 28 m overview.
 * Preview uses 50 m spacing and only road/path surfaces with six-sided caps.
 */
export function buildRoadSurface(data,heightAt,{detail='close',spacingM,asphaltLiftM=0.28,...options}={}) {
  if(typeof heightAt!=='function')throw new TypeError('buildRoadSurface requires a ground height sampler');
  const preview=detail==='preview',capSegments=preview?6:10;
  const spacing=clamp(spacingM??(preview?50:detail==='overview'?28:12),2,50),surfaceAt=options.surfaceHeightAt||heightAt;
  const groups=new Map(),paths=[],junctions=new Map(),metadata=new Map((options.urban?.roadTags||[]).map((r)=>[r.id,r.tags||{}]));
  const stats={sourceRoads:(data.roads||[]).length,renderedRoads:0,minorPaths:0,skippedPlannedRoads:0,invalidRoads:0,widthFallbacks:0,laneEstimatedWidths:0,mappedCrossings:(options.urban?.crossings||[]).length,paintedCrossings:0,resampledPoints:0,segmentCount:0,lengthM:0,triangles:0,spacingM:spacing};
  const group=(name,color)=>{if(!groups.has(name))groups.set(name,{name,positions:[],normals:[],indices:[],color,category:0});return groups.get(name);};
  const materials={asphalt:group('road-asphalt','#3c454a'),sidewalk:group('road-sidewalk','#b3afa0'),curb:group('road-curb','#c9c6b8'),path:group('road-path','#aa9b7d'),line:group('road-center-markings','#e8d99c'),edge:group('road-edge-markings','#e2e1d4')};
  const sources=[];
  for(const source of data.roads||[]) {
    if(/^(construction|proposed|abandoned|razed)$/.test(source.kind)){stats.skippedPlannedRoads++;continue;}
    const points=cleanPoints(source.points);if(points.length<2){stats.invalidRoads++;continue;}
    const tags={...(source.tags||{}),...(metadata.get(source.id.match(/^(way\/\d+)/)?.[1]||source.id)||{})},resolved=resolveRoadWidth(source,tags),{width,widthSource}=resolved;
    if(!(Number(source.width)>0))stats.widthFallbacks++;
    if(widthSource==='illustrative estimate from OSM lanes')stats.laneEstimatedWidths++;
    sources.push({source,points,width,widthSource,tags});
    // Original shared OSM vertices identify connected ways, including T junctions.
    for(const p of points){const k=key(p),old=junctions.get(k);if(old){old.count++;old.width=Math.max(old.width,width);}else junctions.set(k,{point:p,count:1,width});}
  }
  const normal=(left,right,before,after)=>{
    const ax=right[0]-left[0],ay=right[1]-left[1],az=right[2]-left[2],bx=after[0]-before[0],by=after[1]-before[1],bz=after[2]-before[2];
    let nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;
    if(ny<0){nx=-nx;ny=-ny;nz=-nz;}const n=Math.hypot(nx,ny,nz)||1;
    return [nx/n,ny/n,nz/n];
  };
  const position=(p,lift)=>{const h=surfaceAt(p[0],p[1]);return Number.isFinite(h)?[p[0],h+lift,-p[1]]:null;};
  function strip(mesh,points,width,lift,offset=0,knownOffsets,withCenter=false) {
    if(points.length<2)return;
    const sides=knownOffsets||offsets(points),vertices=[];
    for(let i=0;i<points.length;i++) {
      const p=points[i],n=sides[i],left=position([p[0]+n[0]*(width/2+offset),p[1]+n[1]*(width/2+offset)],lift),right=position([p[0]+n[0]*(-width/2+offset),p[1]+n[1]*(-width/2+offset)],lift);
      const center=withCenter?position([p[0]+n[0]*offset,p[1]+n[1]*offset],lift):null;
      if(!left||!right||(withCenter&&!center))return;vertices.push([left,right,center]);
    }
    const start=mesh.positions.length/3;
    for(let i=0;i<vertices.length;i++) {
      const [left,right,center]=vertices[i],before=vertices[Math.max(0,i-1)][0],after=vertices[Math.min(vertices.length-1,i+1)][0],n=normal(left,right,before,after),stride=withCenter?3:2;
      mesh.positions.push(...left,...right);mesh.normals.push(...n,...n);
      if(withCenter){mesh.positions.push(...center);mesh.normals.push(...n);}
      if(i){const a=start+(i-1)*stride,b=start+i*stride;if(withCenter)mesh.indices.push(a,a+2,b,a+2,b+2,b,a+2,a+1,b+2,a+1,b+1,b+2);else mesh.indices.push(a,a+1,b,a+1,b+1,b);}
    }
  }
  const disks=new Set();
  function disk(mesh,p,radius,lift,segments=10) {
    const id=mesh.name+':'+key(p)+':'+radius.toFixed(2);if(disks.has(id))return;disks.add(id);
    const center=position(p,lift);if(!center)return;
    const ring=[];for(let i=0;i<segments;i++){const a=i/segments*Math.PI*2,v=position([p[0]+Math.cos(a)*radius,p[1]+Math.sin(a)*radius],lift);if(!v)return;ring.push(v);}
    const start=mesh.positions.length/3;mesh.positions.push(...center);mesh.normals.push(0,1,0);
    for(const v of ring){mesh.positions.push(...v);mesh.normals.push(0,1,0);}
    for(let i=0;i<segments;i++)mesh.indices.push(start,start+1+i,start+1+(i+1)%segments);
  }
  function dashes(points,width,lift) {
    const period=16,dash=7;let distance=0;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],len=length(a,b);let cursor=0;
      while(cursor<len-1e-7){
        const phase=(distance+cursor)%period,on=phase<dash,step=Math.min(len-cursor,(on?dash:period)-phase);
        if(on&&step>0.03){const t=cursor/len,u=(cursor+step)/len,p=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],q=[a[0]+(b[0]-a[0])*u,a[1]+(b[1]-a[1])*u];
          // Do not paint a lane through the centre of a mapped road junction.
          const nearA=junctions.get(key(a)),nearB=junctions.get(key(b));
          if(!((nearA?.count>1&&cursor<width)||(nearB?.count>1&&len-cursor-step<width)))strip(materials.line,[p,q],0.18,lift);
        }
        cursor+=Math.max(step,1e-6);
      }
      distance+=len;
    }
  }
  for(const {source,points,width,widthSource,tags} of sources) {
    const sampled=resample(points,spacing),top=sampled.map((p)=>{const h=surfaceAt(p[0],p[1]);return [p[0],p[1],Number.isFinite(h)?h+asphaltLiftM:NaN];});
    if(top.some((p)=>!Number.isFinite(p[2]))){stats.invalidRoads++;continue;}
    const minor=MINOR.test(source.kind),sides=offsets(sampled),sidewalk=!preview&&!minor&&SIDEWALK.test(source.kind)&&width>=3&&!/^(no|none|separate)$/.test(tags.sidewalk||'');
    const roadMaterial=minor?materials.path:materials.asphalt;
    if(sidewalk){strip(materials.sidewalk,sampled,width+3.2,asphaltLiftM-0.14,0,sides);strip(materials.curb,sampled,width+0.5,asphaltLiftM-0.06,0,sides);}
    // An explicit centre vertex follows the ground even where a terrain facet
    // crosses the road width; traffic heights therefore match the road mesh.
    strip(roadMaterial,sampled,width,asphaltLiftM,0,sides,true);
    // Round caps / joining disks close the wedge between differently angled ways.
    // The continuous mitered strip itself shares both edge vertices at every bend.
    const joins=[points[0],points.at(-1)];
    for(let i=1;i<points.length-1;i++){
      const a=points[i-1],p=points[i],b=points[i+1],u=length(a,p),v=length(p,b);
      if(((p[0]-a[0])*(b[0]-p[0])+(p[1]-a[1])*(b[1]-p[1]))/(u*v)<0.8||junctions.get(key(p))?.count>1)joins.push(p);
    }
    for(const p of joins){if(sidewalk){disk(materials.sidewalk,p,(width+3.2)/2,asphaltLiftM-0.14);disk(materials.curb,p,(width+0.5)/2,asphaltLiftM-0.06);}disk(roadMaterial,p,width/2,asphaltLiftM,capSegments);}
    if(!preview&&!minor&&MARKED.test(source.kind)&&width>=6){
      dashes(sampled,width,asphaltLiftM+0.025);
      if(width>=9&&detail!=='overview')for(const offset of [-width/2+0.32,width/2-0.32])strip(materials.edge,sampled,0.12,asphaltLiftM+0.022,offset,sides);
    }
    paths.push({id:source.id,kind:source.kind,width,widthSource,tags:{...tags},...(tags.oneway?{oneway:tags.oneway}:{}),points:top});
    stats.renderedRoads++;if(minor)stats.minorPaths++;stats.resampledPoints+=sampled.length;stats.segmentCount+=sampled.length-1;
    for(let i=1;i<sampled.length;i++)stats.lengthM+=length(sampled[i-1],sampled[i]);
  }
  if(!preview&&detail!=='overview'&&options.urban?.crossings?.length){
    const cells=new Map(),size=80;
    for(const s of sources)if(!MINOR.test(s.source.kind)&&!/^motorway/.test(s.source.kind))for(let i=1;i<s.points.length;i++){
      const a=s.points[i-1],b=s.points[i],item={a,b,width:s.width};
      for(let x=Math.floor((Math.min(a[0],b[0])-15)/size);x<=Math.floor((Math.max(a[0],b[0])+15)/size);x++)for(let y=Math.floor((Math.min(a[1],b[1])-15)/size);y<=Math.floor((Math.max(a[1],b[1])+15)/size);y++){const k=x+','+y;if(!cells.has(k))cells.set(k,[]);cells.get(k).push(item);}
    }
    const painted=new Set();
    for(const crossing of options.urban.crossings){
      if(crossing.tags?.['crossing:markings']==='no'||crossing.tags?.crossing==='unmarked')continue;
      const p=[crossing.x,crossing.y];let best=null,nearest=Infinity;
      for(const s of cells.get(Math.floor(p[0]/size)+','+Math.floor(p[1]/size))||[]){const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],len=Math.hypot(dx,dy),t=clamp(((p[0]-s.a[0])*dx+(p[1]-s.a[1])*dy)/(len*len),0,1),q=[s.a[0]+dx*t,s.a[1]+dy*t],distance=length(p,q);if(distance<nearest&&distance<s.width/2+2){nearest=distance;best={...s,q,dx:dx/len,dy:dy/len};}}
      if(!best||painted.has(key(best.q)))continue;painted.add(key(best.q));
      const {q,dx,dy,width}=best;
      for(let d=-1.15;d<=1.16;d+=1.15){const c=[q[0]+dx*d,q[1]+dy*d],a=[c[0]-dy*(width/2-0.25),c[1]+dx*(width/2-0.25)],b=[c[0]+dy*(width/2-0.25),c[1]-dx*(width/2-0.25)];strip(materials.edge,[a,b],0.55,asphaltLiftM+0.035);}
      stats.paintedCrossings++;
    }
  }
  const result=[...groups.values()].filter((g)=>g.indices.length);stats.triangles=result.reduce((n,g)=>n+g.indices.length/3,0);stats.materialGroups=result.length;
  return {groups:result,paths,stats};
}
