// Pure, deterministic neighborhood planning. Source geometry is OSM; architectural
// details, unmapped heights, planting, road widths and residential infill are illustrative.
import { createLandscape } from './landscape.js';
import { buildTerrainSurface } from './terrain-mesh.js';
import { bakeMesh } from './mesh-batching.js';
import { coarseMesh } from './lod-mesh.js';
import { createSurfaceHeightSampler } from './surface-height.js';
import { buildRoadSurface, resolveRoadWidth } from './road-mesh.js';
import { buildUrbanDetail, CAMPUS_PAD_LIFT_M } from './urban-detail.js';
import { planStreetInfill } from './street-infill.js';
import { compactSceneBuffers } from './scene-buffers.js';
import { buildRecreationDetail } from './recreation-detail.js';
import { packSurfaceVertices } from './surface-packing.js';
import {mappedBuildingHistory} from './site-history.js';
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export const random = (key) => hash(key) / 4294967296;
export function bounds(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export function contains(point, poly, holes = []) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
  return poly.length >= 3 && inRing(poly) && !holes.some(inRing);
}
export function orientedBox(poly) {
  if (poly.length < 3) return null;
  let best;
  const stride = Math.max(1, Math.floor(poly.length / 24));
  for (let k = 0; k < poly.length - 1; k += stride) {
    const a = poly[k], b = poly[(k + 1) % poly.length], angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(angle), s = Math.sin(angle);
    const xx = poly.map(([x, y]) => x * c + y * s), yy = poly.map(([x, y]) => -x * s + y * c);
    const x0 = Math.min(...xx), x1 = Math.max(...xx), y0 = Math.min(...yy), y1 = Math.max(...yy);
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { x: (x0 + x1) / 2 * c - (y0 + y1) / 2 * s, y: (x0 + x1) / 2 * s + (y0 + y1) / 2 * c, width: x1 - x0, depth: y1 - y0, angle, area };
  }
  return best;
}
export class SpatialIndex {
  constructor(size = 80) { this.size = size; this.cells = new Map(); }
  insert(item, box) {
    for (let x = Math.floor(box[0] / this.size); x <= Math.floor(box[2] / this.size); x++) {
      for (let y = Math.floor(box[1] / this.size); y <= Math.floor(box[3] / this.size); y++) {
        const key = x + ',' + y;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(item);
      }
    }
  }
  at(x, y) { return this.cells.get(Math.floor(x / this.size) + ',' + Math.floor(y / this.size)) || []; }
}
export function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const priority = { water: 20, forest: 12, orchard: 11, farmland: 10, residential: 8, commercial: 8, industrial: 8, park: 6, grass: 5, scrub: 4 };
export function areaIndex(areas) {
  const index = new SpatialIndex(160);
  for (const area of areas) if (area.polygon?.length >= 3) index.insert(area, bounds(area.polygon));
  return index;
}
export function areaAt(index, x, y) {
  let found;
  for (const a of index.at(x, y)) if ((!found || (priority[a.kind] || 0) > (priority[found.kind] || 0)) && contains([x, y], a.polygon, a.holes)) found = a;
  return found;
}
export function buildingKind(tags, box, land) {
  const type = tags.building || 'yes';
  const residential = /house|residential|detached|terrace|bungalow|semidetached|cabin|apartments|dormitory|hotel/.test(type);
  // Explicit source tags/names identify campuses. Proximity alone must never
  // convert nearby homes or unrelated warehouses into a data center.
  if (/^data[_ -]?cent(er|re)$/i.test(type) || /^data[_ -]?cent(er|re)$/i.test(tags.industrial || '') ||
      (!residential && /colossus|macrohard|data cent(er|re)|equinix|digital realty/i.test(tags.name || '') && box.area > 1000) ||
      (/^google$/i.test(tags.name || '') && box.area > 3000 && /industrial|yes/.test(type))) return 'data-center';
  if (/barn|farm|stable|cowshed/.test(type)) return 'farm';
  if (/school|church|civic|hospital|public/.test(type) || /^(school|university|college|hospital|clinic|place_of_worship|community_centre|fire_station|police|library|bus_station)$/.test(tags.amenity || '')) return 'civic';
  if (/apartments|dormitory|hotel/.test(type)) return 'apartment';
  if (/retail|supermarket|kiosk/.test(type) || tags.shop) return 'shop';
  if (/office|commercial/.test(type)) return box.area < 500 ? 'shop' : 'office';
  if (/industrial|warehouse|hangar|manufacture|greenhouse/.test(type)) return 'warehouse';
  if (/house|residential|detached|terrace|bungalow|semidetached|cabin/.test(type)) return box.area > 650 ? 'apartment' : 'house';
  if (/^(restaurant|cafe|fast_food|bank|fuel|pharmacy|bar|pub)$/.test(tags.amenity || '')) return 'shop';
  if (land === 'commercial') return box.area < 1800 ? 'shop' : 'office';
  if (box.area < 360 && land !== 'industrial') return 'house';
  if (land === 'residential') return box.area > 650 ? 'apartment' : 'house';
  return box.area > 1400 || land === 'industrial' ? 'warehouse' : 'office';
}
export function heightFor(tags, kind, id) {
  const raw = String(tags.height || '');
  const meters = parseFloat(raw) * (/ft|feet|'/.test(raw) ? 0.3048 : 1);
  if (Number.isFinite(meters) && meters > 1) return { height: clamp(meters, 2, 120), measured: true };
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return { height: clamp(levels * 3.2 + (kind === 'house' ? 2 : 0.8), 3, 120), measured: false };
  const ranges = { 'data-center': [12, 19], house: [5.5, 9], apartment: [11, 19], office: [8, 20], shop: [4.5, 8], warehouse: [7, 13], farm: [6, 10], civic: [7, 13] };
  const [lo, hi] = ranges[kind] || ranges.house;
  return { height: lo + random(id + ':height') * (hi - lo), measured: false };
}
export function planNeighborhood(data, manifest, options = {}) {
  if (data.schemaVersion !== 1 || !data.center || !Array.isArray(data.buildings)) throw new Error('Unsupported neighborhood snapshot');
  const radius = Math.min(data.radiusM || 3300, 3600), maxBuildings = options.maxBuildings ?? 4200, maxTrees = options.maxTrees ?? 3200;
  const areaGrid = areaIndex(data.areas || []), occupancy = new SpatialIndex(60), roadGrid = new SpatialIndex(60);
  const pavedGrid = areaIndex(options.urban?.surfaces || []), airGrid = new SpatialIndex(160);
  const recreationSurfaceGrid=areaIndex((options.recreation?.features||[]).filter((f)=>['pitch','playground'].includes(f.kind)&&f.polygon?.length>=3));
  for (const airway of options.urban?.airways || []) for (let i=1;i<airway.points.length;i++) {
    const a=airway.points[i-1],b=airway.points[i],width=airway.width||18;
    airGrid.insert({a,b,width},[Math.min(a[0],b[0])-width,Math.min(a[1],b[1])-width,Math.max(a[0],b[0])+width,Math.max(a[1],b[1])+width]);
  }
  const isPaved = (x,y) => pavedGrid.at(x,y).some(a=>contains([x,y],a.polygon,a.holes)) || airGrid.at(x,y).some(s=>segmentDistance([x,y],s.a,s.b)<s.width/2+4)||recreationSurfaceGrid.at(x,y).some(a=>contains([x,y],a.polygon,a.holes));
  const extraRoadTags = new Map((options.urban?.roadTags || []).map(r=>[r.id,r.tags]));
  const modelKinds = new Map();
  for (const m of manifest.models) {
    if (m.style === 'dead' || m.id.includes('autumn') || m.role === 'infrastructure') continue;
    if (!modelKinds.has(m.kind)) modelKinds.set(m.kind, []);
    modelKinds.get(m.kind).push(m);
  }
  const choose = (kind, id, width, depth, tags = {}, illustrative = false) => {
    let models = modelKinds.get(kind) || modelKinds.get('house');
    // Source building use selects a relevant architectural family. The facade
    // details are illustrative; commercial parcels do not become extra buildings.
    const style = tags.building === 'hangar' ? 'aircraft-hangar' : /^(restaurant|cafe|fast_food)$/.test(tags.amenity || '') ? 'cafe' : /^(fuel|clinic|fire_station|library|bus_station)$/.test(tags.amenity || '') ? tags.amenity : tags.shop === 'supermarket' || tags.building === 'supermarket' ? 'market' : null;
    const themed = style ? models.filter((m) => m.style === style) : [];
    if (themed.length) models = themed;
    else {
      const generic=models.filter((m)=>!['aircraft-hangar','fuel','clinic','fire_station','library','bus_station'].includes(m.style));
      if(generic.length)models=generic;
    }
    if(illustrative){
      const cap=kind==='house'?260:kind==='shop'?460:kind==='office'?600:700;
      const compact=models.filter((m)=>m.width<=width*1.8&&m.depth<=depth*1.8&&(m.triangles||0)<=cap);
      if(compact.length)models=compact;
    }
    let best=models[0],bestScore=Infinity;
    for(const m of models){const score=Math.abs(Math.log((width/depth)/(m.width/m.depth)))+random(id+':'+m.id)*.75;if(score<bestScore){best=m;bestScore=score;}}
    return best;
  };
  const segments = [];
  for (const r of data.roads || []) {
    if (/^(construction|proposed)$/.test(r.kind)) continue;
    const width = resolveRoadWidth(r,extraRoadTags.get(r.id.match(/^(way\/\d+)/)?.[1]||r.id)).width;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.5) continue;
      const seg = { a, b, length, width: clamp(width, 1, 80), kind: r.kind, id: r.id + ':' + i };
      roadGrid.insert(seg, [Math.min(a[0], b[0]) - 22, Math.min(a[1], b[1]) - 22, Math.max(a[0], b[0]) + 22, Math.max(a[1], b[1]) + 22]);
      segments.push(seg);
    }
  }
  const inWater = (x, y) => areaAt(areaGrid, x, y)?.kind === 'water';
  const onRoad = (x, y, margin = 0) => roadGrid.at(x, y).some((s) => segmentDistance([x, y], s.a, s.b) < s.width / 2 + margin);
  const occupied = (x, y, margin = 0) => occupancy.at(x, y).some((b) => {
    const dx = x - b.x, dy = y - b.y, c = Math.cos(b.angle), s = Math.sin(b.angle);
    return Math.abs(dx * c + dy * s) < b.width / 2 + margin && Math.abs(-dx * s + dy * c) < b.depth / 2 + margin;
  });
  const instances = [], sourceBuildings = [];
  for (const b of data.buildings) {
    if (!b.polygon?.length || b.polygon.some((p) => p.some((v) => !Number.isFinite(v)))) continue;
    const box = orientedBox(b.polygon);
    if (!box || box.width < 3 || box.depth < 3 || box.area < 16 || box.width > 800 || box.depth > 800) continue;
    const kind = buildingKind(b.tags || {}, box, areaAt(areaGrid, box.x, box.y)?.kind);
    const entry = { ...box, kind, id: b.id, tags: b.tags || {} };
    const br = Math.hypot(box.width, box.depth) / 2 + 5;
    occupancy.insert(entry, [box.x - br, box.y - br, box.x + br, box.y + br]);
    sourceBuildings.push(entry);
  }
  sourceBuildings.sort((a, b) => Number(b.kind === 'data-center') - Number(a.kind === 'data-center') || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || a.id.localeCompare(b.id));
  let mapped = 0, infill = 0, mappedHeights = 0, infillTriangles = 0;
  const infillLimit=clamp(options.maxInfillBuildings??1600,0,2400),infillTriangleLimit=clamp(options.maxInfillTriangles??320000,0,450000),legacyBuildingLimit=options.maxBuildings!=null&&options.maxInfillBuildings==null;
  const infillByKind={house:0,shop:0,apartment:0,office:0};
  const addBuilding = (b, source = 'mapped') => {
    const illustrative=source!=='mapped';
    if ((illustrative?(infill>=infillLimit||legacyBuildingLimit&&mapped+infill>=maxBuildings):mapped>=maxBuildings)||inWater(b.x,b.y))return false;
    const m = choose(b.kind, b.id, b.width, b.depth, b.tags,illustrative), h = heightFor(b.tags || {}, b.kind, b.id);
    if(illustrative&&infillTriangles+(m.triangles||0)>infillTriangleLimit)return false;
    instances.push({ id: b.id, name: b.tags?.name || '', model: m.id, kind: b.kind, x: b.x, y: b.y, angle: b.angle, width: b.width * 0.94, depth: b.depth * 0.94, height: h.height, scale: [b.width * 0.94 / m.width, h.height / m.height, b.depth * 0.94 / m.depth], palette: b.kind === 'data-center' ? 0 : hash(b.id + ':paint') % 4, source,...(b.kind==='data-center'&&!illustrative?{sourceFootprintId:b.id,history:mappedBuildingHistory({id:b.id,tags:b.tags})}:{}),...(illustrative?{illustrative:true,frontage:{roadId:b.roadId,stationM:b.stationM,side:b.side}}:{}) });
    if (source === 'mapped') { mapped++; if (h.measured) mappedHeights++; } else {infill++;infillTriangles+=m.triangles||0;infillByKind[b.kind]=(infillByKind[b.kind]||0)+1;}
    return true;
  };
  sourceBuildings.slice(0, maxBuildings).forEach((b) => addBuilding(b));
  // Cumulative source-way stations fill both frontages, even when every source
  // segment is short. The separate allowance never displaces a mapped building.
  const infillPlan=planStreetInfill(data,{urban:options.urban,recreation:options.recreation,sourceBuildings,maxInfillBuildings:legacyBuildingLimit?Math.min(infillLimit,Math.max(0,maxBuildings-mapped)):infillLimit,radius});
  for(const b of infillPlan.buildings){
    if(!addBuilding(b,'illustrative-infill'))continue;
    const br=Math.hypot(b.width,b.depth)/2+5;occupancy.insert(b,[b.x-br,b.y-br,b.x+br,b.y+br]);
  }
  const vegetation = [], treeKinds = modelKinds.get('tree') || [],treePositions=new SpatialIndex(24),edgeTrees=new Map();
  // Avalanche only tree randomness; architecture/crops keep their existing seeds.
  // Nearby FNV string hashes otherwise correlate across complete planting rows.
  const treeRandom=(key)=>{let h=hash(key);h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);return ((h^(h>>>16))>>>0)/4294967296;};
  const groveModels=treeKinds.filter((m)=>m.style==='grove'),orchardModels=treeKinds.filter((m)=>m.style==='orchard'),singleModels=treeKinds.filter((m)=>!['orchard','grove'].includes(m.style));
  const plant = (x, y, id, kind, size = 1, mappedPosition=false) => {
    if (vegetation.length >= maxTrees || Math.abs(x) > radius - 10 || Math.abs(y) > radius - 10 || occupied(x, y, 4) || onRoad(x, y, 3) || inWater(x, y) || isPaved(x,y)) return false;
    const pool=kind==='forest'?groveModels:kind==='orchard'?orchardModels:singleModels;
    if(!pool.length)return false;
    const m=pool[Math.floor(treeRandom(id+':model')*pool.length)],sc=size*(.72+treeRandom(id+':scale')*.7),scale=[sc*(.94+treeRandom(id+':width')*.14),sc*(.93+treeRandom(id+':height')*.14),sc*(.94+treeRandom(id+':depth')*.14)],angle=treeRandom(id+':angle')*Math.PI*2;
    if(m.style==='grove'||kind==='forest-edge'){
      const r=Math.hypot(m.width*scale[0],m.depth*scale[2])/2;
      for(let k=0;k<24;k++){
        const px=x+Math.cos(k*Math.PI/12)*r,py=y+Math.sin(k*Math.PI/12)*r;
        if(areaAt(areaGrid,px,py)?.kind!=='forest'||occupied(px,py,2)||onRoad(px,py,2)||isPaved(px,py)){
          if(m.style==='grove'&&!edgeTrees.has(id))edgeTrees.set(id,{x,y,id});return false;
        }
      }
    }
    const spacing=m.style==='grove'?12:3.5;
    if(!mappedPosition&&treePositions.at(x,y).some((t)=>(t.x-x)**2+(t.y-y)**2<Math.max(spacing,t.spacing)**2))return false;
    vegetation.push({ id, model: m.id, kind: 'tree', x, y, angle, scale, palette: 0, source: 'illustrative-planting',...(mappedPosition?{mappedPosition:true}:{}) });
    treePositions.insert({x,y,spacing},[x-14,y-14,x+14,y+14]);edgeTrees.delete(id);return true;
  };
  for (const t of data.trees || []) plant(t.x, t.y, t.id, 'tree',1,true);
  // Plant nearest the camera target first so the instance budget keeps a useful foreground.
  const cells = [];
  // The first visible pass needs mapped buildings and streets only. Avoid
  // allocating/sorting the 75k planting candidates until the detail pass.
  if (!options.preview) for (let x = -radius + 20; x < radius; x += 24) for (let y = -radius + 20; y < radius; y += 24) cells.push([x, y]);
  cells.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  for (const [cx, cy] of cells) {
    if (vegetation.length >= maxTrees) break;
    const id = data.siteId + ':plant:' + cx + ':' + cy;
    for(let attempt=0;attempt<2;attempt++){
      const x=cx+(treeRandom(id+':x:'+attempt)-.5)*28,y=cy+(treeRandom(id+':y:'+attempt)-.5)*28,kind=areaAt(areaGrid,x,y)?.kind;
      const chance={forest:.95,park:.65,orchard:.85,grass:.2,residential:.22,scrub:.15}[kind]||0;
      if(treeRandom(id+':chance')<chance&&plant(x,y,id,kind,kind==='forest'?1.15:.9))break;
    }
  }
  // Dense interior groves keep priority. Remaining edge gaps can hold an
  // individual crown where the wider multi-crown footprint cannot fit safely.
  for(const t of edgeTrees.values()){if(vegetation.length>=maxTrees)break;plant(t.x,t.y,t.id,'forest-edge',.9);}
  // A few garden trees at known homes make residential streets feel lived in.
  for (const b of sourceBuildings.filter((b) => b.kind === 'house').slice(0, 1800)) {
    const d = Math.hypot(b.width, b.depth) / 2 + 7, a = b.angle + 1.1;
    plant(b.x + Math.cos(a) * d, b.y + Math.sin(a) * d, b.id + ':garden', 'tree', 0.8);
  }
  const homes = instances.filter((i) => i.kind === 'house');
  let focus = { x: 0, y: 0 };
  if (homes.length) {
    // Prefer a real residential cluster, not an isolated small industrial outbuilding.
    const candidates = homes.filter((i) => Math.hypot(i.x, i.y) < radius - 350).slice(0, 300);
    const homeGrid=new SpatialIndex(300);for(const h of homes)homeGrid.insert(h,[h.x-300,h.y-300,h.x+300,h.y+300]);
    let bestScore = -Infinity;
    for (const h of candidates) {
      const count = homeGrid.at(h.x,h.y).filter((b) => (b.x-h.x)**2+(b.y-h.y)**2<90000).length;
      const score = count - Math.hypot(h.x, h.y) / 800;
      if (score > bestScore) { bestScore = score; focus = { x: h.x, y: h.y }; }
    }
  }
  const crops = [], cropModels = (modelKinds.get('crop') || []).filter((m) => m.id === 'wheat-field-patch');
  cropCells: if (cropModels.length) for (const [cx, cy] of cells) {
    if (crops.length >= (options.maxCrops ?? 6000)) break;
    const area = areaAt(areaGrid, cx, cy);
    if (area?.kind !== 'farmland' || occupied(cx, cy, 8) || onRoad(cx, cy, 4) || Math.abs(cx) > radius - 12 || Math.abs(cy) > radius - 12) continue;
    const angle = orientedBox(area.polygon)?.angle || 0;
    // Wheat is an illustrative crop style on mapped agricultural land, not a crop census.
    for (let row = -1; row <= 1; row++) for (let col = -1; col <= 1; col++) {
      if (crops.length >= (options.maxCrops ?? 6000)) break cropCells;
      const x = cx + col * 8, y = cy + row * 8;
      if (areaAt(areaGrid, x, y)?.kind !== 'farmland' || occupied(x, y, 4) || onRoad(x, y, 2)) continue;
      const id = area.id + ':crop:' + x + ':' + y, m = cropModels[hash(id) % cropModels.length];
      const c = Math.cos(angle), sn = Math.sin(angle), footprint = [];
      for (const u of [-0.5, 0, 0.5]) for (const v of [-0.5, 0, 0.5]) {
        const dx = u * m.width * 1.18, dy = v * m.depth * 1.18;
        footprint.push([x + dx * c - dy * sn, y + dx * sn + dy * c]);
      }
      if (footprint.some(([px, py]) => areaAt(areaGrid, px, py)?.kind !== 'farmland' || occupied(px, py, 2) || onRoad(px, py, 1) || isPaved(px,py))) continue;
      crops.push({ id, model: m.id, kind: 'crop', x, y, angle, scale: [1.18, 0.85 + random(id) * 0.3, 1.18], palette: 0, source: 'illustrative-crop' });
    }
  }
  const fieldCells = cells.filter(([x, y]) => ['farmland', 'forest', 'orchard'].includes(areaAt(areaGrid, x, y)?.kind));
  const cropFocus = crops[Math.min(200, Math.max(0, crops.length - 1))];
  const fieldFocus = cropFocus ? { x: cropFocus.x, y: cropFocus.y } : fieldCells.length ? { x: fieldCells[Math.min(50, fieldCells.length - 1)][0], y: fieldCells[Math.min(50, fieldCells.length - 1)][1] } : focus;
  // Grass is a continuous, depth-tested ground material. Separate grid patches
  // left conspicuous square tufts and multiplied vertex/shadow work.
  const grass = [];
  const campuses = instances.filter((i) => i.kind === 'data-center').map(({id,name,x,y,width,depth,height,angle,sourceFootprintId,history}) => ({id,name,x,y,width,depth,height,angle,sourceFootprintId,history}));
  const campusFocus = campuses[0] || focus;
  const all = [...instances, ...vegetation, ...crops, ...grass];
  const byId = new Map(manifest.models.map((m) => [m.id, m]));
  return { instances: all, roads: segments, areaGrid, radius, focus, campusFocus, campuses, fieldFocus, stats: { buildings: mapped + infill, mappedBuildings: mapped, infillBuildings: infill,infillByKind,infillTriangles,infillPlacement:infillPlan.stats,infillBuildingLimit:infillLimit,infillTriangleLimit, dataCenters: campuses.length, sourceBuildings: data.buildings.length, mappedHeights, trees: vegetation.length, canopyCrowns: vegetation.reduce((n, i) => n + (byId.get(i.model).canopyCount || 1), 0), crops: crops.length, cropStems: crops.reduce((n,i) => n + (byId.get(i.model).stemCount || 1), 0), grass: grass.length, grassSurface: true, modelVariants: new Set(all.map((i) => i.model)).size } };
}

