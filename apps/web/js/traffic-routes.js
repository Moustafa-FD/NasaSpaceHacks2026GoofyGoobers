// Bounded illustrative road traffic. Connectivity comes from mapped geometry;
// grade-separated crossings are not fabricated junctions. Coordinates are ENU.
const finite=Number.isFinite,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const hash=(s)=>{let h=2166136261;for(const c of String(s))h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
const length=(a,b)=>Math.hypot(b[0]-a[0],b[1]-a[1]);
const drivable=(kind)=>!/footway|path|steps|cycleway|track|pedestrian|rail|construction|proposed|abandoned/.test(kind||'');
const level=(road)=>String(road.tags?.layer||'0')+(/^(yes|true|1)$/.test(road.tags?.bridge||'')?'b':'')+(/^(yes|true|1)$/.test(road.tags?.tunnel||'')?'t':'');
const oneWay=(road)=>{const s=String(road.oneway??road.tags?.oneway??(road.tags?.junction==='roundabout'?'yes':'no')).toLowerCase();return s==='-1'?-1:/^(yes|true|1)$/.test(s)?1:0;};

// Road ribbons are resampled every 12 m for terrain. Collapse only redundant
// straight samples that reproduce both XY (1 cm) and road height (2 mm).
// Retain bends and elevation changes so cars cannot sink under the road mesh.
function compactPath(points){
  const out=[];
  for(const p of points){
    if(!Array.isArray(p)||!finite(p[0])||!finite(p[1]))continue;
    if(out.length&&length(out.at(-1),p)<.05)continue;out.push(p);
    while(out.length>=3){
      const a=out.at(-3),b=out.at(-2),c=out.at(-1),dx=c[0]-a[0],dy=c[1]-a[1],size=dx*dx+dy*dy;
      if(size<.01)break;
      const t=((b[0]-a[0])*dx+(b[1]-a[1])*dy)/size;
      const sameHeight=[a[2],b[2],c[2]].every(finite)?Math.abs(b[2]-(a[2]+(c[2]-a[2])*t))<=.002:![a[2],b[2],c[2]].some(finite);
      if(t<=0||t>=1||!sameHeight||Math.hypot(b[0]-a[0]-dx*t,b[1]-a[1]-dy*t)>.01)break;
      out.splice(out.length-2,1);
    }
  }
  return out;
}

export function buildTrafficGraph(roads=[],{maxSegments=45000,maxIntersectionChecks=1500000}={}){
  const raw=[],cells=new Map();let checks=0,limited=false;
  for(const [index,road] of roads.entries()){
    if(!drivable(road.kind))continue;
    const source={...road,id:String(road.id??index)};
    const points=compactPath(road.points||[road.a,road.b]);
    for(let i=1;i<points.length;i++)if(length(points[i-1],points[i])>.1){
      if(raw.length>=maxSegments){limited=true;break;}
      raw.push({a:points[i-1],b:points[i],road:source,i,endA:i===1,endB:i===points.length-1,splits:[0,1]});
    }
    if(limited)break;
  }
  // A uniform index avoids checking every pair of source segments. Shared
  // resampled vertices connect even when the intersection-pair budget is hit.
  for(let i=0;i<raw.length;i++){
    const s=raw[i],west=Math.floor(Math.min(s.a[0],s.b[0])/100),east=Math.floor(Math.max(s.a[0],s.b[0])/100),south=Math.floor(Math.min(s.a[1],s.b[1])/100),north=Math.floor(Math.max(s.a[1],s.b[1])/100),seen=new Set();
    for(let x=west;x<=east;x++)for(let y=south;y<=north;y++){
      const key=x+','+y,bucket=cells.get(key)||[];
      for(const j of bucket){
        if(seen.has(j)||checks>=maxIntersectionChecks)continue;seen.add(j);checks++;
        const t=raw[j];if(s.road.id===t.road.id||level(s.road)!==level(t.road))continue;
        const ax=s.b[0]-s.a[0],ay=s.b[1]-s.a[1],bx=t.b[0]-t.a[0],by=t.b[1]-t.a[1],den=ax*by-ay*bx;
        if(Math.abs(den)<1e-8)continue;
        const dx=t.a[0]-s.a[0],dy=t.a[1]-s.a[1],u=(dx*by-dy*bx)/den,v=(dx*ay-dy*ax)/den;
        if(u<-.00001||u>1.00001||v<-.00001||v>1.00001)continue;
        const endpoint=(u<.00001||u>.99999)&&(v<.00001||v>.99999);
        if(!endpoint&&![s.a[2],s.b[2],t.a[2],t.b[2]].every(finite))continue;
        const h1=(s.a[2]||0)+((s.b[2]||0)-(s.a[2]||0))*u,h2=(t.a[2]||0)+((t.b[2]||0)-(t.a[2]||0))*v;
        if(Math.abs(h1-h2)>2)continue;
        s.splits.push(clamp(u,0,1));t.splits.push(clamp(v,0,1));
      }
      bucket.push(i);cells.set(key,bucket);
    }
  }
  const nodes=[],nodeCells=new Map(),pieces=[];
  function node(point,road,endpoint){
    const key=Math.round(point[0]*4)+','+Math.round(point[1]*4),bucket=nodeCells.get(key)||[];
    let found=bucket.find((n)=>(n.level===level(road)||(endpoint&&n.endpoint))&&(!finite(n.z)||!finite(point[2])||Math.abs(n.z-point[2])<=2));
    if(!found){found={id:nodes.length,x:point[0],y:point[1],z:point[2],level:level(road),endpoint,edges:[],out:[]};nodes.push(found);bucket.push(found);nodeCells.set(key,bucket);}
    return found;
  }
  for(const s of raw){
    const values=[...new Set(s.splits.map((t)=>Math.round(t*1e8)/1e8))].sort((a,b)=>a-b);
    const at=(t)=>[s.a[0]+(s.b[0]-s.a[0])*t,s.a[1]+(s.b[1]-s.a[1])*t,...([s.a[2],s.b[2]].every(finite)?[s.a[2]+(s.b[2]-s.a[2])*t]:[])];
    for(let i=1;i<values.length;i++){
      const a=at(values[i-1]),b=at(values[i]);if(length(a,b)<.1)continue;
      const from=node(a,s.road,s.endA&&values[i-1]===0),to=node(b,s.road,s.endB&&values[i]===1);
      if(from===to)continue;
      const edge={id:pieces.length,from,to,road:s.road,a,b};pieces.push(edge);from.edges.push(edge);to.edges.push(edge);
    }
  }
  const arcs=[],byRoad=new Map(),visited=new Set();
  function addArc(points,from,to,road,sourceDirection,chain){
    const segments=[];let total=0;
    const width=finite(Number(road.width))&&Number(road.width)>0?Number(road.width):6;
    const lane=oneWay(road)?(width>=6?Math.min(1.6,width*.2):0):Math.min(1.75,width/4);
    const offsets=points.map((p,i)=>{
      const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)],before=i?length(a,p):0,after=i<points.length-1?length(p,b):0;
      const ax=before?(p[0]-a[0])/before:(b[0]-p[0])/after,ay=before?(p[1]-a[1])/before:(b[1]-p[1])/after;
      const bx=after?(b[0]-p[0])/after:ax,by=after?(b[1]-p[1])/after:ay;
      let nx=ay+by,ny=-ax-bx,n=Math.hypot(nx,ny);if(n<.001)return [by*lane,-bx*lane];
      nx/=n;ny/=n;const scale=Math.min(1.8,1/Math.max(.45,nx*by-ny*bx));return [nx*lane*scale,ny*lane*scale];
    });
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i],size=length(a,b);
      segments.push({a,b,length:size,start:total,width,offsetA:offsets[i-1],offsetB:offsets[i]});total+=size;
    }
    if(total<2)return;
    const arc={id:arcs.length,chain,from:from.id,to:to.id,roadId:road.id,kind:road.kind,service:road.tags?.service,width,oneway:oneWay(road)!==0,sourceDirection,points,segments,length:total,lane,reverseId:null};
    arcs.push(arc);from.out.push(arc);if(!byRoad.has(road.id))byRoad.set(road.id,[]);byRoad.get(road.id).push(arc);return arc;
  }
  const pass=(n,road)=>{
    if(n.edges.length!==2||!n.edges.every((e)=>e.road.id===road.id))return false;
    const a=n.edges[0].from===n?n.edges[0].to:n.edges[0].from,b=n.edges[1].from===n?n.edges[1].to:n.edges[1].from;
    const ax=a.x-n.x,ay=a.y-n.y,bx=b.x-n.x,by=b.y-n.y;
    // A sharp bend needs the same continuous steering curve as a junction.
    return (ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by)) < -0.9063;
  };
  for(const edge of pieces){
    if(visited.has(edge.id))continue;
    const start=!pass(edge.to,edge.road)&&pass(edge.from,edge.road)?edge.to:edge.from;
    let current=start,piece=edge,points=[],last=start,direction=piece.from===start?1:-1;
    while(piece&&!visited.has(piece.id)){
      visited.add(piece.id);const forward=piece.from===current,next=forward?piece.to:piece.from;
      if(!points.length)points.push(forward?piece.a:piece.b);points.push(forward?piece.b:piece.a);last=next;
      if(!pass(next,edge.road)||next===start)break;
      const nextPiece=next.edges.find((e)=>!visited.has(e.id));current=next;piece=nextPiece;
    }
    const one=oneWay(edge.road),chain=arcs.length;
    const a=one===0||one===direction?addArc(points,start,last,edge.road,direction,chain):null;
    const b=one===0||one===-direction?addArc([...points].reverse(),last,start,edge.road,-direction,chain):null;
    if(a&&b){a.reverseId=b.id;b.reverseId=a.id;}
  }
  for(const arc of arcs)arc.deadEnd=arc.reverseId!=null&&nodes[arc.to].out.every((next)=>next.id===arc.reverseId);
  // Construction-only incident pieces retain all source points/metadata. Drop
  // them before handing this graph to the runtime or a worker structured clone.
  for(const n of nodes){delete n.edges;delete n.level;delete n.endpoint;}
  return {nodes,arcs,byRoad,locks:new Map(),stats:{nodes:nodes.length,arcs:arcs.length,sourceSegments:raw.length,intersectionChecks:checks,limited:limited||checks>=maxIntersectionChecks}};
}

