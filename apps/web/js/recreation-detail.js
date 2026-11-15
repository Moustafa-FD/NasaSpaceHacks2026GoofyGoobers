// Mapped recreation areas with original, illustrative equipment/architecture.
// A sport is drawn only when its source tags name it. Generic park furniture
// never invents a named facility. All geometry is one color-baked static batch.
import {triangulateWaterPolygon} from './terrain-mesh.js';
import {resolveRoadWidth} from './road-mesh.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),finite=Number.isFinite;
const hash=(s)=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
const area=(p)=>Math.abs(p.reduce((n,a,i)=>{const b=p[(i+1)%p.length];return n+a[0]*b[1]-b[0]*a[1];},0))/2;
const bounds=(p)=>[Math.min(...p.map(v=>v[0])),Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),Math.max(...p.map(v=>v[1]))];
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function inside(p,ring){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
const inFeature=(p,f)=>inside(p,f.polygon)&&!(f.holes||[]).some(h=>inside(p,h));
function intersects(a,b,c,d){return cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))+1e-7&&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]))+1e-7;}
function overlap(poly,feature){
  if(poly.some(p=>inFeature(p,feature)))return true;
  if(feature.polygon.some(p=>inside(p,poly)))return true;
  for(const ring of [feature.polygon,...(feature.holes||[])])for(let i=0;i<poly.length;i++)for(let j=0;j<ring.length;j++)if(intersects(poly[i],poly[(i+1)%poly.length],ring[j],ring[(j+1)%ring.length]))return true;
  return false;
}
function contained(poly,feature){
  if(!poly.every(p=>inFeature(p,feature)))return false;
  // Corners alone miss a pond/hole contained wholly inside a large placement.
  for(const hole of feature.holes||[])if(hole.some(p=>inside(p,poly)))return false;
  for(const ring of [feature.polygon,...(feature.holes||[])])for(let i=0;i<poly.length;i++)for(let j=0;j<ring.length;j++)if(intersects(poly[i],poly[(i+1)%poly.length],ring[j],ring[(j+1)%ring.length]))return false;
  return true;
}
function rect(x,y,w,d,angle=0){const c=Math.cos(angle),s=Math.sin(angle);return [[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]].map(([e,n])=>[x+e*c-n*s,y+e*s+n*c]);}
function fit(poly){
  let best;
  for(let i=0;i<poly.length;i+=Math.max(1,Math.floor(poly.length/20))){const a=poly[i],b=poly[(i+1)%poly.length],angle=Math.atan2(b[1]-a[1],b[0]-a[0]),c=Math.cos(angle),s=Math.sin(angle),p=poly.map(([x,y])=>[x*c+y*s,-x*s+y*c]),v=bounds(p),size=(v[2]-v[0])*(v[3]-v[1]);
    if(!best||size<best.area){const x=(v[0]+v[2])/2,y=(v[1]+v[3])/2;best={x:x*c-y*s,y:x*s+y*c,width:v[2]-v[0],depth:v[3]-v[1],angle,area:size};}}
  return best;
}
class Index{
  constructor(size=90){this.size=size;this.cells=new Map();}
  insert(item,b){for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++){const k=x+','+y;if(!this.cells.has(k))this.cells.set(k,[]);this.cells.get(k).push(item);}}
  query(b){const found=new Set();for(let x=Math.floor(b[0]/this.size);x<=Math.floor(b[2]/this.size);x++)for(let y=Math.floor(b[1]/this.size);y<=Math.floor(b[3]/this.size);y++)for(const v of this.cells.get(x+','+y)||[])found.add(v);return found;}
}
export function recreationSport(feature){
  const tags=feature.tags||{},sports=String(tags.sport||'').split(';');
  for(const name of ['tennis','basketball','soccer','baseball','softball','volleyball','american_football'])if(sports.includes(name))return name;
  return null; // Unknown/multi/football is not silently turned into soccer.
}