const hex = (s) => s.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255);
class SurfaceMesh {
  constructor(heightAt) { this.groups = new Map(); this.heightAt = heightAt; }
  triangle(points, color, lift = 0, category = 3) {
    this.triangle3(points.map(([x, y]) => [x, this.heightAt(x, y) + lift, -y]), color, category);
  }
  triangle3(pp, color, category = 0) {
    const key = color + ':' + category;
    if (!this.groups.has(key)) this.groups.set(key, { positions: [], normals: [], indices: [], color, category });
    const g = this.groups.get(key), start = g.positions.length / 3;
    const u = pp[1].map((v, i) => v - pp[0][i]), v = pp[2].map((v, i) => v - pp[0][i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], len = Math.hypot(...n) || 1;
    for (const p of pp) { g.positions.push(...p); g.normals.push(...n.map((x) => x / len)); }
    g.indices.push(start, start + 1, start + 2);
  }
  quad(a, b, c, d, color, lift = 0, category = 3) { this.triangle([a, b, c], color, lift, category); this.triangle([a, c, d], color, lift, category); }
  ribbon(a, b, width, color, lift = 0) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.1) return;
    const nx = -(b[1] - a[1]) / len * width / 2, ny = (b[0] - a[0]) / len * width / 2;
    this.quad([a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny], color, lift, 0);
  }
}
export function readGlb(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Invalid GLB');
  const length = view.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + length)));
  const start = 20 + length, bin = bytes.slice(start + 8, start + 8 + view.getUint32(start, true));
  return { json, bin };
}
export function buildNeighborhoodGlb(data, manifest, kitBuffer, options = {}) {
  const plan = options.preparedPlan || planNeighborhood(data, manifest, options), { json: gltf, bin } = readGlb(kitBuffer);
  const landscape = createLandscape(data, options.elevation);
  const groundHeight = (x, y) => 4 + (landscape.heightAt(x, y) ?? 0) - (x * x + y * y) / (2 * 6371000);
  gltf.nodes = []; gltf.scenes = [{ nodes: [] }]; gltf.scene = 0;
  gltf.asset.generator = 'Footprint Atlas deterministic low-poly neighborhood generator';
  const chunks = [bin], align = (n) => (n + 3) & ~3;
  let offset = align(bin.length);
  if (offset > bin.length) chunks.push(new Uint8Array(offset - bin.length));
  const addAccessor = (values, size, componentType = 5126) => {
    const arr = componentType === 5125 ? (values instanceof Uint32Array?values:new Uint32Array(values)) : (values instanceof Float32Array?values:new Float32Array(values)), bytes = new Uint8Array(arr.buffer,arr.byteOffset,arr.byteLength);
    const bi = gltf.bufferViews.length;
    gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes); offset += bytes.length;
    const ai = gltf.accessors.length, acc = { bufferView: bi, componentType, count: arr.length / size, type: { 1: 'SCALAR', 3: 'VEC3', 4: 'VEC4' }[size] };
    if (size === 3) {
      acc.min = [Infinity, Infinity, Infinity]; acc.max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < arr.length; k++) { const j = k % 3; acc.min[j] = Math.min(acc.min[j], arr[k]); acc.max[j] = Math.max(acc.max[j], arr[k]); }
    }
    gltf.accessors.push(acc); return ai;
  };
  const r = plan.radius;
  const terrain = buildTerrainSurface(data, landscape, groundHeight, { radius: r, spacingM: options.terrainSpacingM ?? (options.detail === 'overview' ? 110 : 55) });
  const surfaceHeight = createSurfaceHeightSampler(terrain.groups, groundHeight);
  const instanceBaseHeight=(i)=>i.kind==='data-center'?surfaceHeight(i.x,i.y)+CAMPUS_PAD_LIFT_M:groundHeight(i.x,i.y);
  const roadSurface = buildRoadSurface(data, surfaceHeight, {detail:options.preview?'preview':options.detail || 'close',spacingM:options.preview?50:undefined,urban:options.urban});
  // Upload a small, navigable mapped scene before expensive yards, parking,
  // recreation and dense planting. The full pass retains all of those details.
  const urbanDetail = options.preview ? {groups:[],stats:{}} : buildUrbanDetail(data,surfaceHeight,{detail:options.detail || 'close',buildings:plan.instances,urban:options.urban,residentialFocus:plan.focus,recreation:options.recreation});
  const recreationDetail=options.preview ? {groups:[],stats:{}} : buildRecreationDetail(data,surfaceHeight,{detail:options.detail||'close',buildings:plan.instances,urban:options.urban,recreation:options.recreation});
  const replacementBuildings=new Set(recreationDetail.replacementBuildingIds||[]);
  const palettes = [[0.88, 0.92, 0.83], [0.93, 0.83, 0.69], [0.77, 0.86, 0.9], [0.9, 0.73, 0.62]];
  const groups = new Map();
  let overviewTrees=0;
  for (const i of plan.instances) {
    if(replacementBuildings.has(i.id))continue;
    if(options.detail==='overview'&&(i.kind==='crop'||i.kind==='grass'||i.kind==='tree'&&overviewTrees++>=(options.maxTrees??1800)))continue;
    const key = i.model + ':' + i.palette;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const byId = new Map(manifest.models.map((m) => [m.id, m]));
  const materialCache = new Map();
  for (const [key, instances] of groups) {
    const proto = instances[0], template = byId.get(proto.model);
    let mesh = structuredClone(gltf.meshes[template.meshIndex]);
    const category = ['tree', 'shrub', 'grass'].includes(template.kind) ? 1 : template.kind === 'crop' ? 2 : 0;
    if (!['tree', 'shrub', 'grass', 'data-center'].includes(template.kind)) for (const primitive of mesh.primitives) {
      const mat = gltf.materials[primitive.material];
      if (!/wall|facade|siding/.test(mat.name || '')) continue;
      const mk = primitive.material + ':' + proto.palette;
      if (!materialCache.has(mk)) {
        const copy = structuredClone(mat), base = copy.pbrMetallicRoughness.baseColorFactor;
        const target = palettes[proto.palette];
        copy.name += ':variation-' + proto.palette;
        copy.pbrMetallicRoughness.baseColorFactor = base.map((v, j) => j === 3 ? v : v * 0.4 + target[j] * 0.6);
        materialCache.set(mk, gltf.materials.length); gltf.materials.push(copy);
      }
      primitive.material = materialCache.get(mk);
    }
    mesh = options.detail === 'overview' && template.kind !== 'data-center' ? coarseMesh(template, addAccessor, gltf, proto.palette) : bakeMesh(gltf, bin, mesh, addAccessor);
    for (const primitive of mesh.primitives) {
      const count = gltf.accessors[primitive.attributes.POSITION].count;
      primitive.attributes._VEGETATION = addAccessor(new Array(count).fill(category), 1);
      primitive.attributes._WATER_DISTANCE = addAccessor(new Array(count).fill(99999), 1);
    }
    const meshIndex = gltf.meshes.length; gltf.meshes.push(mesh);
    const translations = [], rotations = [], scales = [];
    for (const i of instances) {
      translations.push(i.x, instanceBaseHeight(i), -i.y);
      rotations.push(0, Math.sin(i.angle / 2), 0, Math.cos(i.angle / 2)); scales.push(...i.scale);
    }
    gltf.scenes[0].nodes.push(gltf.nodes.length);
    gltf.nodes.push({ name: key, mesh: meshIndex, extensions: { EXT_mesh_gpu_instancing: { attributes: {
      TRANSLATION: addAccessor(translations, 3), ROTATION: addAccessor(rotations, 4), SCALE: addAccessor(scales, 3),
    } } } });
  }
  const primitives = [];
  const waterGrid = new SpatialIndex(180);
  for (const area of data.areas || []) if (area.kind === 'water') for (let k = 1; k < area.polygon.length; k++) {
    const a = area.polygon[k - 1], b = area.polygon[k];
    waterGrid.insert([a, b], [Math.min(a[0], b[0]) - 180, Math.min(a[1], b[1]) - 180, Math.max(a[0], b[0]) + 180, Math.max(a[1], b[1]) + 180]);
  }
  const waterDistance = (x, y) => {
    let d = 10000;
    for (const [a, b] of waterGrid.at(x, y)) d = Math.min(d, segmentDistance([x, y], a, b));
    return areaAt(plan.areaGrid, x, y)?.kind === 'water' ? -d : d;
  };
  let sourceSurfaceVertices=0,packedSurfaceVertices=0;
  for (const sourceGroup of [...terrain.groups, ...urbanDetail.groups, ...roadSurface.groups,...recreationDetail.groups]) {
    const group=sourceGroup.category===0?packSurfaceVertices(sourceGroup):sourceGroup;
    sourceSurfaceVertices+=sourceGroup.positions.length/3;packedSurfaceVertices+=group.positions.length/3;
    const color = group.color;
    const material = gltf.materials.length;
    gltf.materials.push({ name: 'ground-' + color, pbrMetallicRoughness: { baseColorFactor: [...hex(color), 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: false });
    const count = group.positions.length / 3, distances = [];
    for (let k = 0; k < count; k++) distances.push(group.category === 0 ? 10000 : waterDistance(group.positions[k * 3], -group.positions[k * 3 + 2]));
    const attributes = { POSITION: addAccessor(group.positions, 3), NORMAL: addAccessor(group.normals, 3), _VEGETATION: addAccessor(new Array(count).fill(group.category), 1), _WATER_DISTANCE: addAccessor(distances, 1) };
    if (group.colors) attributes.COLOR_0 = addAccessor(group.colors, 4);
    primitives.push({ attributes, indices: addAccessor(group.indices, 1, 5125), material });
  }
  const mi = gltf.meshes.length; gltf.meshes.push({ name: 'mapped-ground-and-streets', primitives });
  gltf.scenes[0].nodes.push(gltf.nodes.length); gltf.nodes.push({ mesh: mi, name: 'mapped-ground-and-streets' });
  gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed || []), 'EXT_mesh_gpu_instancing'])];
  gltf.extensionsRequired = [...new Set([...(gltf.extensionsRequired || []), 'EXT_mesh_gpu_instancing'])];
  // Authored palettes are display RGB; glTF factors are linear. Converting here
  // avoids washed-out pastel ground/roofs after Cesium's output gamma correction.
  for (const material of gltf.materials) {
    const color = material.pbrMetallicRoughness?.baseColorFactor;
    if (color) for (let c = 0; c < 3; c++) color[c] = Math.pow(clamp(color[c], 0, 1), 2.2);
  }
  const packed=compactSceneBuffers(gltf,chunks);offset=packed.byteLength;
  const js = new TextEncoder().encode(JSON.stringify(gltf)), jsonLength = align(js.length), total = 12 + 8 + jsonLength + 8 + offset;
  const result = new Uint8Array(total), header = new DataView(result.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  result.fill(32, 20, 20 + jsonLength); result.set(js, 20);
  const binStart = 20 + jsonLength;
  header.setUint32(binStart, offset, true); header.setUint32(binStart + 4, 0x004e4942, true);
  let p = binStart + 8; for (const chunk of packed.chunks) { result.set(chunk, p); p += chunk.length; }
  return { buffer: result.buffer, assetStats:{unusedAssetBytesRemoved:packed.savedBytes,sourceSurfaceVertices,packedSurfaceVertices}, stats: { ...plan.stats, terrainAvailable: !!options.elevation?.heights?.every((h) => Number.isFinite(h)) }, focus: plan.focus, campusFocus: plan.campusFocus, campuses: plan.campuses.map((c)=>({...c,baseHeight:instanceBaseHeight({...c,kind:'data-center'}),padLiftM:CAMPUS_PAD_LIFT_M})), roads: plan.roads, roadPaths: roadSurface.paths, roadStats:roadSurface.stats, urbanStats:urbanDetail.stats, recreationStats:recreationDetail.stats,recreationFocus:recreationDetail.focus, airportFocus:urbanDetail.airportFocus, commercialFocus:plan.instances.find(i=>['shop','office'].includes(i.kind)) || null, fieldFocus: plan.fieldFocus, focusHeight: groundHeight(plan.focus.x, plan.focus.y), radius: r, center: data.center, source: data.source, elevation: options.elevation };
}