export function vehicleFitsRoad(arc,vehicle){
  const width=vehicle.width||1.92,min=arc.oneway?width+.6:(vehicle.minRoadWidth||Math.max(4,width*2+.1));
  // Do not route a long bus/truck into a narrow dead end where its body cannot
  // turn. It can leave that road toward an onward junction, or use wider ways.
  const access=arc.service==='parking_aisle'?(vehicle.length||4.24)<=5.6:arc.service==='driveway'?(vehicle.length||4.24)<=6:true;
  return access&&arc.width>=min&&arc.length>=2&&(!arc.deadEnd||arc.width>=(vehicle.length||4.24)+.4);
}

export function sampleTrafficArc(arc,distance,out={}){
  const d=clamp(distance,0,arc.length),segments=arc.segments;let lo=0,hi=segments.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(segments[m].start+segments[m].length<d)lo=m+1;else hi=m;}
  const s=segments[lo],t=clamp((d-s.start)/s.length,0,1),a=s.offsetA,b=s.offsetB;
  out.x=s.a[0]+(s.b[0]-s.a[0])*t+a[0]+(b[0]-a[0])*t;
  out.y=s.a[1]+(s.b[1]-s.a[1])*t+a[1]+(b[1]-a[1])*t;
  out.z=[s.a[2],s.b[2]].every(finite)?s.a[2]+(s.b[2]-s.a[2])*t:null;
  out.angle=Math.atan2(s.b[1]-s.a[1]+b[1]-a[1],s.b[0]-s.a[0]+b[0]-a[0]);
  out.visible=true;out.segment=s;out.t=t;return out;
}
const trim=(arc,vehicle)=>Math.min(arc.length*.24,Math.max(4,vehicle.length*.75+arc.lane+2));