export function buildRecreationDetail(snapshot,heightAt,{urban,recreation,detail='close',buildings=[],maxTriangles,maxProps=420,maxFeatures=160}={}){
  if(typeof heightAt!=='function')throw new TypeError('Recreation requires the actual rendered terrain height sampler');
  const overview=detail==='overview',budget=maxTriangles??(overview?10000:65000),group={name:'mapped-recreation',color:'#ffffff',category:0,positions:[],normals:[],indices:[],colors:[]};
  const stats={sourceStatus:recreation?.status||'unavailable',sourceFeatures:recreation?.features?.length||0,parks:0,sportsFields:0,playgrounds:0,pavilions:0,picnicTables:0,benches:0,fitness:0,communityBuildings:0,triangles:0,props:0,skippedBlocked:0,skippedBudget:0,skippedMissingTerrain:0,sportKinds:{}};
  const placements=[],replacementBuildingIds=[],blocked=new Index(),occupied=new Index(),pitchIndex=new Index(),radius=snapshot.radiusM||3300;
  const sourceBuildings=new Map((snapshot.buildings||[]).map(b=>[b.id,b]));
  for(const b of buildings)if(!sourceBuildings.has(b.id)&&finite(b.x)&&finite(b.y)&&b.width>0&&b.depth>0)sourceBuildings.set(b.id,{id:b.id,polygon:rect(b.x,b.y,b.width,b.depth,b.angle)});
  for(const b of sourceBuildings.values())if(b.polygon?.length>=3)blocked.insert({...b,obstacle:'building'},bounds(b.polygon));
  for(const f of snapshot.areas||[])if(f.kind==='water'&&f.polygon?.length>=3)blocked.insert({...f,obstacle:'water'},bounds(f.polygon));
  const roadTags=new Map((urban?.roadTags||[]).map(r=>[r.id,r.tags||{}]));
  for(const road of snapshot.roads||[]){if(/^(construction|proposed|abandoned)$/.test(road.kind))continue;const w=resolveRoadWidth(road,roadTags.get(road.id.match(/^(way\/\d+)/)?.[1]||road.id)).width;
    for(let i=1;i<road.points.length;i++){const a=road.points[i-1],b=road.points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<.1)continue;const p=rect((a[0]+b[0])/2,(a[1]+b[1])/2,length+.5,w+.6,Math.atan2(b[1]-a[1],b[0]-a[0]));blocked.insert({id:road.id,polygon:p,obstacle:'road'},bounds(p));}}
  const features=new Map((recreation?.status==='ready'?recreation.features:[]).map(f=>[f.id,f]));
  for(const f of snapshot.areas||[])if(f.kind==='park'&&!features.has(f.id))features.set(f.id,{...f,kind:'park',tags:{},fallback:true});
  const byKind=new Map();
  for(const f of features.values()){if(f.tags?.indoor==='yes'||f.tags?.access==='no')continue;const b=f.polygon?fit(f.polygon):{x:f.x,y:f.y};if(!b)continue;const entry={...f,sortDistance:Math.hypot(b.x,b.y)};if(!byKind.has(f.kind))byKind.set(f.kind,[]);byKind.get(f.kind).push(entry);}
  for(const group of byKind.values())group.sort((a,b)=>a.sortDistance-b.sortDistance||a.id.localeCompare(b.id));
  // Interleave source categories so a dense town's hundred pitches cannot
  // consume the whole feature budget before its playgrounds or picnic areas.
  const ordered=[],cycle=['pitch','playground','pavilion','park','community','pitch','picnic_site','fitness','picnic_table','bench'];let changed=true;
  while(changed&&ordered.length<maxFeatures){changed=false;for(const kind of cycle){const list=byKind.get(kind);if(list?.length&&ordered.length<maxFeatures){ordered.push(list.shift());changed=true;}}}
  for(const f of ordered)if(f.kind==='pitch'&&f.polygon?.length>=3)pitchIndex.insert(f,bounds(f.polygon));
  const colors=new Map(),color=(hex)=>{if(!colors.has(hex))colors.set(hex,hex.replace('#','').match(/../g).map(v=>(parseInt(v,16)/255)**2.2).concat(1));return colors.get(hex);};
  const sufficient=(n)=>{if(stats.triangles+n>budget||stats.props>=maxProps){stats.skippedBudget++;return false;}return true;};
  function tri3(points,paint){
    if(stats.triangles>=budget)return false;
    const p=points.map(([x,y,z])=>[x,z,-y]),u=p[1].map((v,i)=>v-p[0][i]),v=p[2].map((v,i)=>v-p[0][i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n);if(len<1e-8)return false;
    const start=group.positions.length/3;for(const q of p){group.positions.push(...q);group.normals.push(...n.map(v=>v/len));group.colors.push(...color(paint));}group.indices.push(start,start+1,start+2);stats.triangles++;return true;
  }
  const face=(p,c)=>{for(let i=1;i<p.length-1;i++)tri3([p[0],p[i],p[i+1]],c);};
  function box(x,y,z,w,d,h,angle,paint){const bottom=rect(x,y,w,d,angle).map(p=>[...p,z]),p=[...bottom,...bottom.map(([a,b,c])=>[a,b,c+h])];for(const f of [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]])face(f.map(i=>p[i]),paint);}
  function beam(a,b,width,paint){
    const delta=b.map((v,i)=>v-a[i]),l=Math.hypot(...delta);if(l<.01)return;const v=delta.map(n=>n/l),helper=Math.abs(v[2])>.9?[1,0,0]:[0,0,1],u=[v[1]*helper[2]-v[2]*helper[1],v[2]*helper[0]-v[0]*helper[2],v[0]*helper[1]-v[1]*helper[0]],ul=Math.hypot(...u);for(let i=0;i<3;i++)u[i]/=ul;const w=[v[1]*u[2]-v[2]*u[1],v[2]*u[0]-v[0]*u[2],v[0]*u[1]-v[1]*u[0]],rings=[a,b].map(p=>[[-1,-1],[1,-1],[1,1],[-1,1]].map(([s,t])=>p.map((n,i)=>n+(u[i]*s+w[i]*t)*width/2)));
    for(let i=0;i<4;i++){const j=(i+1)%4;face([rings[0][i],rings[0][j],rings[1][j],rings[1][i]],paint);}
  }
  function protectedFootprint(poly,{feature,ignoreId,excludePitch=false,occupancy=true}={}){
    if(poly.some(p=>!p.every(finite)||Math.max(Math.abs(p[0]),Math.abs(p[1]))>radius-1)||feature&&!contained(poly,feature))return false;
    const b=bounds(poly);for(const obstacle of blocked.query(b))if(!(obstacle.obstacle==='building'&&obstacle.id===ignoreId)&&overlap(poly,obstacle))return false;
    if(excludePitch)for(const pitch of pitchIndex.query(b))if(overlap(poly,pitch))return false;
    if(occupancy)for(const item of occupied.query(b))if(overlap(poly,item))return false;
    return true;
  }
  function place(feature,kind,x,y,w,d,angle=0,{within=feature.polygon?feature:null,cost=100,ignoreId,source=feature.fallback?'illustrative-park':'mapped',excludePitch=false}={}){
    if(!sufficient(cost))return null;const polygon=rect(x,y,w,d,angle);
    if(!protectedFootprint(polygon,{feature:within,ignoreId,excludePitch})){stats.skippedBlocked++;return null;}
    const samples=[...polygon,[x,y]].map(p=>heightAt(...p));if(samples.some(h=>!finite(h))){stats.skippedMissingTerrain++;return null;}
    const z=heightAt(x,y)+.2,placement={id:feature.id+':'+kind+':'+placements.length,sourceId:feature.id,kind,source,footprint:polygon,x,y,z,angle,...(feature.tags?.name?{name:feature.tags.name}:{})};
    occupied.insert({id:placement.id,polygon},bounds(polygon));placements.push(placement);stats.props++;return placement;
  }
  function local(p,x,y,z=0){const c=Math.cos(p.angle),s=Math.sin(p.angle);return [p.x+x*c-y*s,p.y+x*s+y*c,p.z+z];}
  function bench(p){box(p.x,p.y,p.z+.44,2,.55,.13,p.angle,'#9a784d');for(const x of [-.7,.7]){const q=local(p,x,0);box(q[0],q[1],p.z,.12,.45,.48,p.angle,'#5b716c');}const q=local(p,0,.24,.85);box(q[0],q[1],q[2],2,.1,.42,p.angle,'#9a784d');stats.benches++;}
  function table(p){box(p.x,p.y,p.z+.76,2.2,1.05,.13,p.angle,'#a18760');for(const y of [-.83,.83]){const q=local(p,0,y,.44);box(q[0],q[1],q[2],2.3,.35,.12,p.angle,'#9a784d');}for(const x of [-.7,.7]){const q=local(p,x,0);box(q[0],q[1],p.z,.14,1.7,.78,p.angle,'#5a6c64');}stats.picnicTables++;}
  function pavilion(p,w=6,d=5,playTower=false){
    const eave=overview?2.8:2.7,ridge=eave+1.2,paint=['#9d6753','#597f81','#7d7564'][hash(p.sourceId)%3];
    for(const x of [-w*.43,w*.43])for(const y of [-d*.42,d*.42]){const q=local(p,x,y);box(q[0],q[1],p.z,.2,.2,eave,p.angle,'#8d795d');}
    const q=(x,y,z)=>local(p,x,y,z);
    face([q(-w/2,-d/2,eave),q(0,-d/2,ridge),q(0,d/2,ridge),q(-w/2,d/2,eave)],paint);
    face([q(0,-d/2,ridge),q(w/2,-d/2,eave),q(w/2,d/2,eave),q(0,d/2,ridge)],paint);
    face([q(-w/2,-d/2,eave),q(w/2,-d/2,eave),q(0,-d/2,ridge)],paint);face([q(w/2,d/2,eave),q(-w/2,d/2,eave),q(0,d/2,ridge)],paint);
    if(!overview&&!playTower){const t={...p,x:p.x,y:p.y,z:p.z};table(t);}if(!playTower)stats.pavilions++;
  }
  function playground(p,type){
    const q=(x,y,z)=>local(p,x,y,z);
    if(type===0){
      for(const x of [-2.2,2.2])for(const side of [-1,1])beam(q(x,side*1.1,0),q(x,0,2.8),.16,'#5a8292');beam(q(-2.5,0,2.8),q(2.5,0,2.8),.18,'#ca9c53');
      if(!overview)for(const x of [-1,1]){beam(q(x-.3,0,2.7),q(x-.3,0,.68),.035,'#6b7370');beam(q(x+.3,0,2.7),q(x+.3,0,.68),.035,'#6b7370');const a=q(x,0,.62);box(a[0],a[1],a[2],.8,.36,.1,p.angle,'#b86c54');}
    }else if(type===1){
      const t={...p};pavilion(t,2.8,2.8,true); // A small covered play tower, not a named building.
      const deck=q(0,0,1.35);box(deck[0],deck[1],deck[2],2.1,2.1,.14,p.angle,'#bca66f');
      face([q(.7,-.9,1.48),q(.7,-4,0.1),q(-.7,-4,0.1),q(-.7,-.9,1.48)],'#bd7152');
      if(!overview)for(let i=0;i<5;i++){const a=q(0,1.15+i*.28,.2+i*.25);box(a[0],a[1],a[2],1.1,.22,.12,p.angle,'#789a85');}
    }else{
      beam(q(-2.3,0,.55),q(2.3,0,.85),.21,'#cfac61');box(p.x,p.y,p.z,.38,.8,.65,p.angle,'#697f7a');for(const x of [-2.1,2.1]){const a=q(x,0,.8);box(a[0],a[1],a[2],.8,.55,.1,p.angle,'#6189a0');}
    }
  }
  function surfaceTri(points,paint,lift=.23){
    if(!protectedFootprint(points,{occupancy:false})){stats.skippedBlocked++;return false;}
    let p=points.map(([x,y])=>{const h=heightAt(x,y);return finite(h)?[x,y,h+lift]:null;});if(p.some(v=>!v)){stats.skippedMissingTerrain++;return false;}
    if(cross(...points)<0)p=[p[0],p[2],p[1]];return tri3(p,paint);
  }
  function paintArea(feature,paint){
    const queue=[...triangulateWaterPolygon(feature,{shoreSimplificationM:0}).triangles],spacing=overview?28:10;let count=0,drawn=false;
    while(queue.length&&count++<10000&&stats.triangles<budget){const t=queue.pop(),lengths=t.map((p,i)=>Math.hypot(p[0]-t[(i+1)%3][0],p[1]-t[(i+1)%3][1])),i=lengths.indexOf(Math.max(...lengths));
      if(lengths[i]>spacing){const a=t[i],b=t[(i+1)%3],c=t[(i+2)%3],m=[(a[0]+b[0])/2,(a[1]+b[1])/2];queue.push([a,m,c],[m,b,c]);}else drawn=surfaceTri(t,paint)||drawn;}
    return drawn;
  }
  function line(a,b,width,paint,feature){const l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(l<.01)return;const steps=Math.ceil(l/8),nx=-(b[1]-a[1])/l*width/2,ny=(b[0]-a[0])/l*width/2;
    for(let i=0;i<steps;i++){const p=[a[0]+(b[0]-a[0])*i/steps,a[1]+(b[1]-a[1])*i/steps],q=[a[0]+(b[0]-a[0])*(i+1)/steps,a[1]+(b[1]-a[1])*(i+1)/steps],r=[[p[0]-nx,p[1]-ny],[q[0]-nx,q[1]-ny],[q[0]+nx,q[1]+ny],[p[0]+nx,p[1]+ny]];
      if(feature&&!contained(r,feature))continue;surfaceTri([r[0],r[1],r[2]],paint,.27);surfaceTri([r[0],r[2],r[3]],paint,.27);}}
  function sportsField(f){
    if(!f.polygon||!sufficient(500))return;const sport=recreationSport(f),paint=['tennis','basketball','volleyball'].includes(sport)?'#628d88':'#74915a';
    if(!paintArea(f,paint))return;stats.sportsFields++;stats.sportKinds[sport||'unspecified']=(stats.sportKinds[sport||'unspecified']||0)+1;
    const b=fit(f.polygon);if(!b)return;if(b.width>b.depth){[b.width,b.depth]=[b.depth,b.width];b.angle+=Math.PI/2;}
    const centerHeight=heightAt(b.x,b.y);if(!finite(centerHeight)){stats.skippedMissingTerrain++;return;}
    let w=b.width*.88,d=b.depth*.88;const p={...b,z:centerHeight+.3};
    // Find a conservative inscribed rectangle for illustrative line/equipment
    // placement. Mapped irregular surfaces retain their original polygon/holes.
    for(let n=0;n<8&&!contained(rect(b.x,b.y,w,d,b.angle),f);n++){w*=.85;d*=.85;}
    if(!(w>6&&d>6)||!contained(rect(b.x,b.y,w,d,b.angle),f))return;
    const q=(x,y)=>local(p,x,y).slice(0,2),corners=[q(-w/2,-d/2),q(w/2,-d/2),q(w/2,d/2),q(-w/2,d/2)];
    for(let i=0;i<4;i++)line(corners[i],corners[(i+1)%4],.14,'#e8e6d0',f);
    const prop=(kind,x,y,pw,pd,cost,fn)=>{const at=q(x,y),a=place(f,kind,at[0],at[1],pw,pd,b.angle,{cost,within:f});if(a)fn(a);};
    if(sport==='tennis'||sport==='volleyball'){
      line(q(-w/2,0),q(w/2,0),.1,'#e8e6d0',f);
      prop(sport+'-net',0,0,w+.25,.65,overview?24:330,(a)=>{const left=local(a,-w/2,0),right=local(a,w/2,0),h=sport==='tennis'?1.05:2.35;beam(left,[...left.slice(0,2),left[2]+h],.09,'#c4ccc2');beam(right,[...right.slice(0,2),right[2]+h],.09,'#c4ccc2');beam([left[0],left[1],left[2]+h],[right[0],right[1],right[2]+h],.035,'#e4e4d4');
        if(!overview){for(let i=1;i<Math.min(30,Math.ceil(w/.55));i++){const at=local(a,-w/2+w*i/Math.ceil(w/.55),0);beam([at[0],at[1],at[2]+h*.35],[at[0],at[1],at[2]+h],.018,'#6f7770');}}});
      if(!overview&&sport==='tennis'){for(const y of [-d*.25,d*.25])line(q(-w*.4,y),q(w*.4,y),.11,'#e8e6d0',f);line(q(0,-d*.25),q(0,d*.25),.11,'#e8e6d0',f);}
    }else if(sport==='soccer'){
      line(q(-w/2,0),q(w/2,0),.13,'#e8e6d0',f);
      for(const y of [-d*.46,d*.46])prop('soccer-goal',0,y,Math.min(7.4,w*.35),2,120,(a)=>{if(y<0)a.angle+=Math.PI;const span=Math.min(7.1,w*.32),h=2.35;for(const x of [-span/2,span/2]){const foot=local(a,x,0);beam(foot,[foot[0],foot[1],foot[2]+h],.1,'#dedfd0');}beam(local(a,-span/2,0,h),local(a,span/2,0,h),.1,'#dedfd0');if(!overview)for(const x of [-span/2,span/2]){beam(local(a,x,0,h),local(a,x,.9,0),.065,'#b9c4ba');}});
    }else if(sport==='basketball'){
      line(q(-w/2,0),q(w/2,0),.1,'#e8e6d0',f);
      for(const y of [-d*.45,d*.45])prop('basketball-hoop',0,y,2.3,1.8,100,(a)=>{if(y<0)a.angle+=Math.PI;const pole=local(a,0,.5);box(pole[0],pole[1],a.z,.12,.12,3.15,a.angle,'#71827c');const board=local(a,0,0,3.05);box(board[0],board[1],board[2],1.8,.1,1.0,a.angle,'#c8d0bf');if(!overview){const ring=local(a,0,-.4,3.05);for(let k=0;k<8;k++){const t=k*Math.PI/4,u=(k+1)*Math.PI/4;beam([ring[0]+Math.cos(t)*.24,ring[1]+Math.sin(t)*.24,ring[2]],[ring[0]+Math.cos(u)*.24,ring[1]+Math.sin(u)*.24,ring[2]],.045,'#bc7850');}}});
    }else if(sport==='baseball'||sport==='softball'){
      const size=Math.min(w,d)*.34,home=q(0,-size),a=q(-size,0),second=q(0,size),c=q(size,0);paintArea({polygon:[home,a,second,c]},'#ae9066');for(const [x,y]of [[home,a],[a,second],[second,c],[c,home]])line(x,y,.14,'#e8e6d0',f);
      prop('baseball-backstop',0,-size,Math.min(8,w*.4),1.2,100,(a)=>{const span=Math.min(8,w*.4);for(const x of [-span/2,0,span/2]){const p=local(a,x,0);beam(p,[p[0],p[1],p[2]+3],.08,'#8d9b8f');}for(const h of [1.2,2.8])beam(local(a,-span/2,0,h),local(a,span/2,0,h),.04,'#8d9b8f');});
    }else if(sport==='american_football'){
      for(let i=1;i<10;i++)line(q(-w*.48,-d/2+d*i/10),q(w*.48,-d/2+d*i/10),.12,'#e8e6d0',f);
      for(const y of [-d*.46,d*.46])prop('football-uprights',0,y,Math.min(6,w*.35),1,90,(a)=>{const span=Math.min(5,w*.3);beam(local(a,0,0,0),local(a,0,0,3),.12,'#d3b862');beam(local(a,-span/2,0,3),local(a,span/2,0,3),.1,'#d3b862');for(const x of [-span/2,span/2])beam(local(a,x,0,3),local(a,x,0,5),.1,'#d3b862');});
    }
    placements.push({id:f.id+':field',sourceId:f.id,kind:'pitch',source:'mapped',sport:sport||null,footprint:f.polygon,x:b.x,y:b.y});
  }
  for(const f of ordered.slice(0,maxFeatures)){
    if(stats.triangles>=budget)break;
    if(f.kind==='pitch'){sportsField(f);continue;}
    const b=f.polygon?fit(f.polygon):{x:f.x,y:f.y,width:f.kind==='pavilion'?6:20,depth:f.kind==='pavilion'?5:20,angle:hash(f.id)%628/100};if(!b||![b.x,b.y].every(finite))continue;
    if(f.kind==='park'){
      stats.parks++;if(overview||!f.polygon)continue;
      const bb=bounds(f.polygon),step=65,limit=12;let made=0,candidates=0;
      for(let y=bb[1]+13;y<bb[3]-8&&made<limit&&candidates<800;y+=step)for(let x=bb[0]+13;x<bb[2]-8&&made<limit&&candidates++<800;x+=step){
        const seed=hash(f.id+':'+x+':'+y),tableHere=seed%3===0,w=tableHere?2.7:2.3,d=tableHere?2.4:.9;
        const p=place(f,tableHere?'picnic-table':'bench',x+(seed%1300)/100-6.5,y+((seed>>>8)%1300)/100-6.5,w,d,(seed%628)/100,{cost:80,excludePitch:true,source:'illustrative-park'});
        if(p){tableHere?table(p):bench(p);made++;}}
    }else if(f.kind==='playground'){
      let drawn=f.polygon?paintArea(f,'#b3a17d'):false;
      const offsets=overview?[[0,0,1]]:[[-b.width*.23,0,0],[b.width*.2,0,1],[0,b.depth*.24,2]];
      for(const [x,y,type]of offsets){const c=Math.cos(b.angle),s=Math.sin(b.angle),p=place(f,'play-equipment',b.x+x*c-y*s,b.y+x*s+y*c,type===1?4.5:6,type===1?8:3,b.angle,{cost:overview?150:400});if(p){playground(p,type);drawn=true;}}if(drawn)stats.playgrounds++;
    }else if(f.kind==='pavilion'){
      if(/^(public_transport|tent|weather_shelter)$/.test(f.tags?.shelter_type||''))continue;
      const w=Math.min(12,Math.max(3,b.width*.85)),d=Math.min(10,Math.max(3,b.depth*.85)),p=place(f,'pavilion',b.x,b.y,w,d,b.angle,{cost:150,ignoreId:f.tags?.building?f.id:undefined});if(p){pavilion(p,w,d);if(sourceBuildings.has(f.id))replacementBuildingIds.push(f.id);}
    }else if(f.kind==='community'){
      const building=buildings.find(v=>v.id===f.id);if(!building||!f.polygon)continue;
      const w=Math.min(8,building.width*.5),d=Math.min(4,building.depth*.35),p=place(f,'community-roof',building.x,building.y,w,d,building.angle,{cost:100,ignoreId:f.id});
      if(p){p.z=heightAt(p.x,p.y)+(building.height||8)+.15;box(p.x,p.y,p.z,w,d,.3,p.angle,'#64888a');const q=local(p,0,0,.3);box(q[0],q[1],q[2],w*.7,d*.6,.55,p.angle,'#b8c3b8');stats.communityBuildings++;}
    }else if(!overview&&(f.kind==='bench'||f.kind==='picnic_table'||f.kind==='picnic_site')){
      const isBench=f.kind==='bench',p=place(f,isBench?'bench':'picnic-table',b.x,b.y,isBench?2.3:2.7,isBench?.9:2.4,b.angle,{cost:90});if(p)isBench?bench(p):table(p);
      if(f.kind==='picnic_site')for(const dx of [-4,4]){const p=place(f,'picnic-table',b.x+dx,b.y+2,2.7,2.4,b.angle,{cost:90});if(p)table(p);}
    }else if(f.kind==='fitness'){
      const p=place(f,'fitness-bars',b.x,b.y,4.5,2.5,b.angle,{cost:100});if(p){for(const x of [-1.6,0,1.6]){const q=local(p,x,0);beam(q,[q[0],q[1],q[2]+2.4],.1,'#5e8688');}beam(local(p,-1.6,0,2.4),local(p,1.6,0,2.4),.1,'#6b9894');stats.fitness++;}
    }
  }
  const focus=placements.filter(p=>['pitch','play-equipment','pavilion','fitness-bars'].includes(p.kind)).sort((a,b)=>Math.hypot(a.x,a.y)-Math.hypot(b.x,b.y))[0]||placements[0];
  return {groups:group.indices.length?[group]:[],stats:{...stats,drawCalls:group.indices.length?1:0},focus:focus?{x:focus.x,y:focus.y,sourceId:focus.sourceId,kind:focus.kind,...(focus.name?{name:focus.name}:{})}:null,placements,replacementBuildingIds};
}
