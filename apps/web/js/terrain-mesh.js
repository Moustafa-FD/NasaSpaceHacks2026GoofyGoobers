// Continuous low-poly terrain and exact mapped water boundaries. Earcut 3.0.2
// is vendored from Mapbox under the adjacent vendor/earcut.LICENSE (ISC).
// Colors are LINEAR RGBA, ready for glTF COLOR_0 with a white base material.
import earcut, { deviation } from './vendor/earcut.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const signedArea = (p) => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
function hash(value) { let h = 2166136261; for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
const random = (key) => hash(key) / 4294967296;
const PALETTE = { forest: [0.29,0.41,0.25], orchard: [0.44,0.53,0.30], farmland: [0.62,0.59,0.38], residential: [0.49,0.57,0.40], commercial: [0.55,0.58,0.48], industrial: [0.55,0.57,0.48], park: [0.46,0.57,0.34], grass: [0.48,0.58,0.37], scrub: [0.53,0.58,0.38], unknown: [0.48,0.56,0.38] };

function extentFor(snapshot, options) {
  const r = options.radius ?? snapshot.radiusM ?? 3300;
  return options.extentM || [-r,-r,r,r];
}

/** Continuous bilinear RGB field, softly sampled from mapped land-use masks.
 * Water deliberately has no blue ground swatch: only polygon water is blue.
 */
export function createTerrainColorSampler(snapshot, landscape, options = {}) {
  const [west,south,east,north] = extentFor(snapshot, options);
  const spacing = Math.max(20, options.colorSpacingM ?? 110), blend = Math.max(0, options.blendM ?? 65);
  const cols = Math.max(1,Math.ceil((east-west)/spacing)), rows = Math.max(1,Math.ceil((north-south)/spacing));
  const dx = (east-west)/cols, dy = (north-south)/rows, field = [];
  const samples = [[0,0,4],[-1,0,2],[1,0,2],[0,-1,2],[0,1,2],[-1,-1,1],[-1,1,1],[1,-1,1],[1,1,1]];
  for (let j=0;j<=rows;j++) for (let i=0;i<=cols;i++) {
    const x=west+i*dx,y=south+j*dy, color=[0,0,0];
    for (const [ox,oy,w] of samples) {
      const kind=landscape?.groundKindAt?.(x+ox*blend,y+oy*blend) || 'unknown';
      const c=PALETTE[kind] || PALETTE.unknown;
      for (let k=0;k<3;k++) color[k]+=c[k]*w/16;
    }
    field.push(color);
  }
  return (x,y) => {
    const u=clamp((x-west)/dx,0,cols),v=clamp((y-south)/dy,0,rows);
    const i=Math.min(cols-1,Math.floor(u)),j=Math.min(rows-1,Math.floor(v)),a=u-i,b=v-j;
    const c0=field[j*(cols+1)+i],c1=field[j*(cols+1)+i+1],c2=field[(j+1)*(cols+1)+i],c3=field[(j+1)*(cols+1)+i+1];
    return [0,1,2].map((k) => Math.pow((c0[k]*(1-a)+c1[k]*a)*(1-b)+(c2[k]*(1-a)+c3[k]*a)*b,2.2)).concat(1);
  };
}

function cleanRing(ring) {
  const result=[];
  for (const p of ring || []) if (Array.isArray(p) && p.length>=2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!result.length || Math.hypot(p[0]-result.at(-1)[0],p[1]-result.at(-1)[1])>1e-7)) result.push([p[0],p[1]]);
  if (result.length>1 && Math.hypot(result[0][0]-result.at(-1)[0],result[0][1]-result.at(-1)[1])<1e-7) result.pop();
  return result;
}
function distanceToSegment(p,a,b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy || 1),0,1);
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
function simplifyOpen(points,tolerance) {
  if (points.length<=2) return points;
  let far=-1,index=0;
  for (let i=1;i<points.length-1;i++) { const d=distanceToSegment(points[i],points[0],points.at(-1)); if(d>far){far=d;index=i;} }
  if(far<=tolerance) return [points[0],points.at(-1)];
  return simplifyOpen(points.slice(0,index+1),tolerance).slice(0,-1).concat(simplifyOpen(points.slice(index),tolerance));
}
function simplifyRing(ring,tolerance) {
  const src=cleanRing(ring);
  if(src.length<5 || !tolerance) return src;
  let index=1,max=0;
  for(let i=1;i<src.length;i++){ const d=Math.hypot(src[i][0]-src[0][0],src[i][1]-src[0][1]);if(d>max){max=d;index=i;} }
  const next=simplifyOpen(src.slice(0,index+1),tolerance).slice(0,-1).concat(simplifyOpen(src.slice(index).concat([src[0]]),tolerance).slice(0,-1));
  const oldArea=Math.abs(signedArea(src)),newArea=Math.abs(signedArea(next));
  return next.length>=3 && newArea>0.01 && Math.abs(newArea-oldArea)/Math.max(oldArea,1)<0.02 ? next : src;
}