function occupiedDistances(state){
  return state.turn?[[state.arc.id,state.arc.length-trim(state.arc,state.vehicle)],[state.turn.next.id,state.turn.after]]:[[state.arc.id,state.distance]];
}
export function trafficStatesConflict(a,b,clearance=4){
  if(!a||!b)return false;
  if(a.turn&&b.turn&&a.turn.junction===b.turn.junction)return true;
  return occupiedDistances(a).some(([arc,d])=>occupiedDistances(b).some(([other,e])=>arc===other&&Math.abs(d-e)<(a.vehicle.length+b.vehicle.length)/2+clearance));
}

export function updateTrafficSpawnIndex(index,vehicle,state=vehicle.route){
  for(const old of index.members.get(vehicle)||[]){const bucket=index.arcs.get(old.arc),at=bucket?.indexOf(old);if(at>=0)bucket.splice(at,1);}
  const entries=[];
  if(state)for(const [arc,distance] of occupiedDistances(state)){
    let bucket=index.arcs.get(arc);if(!bucket){bucket=[];index.arcs.set(arc,bucket);}
    const entry={arc,distance,length:vehicle.length,vehicle};let lo=0,hi=bucket.length;
    while(lo<hi){const m=(lo+hi)>>1;if(bucket[m].distance<distance)lo=m+1;else hi=m;}
    bucket.splice(lo,0,entry);entries.push(entry);
  }
  index.members.set(vehicle,entries);
}
export function createTrafficSpawnIndex(vehicles){
  const index={arcs:new Map(),members:new Map()};
  for(const vehicle of vehicles)updateTrafficSpawnIndex(index,vehicle);return index;
}
function indexedSpawnConflict(index,arc,distance,profile,ignoreVehicle){
  const bucket=index.arcs.get(arc)||[];let lo=0,hi=bucket.length;
  while(lo<hi){const m=(lo+hi)>>1;if(bucket[m].distance<distance)lo=m+1;else hi=m;}
  // Only local lane neighbors can obstruct this spot. Skip the vehicle being
  // recycled rather than rebuilding an O(pool-size) scan for every candidate.
  for(const direction of [-1,1]){
    let checked=0;
    for(let i=direction<0?lo-1:lo;i>=0&&i<bucket.length&&checked<3;i+=direction){
      const entry=bucket[i];if(entry.vehicle===ignoreVehicle)continue;checked++;
      if(Math.abs(entry.distance-distance)<(entry.length+profile.length)/2+5.5)return true;
    }
  }
  return false;
}

export function spawnTrafficVehicle(graph,vehicles,slot,profile,seed=0,{index,ignoreVehicle,maxDistanceM=Infinity}={}){
  const candidates=(graph.byRoad.get(slot.road.id)||[]).filter((arc)=>vehicleFitsRoad(arc,profile)).map((arc)=>{
    let along=0,best=Infinity;
    for(const s of arc.segments){
      const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],t=clamp(((slot.x-s.a[0])*dx+(slot.y-s.a[1])*dy)/(s.length*s.length),0,1);
      const d=Math.hypot(s.a[0]+dx*t-slot.x,s.a[1]+dy*t-slot.y);if(d<best){best=d;along=s.start+t*s.length;}
    }
    return {arc,along,best};
  });
  candidates.sort((a,b)=>a.best-b.best||(a.arc.sourceDirection===slot.direction?0:1)-(b.arc.sourceDirection===slot.direction?0:1)||a.arc.id-b.arc.id);
  for(const {arc,along} of candidates){
    const start=trim(arc,profile)+profile.length/2,end=arc.length-trim(arc,profile)-profile.length/2,gap=profile.length+6.5;
    for(let attempt=0;attempt<40;attempt++){
      const delta=attempt===0?0:Math.ceil(attempt/2)*gap*(attempt%2?1:-1),distance=along+delta;
      if(distance<start||distance>end)continue;
      if(Number.isFinite(maxDistanceM)){const p=sampleTrafficArc(arc,distance);if(Math.hypot(p.x-slot.x,p.y-slot.y)>maxDistanceM)continue;}
      // Leave acceleration room above the four-metre following minimum so a
      // newly seeded dense convoy does not begin as a stationary bumper queue.
      if(index?indexedSpawnConflict(index,arc.id,distance,profile,ignoreVehicle):vehicles.some((v)=>v.route&&occupiedDistances(v.route).some(([id,d])=>id===arc.id&&Math.abs(d-distance)<(v.length+profile.length)/2+5.5)))continue;
      return {arc,distance,turn:null,next:null,planned:false,seed,visits:0,speed:profile.speed||9,waits:0,sample:{},vehicle:profile};
    }
  }
  return null;
}