/** Earcut follows the source polygon and holes; no center-cell classification.
 * Simplification is bounded in meters and rejected if it changes area >2%.
 */
export function triangulateWaterPolygon(area, options = {}) {
  const tolerance=options.shoreSimplificationM ?? 2;
  const outer=simplifyRing(area.polygon,tolerance);
  if(outer.length<3 || Math.abs(signedArea(outer))<=0.01) return {points:[],triangles:[],rings:[]};
  let rings=[outer,...(area.holes || []).map((h)=>simplifyRing(h,tolerance)).filter((r)=>r.length>=3 && Math.abs(signedArea(r))>0.01)];
  const triangulate=(rs)=>{
    const points=[],holes=[];
    for(let i=0;i<rs.length;i++){if(i)holes.push(points.length);points.push(...rs[i]);}
    const flat=points.flat(),indices=earcut(flat,holes,2),triangles=[];
    for(let i=0;i<indices.length;i+=3){const triangle=[points[indices[i]],points[indices[i+1]],points[indices[i+2]]];if(Math.abs(cross(...triangle))>1e-7)triangles.push(cross(...triangle)>0?triangle:[triangle[0],triangle[2],triangle[1]]);}
    return {points,triangles,rings:rs,error:deviation(flat,holes,2,indices)};
  };
  let result=triangulate(rings);
  if(result.error>1e-5){rings=[cleanRing(area.polygon),...(area.holes || []).map(cleanRing)].filter((r)=>r.length>=3);result=triangulate(rings);}
  return result.error>1e-5?{points:[],triangles:[],rings:[],error:result.error}:result;
}

class TriangleIndex {
  constructor(size=180){this.size=size;this.cells=new Map();}
  insert(triangle){
    const xs=triangle.map((p)=>p[0]),ys=triangle.map((p)=>p[1]);
    const box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    const item={triangle,box};
    for(let x=Math.floor(box[0]/this.size);x<=Math.floor(box[2]/this.size);x++)for(let y=Math.floor(box[1]/this.size);y<=Math.floor(box[3]/this.size);y++){
      const key=x+','+y;if(!this.cells.has(key))this.cells.set(key,[]);this.cells.get(key).push(item);
    }
  }
  intersecting(triangle){
    const xs=triangle.map((p)=>p[0]),ys=triangle.map((p)=>p[1]),box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],found=new Set();
    for(let x=Math.floor(box[0]/this.size);x<=Math.floor(box[2]/this.size);x++)for(let y=Math.floor(box[1]/this.size);y<=Math.floor(box[3]/this.size);y++)for(const item of this.cells.get(x+','+y)||[])if(item.box[0]<box[2] && item.box[2]>box[0] && item.box[1]<box[3] && item.box[3]>box[1])found.add(item);
    return found;
  }
}
function halfPlane(poly,a,b,inside) {
  const out=[];let prev=poly.at(-1),pd=cross(a,b,prev),pin=inside?pd>=0:pd<=0;
  for(const p of poly){const d=cross(a,b,p),isIn=inside?d>=0:d<=0;
    if(isIn!==pin){const t=pd/(pd-d);out.push([prev[0]+(p[0]-prev[0])*t,prev[1]+(p[1]-prev[1])*t]);}
    if(isIn)out.push(p);prev=p;pd=d;pin=isIn;
  }
  return cleanRing(out);
}
function subtractTriangle(poly,clip) {
  // Convex separation avoids allocating pieces for almost all nearby triangles.
  for(let k=0;k<3;k++)if(poly.every((p)=>cross(clip[k],clip[(k+1)%3],p)<=1e-8))return [poly];
  for(let k=0;k<poly.length;k++)if(clip.every((p)=>cross(poly[k],poly[(k+1)%poly.length],p)<=1e-8))return [poly];
  let current=poly;const pieces=[];
  for(let k=0;k<3 && current.length>=3;k++){
    const outside=halfPlane(current,clip[k],clip[(k+1)%3],false);
    if(outside.length>=3 && Math.abs(signedArea(outside))>1e-5)pieces.push(outside);
    current=halfPlane(current,clip[k],clip[(k+1)%3],true);
  }
  return pieces;
}
function group(name,category){return {name,category,color:'#ffffff',colorSpace:'linear',positions:[],normals:[],indices:[],colors:[]};}
function addTriangle(target,triangle,heightAt,colorAt,lift=0){
  if(cross(...triangle)<0)triangle=[triangle[0],triangle[2],triangle[1]];
  if(Math.abs(cross(...triangle))<1e-6)return;
  const points=triangle.map(([x,y])=>[x,(heightAt(x,y)??0)+lift,-y]);
  const a=points[1].map((v,i)=>v-points[0][i]),b=points[2].map((v,i)=>v-points[0][i]);
  const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],len=Math.hypot(...n)||1,start=target.positions.length/3;
  for(let i=0;i<3;i++){target.positions.push(...points[i]);target.normals.push(...n.map((v)=>v/len));target.colors.push(...colorAt(...triangle[i]));}
  target.indices.push(start,start+1,start+2);
}