function nextArc(graph,state){
  const incoming=sampleTrafficArc(state.arc,state.arc.length),candidates=graph.nodes[state.arc.to].out.filter((arc)=>vehicleFitsRoad(arc,state.vehicle));
  const onward=candidates.filter((arc)=>arc.id!==state.arc.reverseId),choices=onward.length?onward:candidates;
  if(!onward.length&&state.arc.reverseId!=null&&state.arc.width<state.vehicle.length+.4)return null;
  choices.sort((a,b)=>{
    const score=(arc)=>{const p=sampleTrafficArc(arc,0);return (hash(state.seed+':'+state.visits+':'+arc.id)/4294967296)+(1-Math.cos(p.angle-incoming.angle))*.65;};
    return score(a)-score(b)||a.id-b.id;
  });
  return choices[0]||null;
}

function makeTurn(state,next){
  const before=trim(state.arc,state.vehicle),after=trim(next,state.vehicle),a=sampleTrafficArc(state.arc,state.arc.length-before),b=sampleTrafficArc(next,after);
  const control=Math.max(2,Math.min(before,after)*.85),c=[a.x+Math.cos(a.angle)*control,a.y+Math.sin(a.angle)*control],d=[b.x-Math.cos(b.angle)*control,b.y-Math.sin(b.angle)*control];
  const points=[];let total=0;
  for(let i=0;i<=16;i++){
    const t=i/16,q=1-t,p=[q*q*q*a.x+3*q*q*t*c[0]+3*q*t*t*d[0]+t*t*t*b.x,q*q*q*a.y+3*q*q*t*c[1]+3*q*t*t*d[1]+t*t*t*b.y];
    if(i)total+=length(points.at(-1).p,p);points.push({p,at:total});
  }
  return {next,after,progress:0,length:total,points,a,b,junction:state.arc.to};
}

export function sampleTrafficVehicle(state,out=state.sample){
  if(!state.turn)return sampleTrafficArc(state.arc,state.distance,out);
  const turn=state.turn,d=clamp(turn.progress,0,turn.length);let i=1;while(i<turn.points.length-1&&turn.points[i].at<d)i++;
  const a=turn.points[i-1],b=turn.points[i],t=(d-a.at)/Math.max(.0001,b.at-a.at);
  out.x=a.p[0]+(b.p[0]-a.p[0])*t;out.y=a.p[1]+(b.p[1]-a.p[1])*t;
  out.z=finite(turn.a.z)&&finite(turn.b.z)?turn.a.z+(turn.b.z-turn.a.z)*d/turn.length:null;
  out.angle=Math.atan2(b.p[1]-a.p[1],b.p[0]-a.p[0]);out.visible=true;out.segment=turn.a.segment;out.t=turn.a.t;return out;
}

/** All vehicles advance from one shared occupancy snapshot. A junction admits
 * one turn at a time and same-lane leaders retain bumper clearance. */
export function advanceTraffic(graph,vehicles,dt){
  if(!(dt>0))return;
  dt=Math.min(.25,dt);
  const active=vehicles.filter((v)=>v.route),occupancy=new Map(),owners=new Map(active.map((v)=>[v.route.seed,v]));
  for(const v of active){
    const s=v.route;if(!s.planned){s.next=nextArc(graph,s);s.planned=true;}
    const add=(id,distance)=>{if(!occupancy.has(id))occupancy.set(id,[]);occupancy.get(id).push({v,distance});};
    if(s.turn){add(s.arc.id,s.arc.length-trim(s.arc,v));add(s.turn.next.id,s.turn.after);graph.locks.set(s.turn.junction,s.seed);}
    else add(s.arc.id,s.distance);
  }
  for(const list of occupancy.values())list.sort((a,b)=>a.distance-b.distance);
  const exitBlocked=(v)=>{const s=v.route,leader=s.next?(occupancy.get(s.next.id)||[]).find((item)=>item.v!==v):null;
    return !s.next||!!(leader&&leader.distance<trim(s.next,v)+(v.length+leader.v.length)/2+5);};
  for(const [node,seed] of graph.locks){const v=owners.get(seed),s=v?.route;if(!s||(!s.turn&&(s.arc.to!==node||s.arc.length-s.distance>trim(s.arc,v)+22||exitBlocked(v))))graph.locks.delete(node);}
  const approaching=[...active].filter((v)=>!v.route.turn&&v.route.next).sort((a,b)=>(a.route.arc.length-a.route.distance)-(b.route.arc.length-b.route.distance)||a.route.seed-b.route.seed);
  for(const v of approaching){const s=v.route;if(s.arc.length-s.distance<trim(s.arc,v)+20&&!exitBlocked(v)&&!graph.locks.has(s.arc.to))graph.locks.set(s.arc.to,s.seed);}
  for(const v of active){
    const s=v.route,street=s.turn?.next||s.arc;
    const limit=street.service==='parking_aisle'?2.8:street.service==='driveway'?2.3:street.kind==='service'?4:street.kind==='living_street'?4.5:street.kind==='residential'?8:15;
    const desired=Math.min(v.speed||s.vehicle.speed||9,limit);
    s.speed=Math.min(desired,s.speed+dt*2);
    let move=s.speed*dt;
    if(!s.turn){
      const ahead=(occupancy.get(s.arc.id)||[]).find((item)=>item.v!==v&&item.distance>s.distance);
      if(ahead)move=Math.min(move,Math.max(0,ahead.distance-s.distance-(v.length+ahead.v.length)/2-4));
      const end=s.arc.length-trim(s.arc,v),owner=graph.locks.get(s.arc.to);
      const leader=s.next?(occupancy.get(s.next.id)||[]).find((item)=>item.v!==v):null;
      const blocked=!s.next||owner!==s.seed||(leader&&leader.distance<trim(s.next,v)+(v.length+leader.v.length)/2+5);
      if(blocked)move=Math.min(move,Math.max(0,end-s.distance));
      if(s.distance+move>=end-.00001&&s.next&&!blocked){
        const consumed=Math.max(0,end-s.distance);s.distance=end;s.turn=makeTurn(s,s.next);move=Math.max(0,move-consumed);
      }else if(!s.turn){s.distance+=move;if(move<.001)s.speed=0;continue;}
    }
    s.turn.progress+=move;
    if(s.turn.progress>=s.turn.length){
      const turn=s.turn;s.arc=turn.next;s.distance=turn.after+(turn.progress-turn.length);s.turn=null;s.next=null;s.planned=false;s.visits++;
    }
    if(move<.001)s.speed=0;
  }
}