/** Returns mesh groups ready to append to the scene glTF. All ground is category
 * 3; water is separate category4 geometry following mapped shores and islands.
 * Default draped water aligns to the display DEM; optional waterMode:'level'
 * uses a representative body height. Neither mode estimates water availability.
 */
export function buildTerrainSurface(snapshot, landscape, heightAt, options = {}) {
  const extent=extentFor(snapshot,options),[west,south,east,north]=extent;
  const spacing=clamp(options.spacingM??110,35,180),cols=Math.ceil((east-west)/spacing),rows=Math.ceil((north-south)/spacing),dx=(east-west)/cols,dy=(north-south)/rows;
  const terrain=group('continuous-faceted-land',3),water=group('mapped-polygon-water',4),banks=group('mapped-bank-ribbon',0);
  const colorAt=createTerrainColorSampler(snapshot,landscape,options),waterColor=()=>[0.13,0.32,0.39].map((v)=>Math.pow(v,2.2)).concat(1),bankColor=()=>[0.63,0.60,0.43].map((v)=>Math.pow(v,2.2)).concat(1);
  const index=new TriangleIndex(180);let waterBodies=0,skippedWaterPolygons=0;
  for(const area of snapshot.areas || [])if(area.kind==='water'){
    const result=triangulateWaterPolygon(area,options);
    if(!result.triangles.length){skippedWaterPolygons++;continue;}
    waterBodies++;
    const levels=result.points.map(([x,y])=>heightAt(x,y)).filter(Number.isFinite).sort((a,b)=>a-b);
    const level=levels.length?levels[Math.floor(levels.length/2)]:0;
    const waterHeight=options.waterMode==='level'?()=>level:heightAt;
    for(const triangle of result.triangles){index.insert(triangle);addTriangle(water,triangle,waterHeight,waterColor,options.waterLiftM??0.7);}
    if(options.banks)for(const ring of result.rings)for(let k=0;k<ring.length;k++){
      const a=ring[k],b=ring[(k+1)%ring.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(len<0.1)continue;
      const sign=signedArea(ring)>0?1:-1,nx=(b[1]-a[1])/len*0.8*sign,ny=-(b[0]-a[0])/len*0.8*sign,c=[b[0]+nx,b[1]+ny],d=[a[0]+nx,a[1]+ny];
      addTriangle(banks,[a,b,c],heightAt,bankColor,0.15);addTriangle(banks,[a,c,d],heightAt,bankColor,0.15);
    }
  }
  const vertices=[];
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const key=(snapshot.siteId||'terrain')+':'+i+':'+j;
    const x=west+i*dx+(i>0&&i<cols?(random(key+'x')-0.5)*dx*0.48:0),y=south+j*dy+(j>0&&j<rows?(random(key+'y')-0.5)*dy*0.48:0);
    vertices.push([x,y]);
  }
  let baseTriangles=0;
  const appendLand=(triangle)=>{
    if(cross(...triangle)<0)triangle=[triangle[0],triangle[2],triangle[1]];
    baseTriangles++;let pieces=[triangle];
    for(const item of index.intersecting(triangle)){
      pieces=pieces.flatMap((piece)=>subtractTriangle(piece,item.triangle));if(!pieces.length)break;
    }
    for(const poly of pieces)for(let k=1;k<poly.length-1;k++)addTriangle(terrain,[poly[0],poly[k],poly[k+1]],heightAt,colorAt);
  };
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const a=vertices[j*(cols+1)+i],b=vertices[j*(cols+1)+i+1],c=vertices[(j+1)*(cols+1)+i+1],d=vertices[(j+1)*(cols+1)+i];
    const first=random(i+':'+j)<0.5;
    if((first&&cross(a,b,c)>0&&cross(a,c,d)>0)||cross(a,b,d)<=0||cross(b,c,d)<=0){appendLand([a,b,c]);appendLand([a,c,d]);}
    else{appendLand([a,b,d]);appendLand([b,c,d]);}
  }
  return {groups:[terrain,water,banks].filter((g)=>g.indices.length),stats:{baseTriangles,groundTriangles:terrain.indices.length/3,waterTriangles:water.indices.length/3,waterBodies,skippedWaterPolygons,spacingM:spacing,shoreSimplificationM:options.shoreSimplificationM??2}};
}
