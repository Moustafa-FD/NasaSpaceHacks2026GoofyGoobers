// Artistic activity on mapped roads. Counts and aircraft are not traffic observations.
import { sampleElevation } from './landscape.js';
import { createCityLifeModelPack } from './city-life-models.js';
const finite=(v)=>typeof v==='number'&&Number.isFinite(v);
const hash=(value)=>{let n=2166136261;for(const c of String(value))n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;};
const mod=(n,d)=>((n%d)+d)%d;
const drivable=(kind)=>!/footway|path|steps|cycleway|track|pedestrian|rail/.test(kind||'');
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

/** Retain mapped bends, including short constituent segments. The optional third
 * coordinate is the actual generated road's ENU surface height, not DEM height. */
export function trafficRoutes(roads=[]){
  const routes=[],groups=new Map();
  function add(points,road,id){
    const clean=[];
    for(const p of points||[])if(Array.isArray(p)&&finite(p[0])&&finite(p[1])&&(!clean.length||Math.hypot(p[0]-clean.at(-1)[0],p[1]-clean.at(-1)[1])>.1))clean.push(p);
    const segments=[];let length=0;
    for(let i=1;i<clean.length;i++){
      const a=clean[i-1],b=clean[i],size=Math.hypot(b[0]-a[0],b[1]-a[1]);
      segments.push({a,b,length:size,start:length,width:road.width||6,kind:road.kind});length+=size;
    }
    if(length>40)routes.push({...road,id:String(id),a:clean[0],b:clean.at(-1),points:clean,segments,length});
  }
  roads.forEach((road,index)=>{
    if(!drivable(road.kind))return;
    if(Array.isArray(road.points)){add(road.points,road,road.id??index);return;}
    if(!Array.isArray(road.a)||!Array.isArray(road.b)||![...road.a.slice(0,2),...road.b.slice(0,2)].every(finite))return;
    const id=String(road.id??index),key=id.replace(/:\d+$/,'')+':'+(road.kind||'');
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...road,id,sequence:Number(id.match(/:(\d+)$/)?.[1]||0)});
  });
  for(const [id,parts] of groups){
    parts.sort((a,b)=>a.sequence-b.sequence);let points=[],prototype=parts[0],part=0;
    for(const road of parts){
      if(!points.length)points=[road.a,road.b];
      else if(Math.hypot(points.at(-1)[0]-road.a[0],points.at(-1)[1]-road.a[1])<.5)points.push(road.b);
      else if(Math.hypot(points.at(-1)[0]-road.b[0],points.at(-1)[1]-road.b[1])<.5)points.push(road.a);
      else {add(points,prototype,id+':'+part++);points=[road.a,road.b];prototype=road;}
    }
    add(points,prototype,id+':'+part);
  }
  return routes;
}

export function sampleRoadLane(road,distanceAlong,direction=1,result={}){
  const segments=road.segments||[{a:road.a,b:road.b,length:Math.hypot(road.b[0]-road.a[0],road.b[1]-road.a[1]),start:0,width:road.width}],length=road.length||segments.at(-1)?.start+segments.at(-1)?.length;
  if(!(length>0)||!finite(distanceAlong))return null;
  const sign=direction<0?-1:1,along=mod(distanceAlong,length),absolute=sign>0?along:length-along;
  let lo=0,hi=segments.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(segments[m].start+segments[m].length<absolute)lo=m+1;else hi=m;}
  const segment=segments[lo],dx=segment.b[0]-segment.a[0],dy=segment.b[1]-segment.a[1],t=Math.max(0,Math.min(1,(absolute-segment.start)/segment.length));
  const lane=Math.min(1.65,Math.max(.5,(segment.width||6)*.23));
  result.x=segment.a[0]+dx*t+dy/segment.length*lane*sign;result.y=segment.a[1]+dy*t-dx/segment.length*lane*sign;
  result.z=finite(segment.a[2])&&finite(segment.b[2])?segment.a[2]+(segment.b[2]-segment.a[2])*t:null;
  result.angle=Math.atan2(dy*sign,dx*sign);result.visible=along>=4&&along<=length-4;result.segment=segment;result.t=t;return result;
}

/** Projection onto a real path, used for camera-near pooling rather than random
 * placement across the entire 6.6 km scene. No new roads or connections. */
export function nearestRoutePoint(route,point){
  let best={distance:Infinity,along:0,x:0,y:0};
  for(const s of route.segments){
    const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],t=Math.max(0,Math.min(1,((point.x-s.a[0])*dx+(point.y-s.a[1])*dy)/(s.length*s.length)));
    const x=s.a[0]+dx*t,y=s.a[1]+dy*t,d=Math.hypot(x-point.x,y-point.y);
    if(d<best.distance)best={distance:d,along:s.start+t*s.length,x,y};
  }
  return best;
}

/** Fallback for the older ribbon roads: interpolate the same two triangles as
 * SurfaceMesh.ribbon. Bilinear DEM alone can bury cars under a long road. */
export function ribbonRoadHeight(point,heightAt){
  if(finite(point.z))return point.z;
  const s=point.segment,dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],half=(s.width||6)/2,nx=-dy/s.length*half,ny=dx/s.length*half;
  const t=point.t,u=Math.max(0,Math.min(1,.5+((point.x-s.a[0])*nx+(point.y-s.a[1])*ny)/(2*half*half)));
  const h=[heightAt(s.a[0]-nx,s.a[1]-ny),heightAt(s.b[0]-nx,s.b[1]-ny),heightAt(s.b[0]+nx,s.b[1]+ny),heightAt(s.a[0]+nx,s.a[1]+ny)];
  return .2+(u<=t?(1-t)*h[0]+(t-u)*h[1]+u*h[2]:(1-u)*h[0]+t*h[2]+(u-t)*h[3]);
}

const BUDGETS={inactive:{cars:0,people:0,planes:0,details:0},low:{cars:80,people:4,planes:2,details:10},far:{cars:140,people:0,planes:3,details:0},balanced:{cars:140,people:12,planes:3,details:28},high:{cars:220,people:20,planes:4,details:40}};
export function activityBudget(quality='high',height=0,active=true){return !active?BUDGETS.inactive:quality==='low'?BUDGETS.low:height>1600?BUDGETS.far:quality==='balanced'?BUDGETS.balanced:BUDGETS.high;}

/** Length-sampled real roads, stratified by city cells and eight compass sectors.
 * Every prefix retains a 20% foreground quota; the rest covers a 2.4 km radius.
 * No new streets or off-road traffic are invented. */
export function planTrafficDistribution(routes,focus,count=220,radius=2400){
  const slots=[];let nearest=Infinity;
  for(const road of routes){
    const near=nearestRoutePoint(road,focus);nearest=Math.min(nearest,near.distance);
    if(near.distance>radius)continue;
    const steps=Math.max(1,Math.ceil((road.length-16)/105));
    for(let i=0;i<steps;i++){
      const along=8+(i+.5)*(road.length-16)/steps,p=sampleRoadLane(road,along),d=distance(p,focus);
      if(d<=radius)slots.push({road,along,x:p.x,y:p.y,distance:d,seed:hash(road.id+':slot:'+i)});
    }
  }
  if(!slots.length)return [];
  function deck(items,size){
    const cells=new Map(),sectors=Array.from({length:8},()=>[]),cursors=new Uint32Array(8);let turn=0;
    for(const slot of items){const key=Math.floor((slot.x-focus.x)/size)+','+Math.floor((slot.y-focus.y)/size);if(!cells.has(key))cells.set(key,{items:[],cursor:0,key});cells.get(key).items.push(slot);}
    for(const cell of cells.values()){
      cell.items.sort((a,b)=>a.seed-b.seed);const p=cell.items[0],sector=Math.min(7,Math.floor((Math.atan2(p.y-focus.y,p.x-focus.x)+Math.PI)/(Math.PI/4)));
      sectors[sector].push(cell);
    }
    for(const sector of sectors)sector.sort((a,b)=>hash(a.key)-hash(b.key));
    return ()=>{for(let i=0;i<8;i++){const sector=turn++%8,buckets=sectors[sector];if(!buckets.length)continue;const cell=buckets[cursors[sector]++%buckets.length];return cell.items[cell.cursor++%cell.items.length];}return null;};
  }
  const foreground=slots.filter((p)=>p.distance<Math.max(420,nearest+200)),city=slots.filter((p)=>p.distance>380);
  const closeDeck=deck(foreground.length?foreground:slots,120),wideDeck=deck(city.length?city:slots,360),plan=[];
  for(let i=0;i<count;i++){
    const foreground=i%5===0,slot=(foreground?closeDeck:wideDeck)();
    plan.push({...slot,direction:i%2?1:-1,foreground,cell:Math.floor((slot.x-focus.x)/360)+','+Math.floor((slot.y-focus.y)/360)});
  }
  return plan;
}

export function attachCityLife(viewer,site,sceneData){
  const C=sceneData.Cesium||globalThis.Cesium,center=sceneData.center;
  const frame=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(center.lon,center.lat)),inverse=C.Matrix4.inverseTransformation(frame,new C.Matrix4());
  const paths=trafficRoutes(sceneData.roadPaths?.length?sceneData.roadPaths:sceneData.roads);
  const initialFocus=sceneData.campusFocus||sceneData.focus||{x:0,y:0},campus=(sceneData.campuses||[])[0];
  const entities=[],cars=[],planes=[],details=[],people=[],personPositions=[],walkSamples=[];
  const populationLimit=Math.min(220,Math.floor(paths.reduce((sum,p)=>sum+p.length,0)*2/18));
  let active=false,destroyed=false,quality='high',pack,pointCollection,trafficPoints,lastTime=null,time=0,lastRank=-Infinity,lastReport=-Infinity;
  let focus={x:initialFocus.x,y:initialFocus.y},poolFocus={...focus},flightFocus={...focus},ranked=[],distribution=[];
  let stats={active:false,cars:0,planes:0,people:0,moving:false,illustrative:true,routeCount:paths.length};
  const now=()=>globalThis.performance?.now?.()??Date.now();
  const baseGround=(x,y)=>4+(sampleElevation(sceneData.elevation,x,y)??0)-(x*x+y*y)/(2*6371000);
  const offsetAt=(x,y)=>{const value=sceneData.heightOffset?.(x,y);return finite(value)?value:0;};
  const ground=(x,y)=>baseGround(x,y)+offsetAt(x,y);
  const cameraLocal=new C.Cartesian3(),velocityScratch=new C.Cartesian3(),directionScratch=new C.Cartesian3(),rotationScratch=new C.Matrix3();
  const quaternionScratch=C.Quaternion.clone&&C.Quaternion.IDENTITY?C.Quaternion.clone(C.Quaternion.IDENTITY):undefined;
  const world=(x,y,z,result=new C.Cartesian3())=>C.Matrix4.multiplyByPoint(frame,new C.Cartesian3(x,y,z),result);
  const orientation=(position,angle)=>{
    directionScratch.x=Math.cos(angle);directionScratch.y=Math.sin(angle);directionScratch.z=0;
    const velocity=C.Matrix4.multiplyByPointAsVector(frame,directionScratch,velocityScratch);
    // Cesium's glTF default correction maps authored +Y up/+Z forward to
    // +Z up/+X forward; this velocity frame therefore needs no extra yaw.
    return C.Quaternion.fromRotationMatrix(C.Transforms.rotationMatrixFromPositionVelocity(position,velocity,C.Ellipsoid.WGS84,rotationScratch),quaternionScratch);
  };
  function entityModel(url,type,index,scale=1){
    const entity=viewer.entities.add({id:`city-life-${site.id}-${type}-${index}`,show:false,position:world(0,0,ground(0,0)),model:{uri:url,scale,
      minimumPixelSize:0,maximumScale:1,
      shadows:C.ShadowMode.CAST_ONLY,distanceDisplayCondition:new C.DistanceDisplayCondition(0,type==='plane'?6500:type==='detail'?1400:1400)}});
    entity.lowPoly=true;entities.push(entity);return entity;
  }
  function positionEntity(entity,x,y,z,angle,cache){const position=world(x,y,z,cache?.position||new C.Cartesian3());entity.position.setValue(position);if(!cache||cache.heading!==angle){const value=orientation(position,angle);if(entity.orientation)entity.orientation.setValue(value);else entity.orientation=value;if(cache)cache.heading=angle;}return position;}
  function cameraFocus(){
    const camera=viewer.camera,canvas=viewer.canvas||viewer.scene.canvas;
    if(camera.getPickRay&&canvas){
      const ray=camera.getPickRay(new C.Cartesian2(canvas.clientWidth/2,canvas.clientHeight/2));
      if(ray){
        const origin=C.Matrix4.multiplyByPoint(inverse,ray.origin,new C.Cartesian3()),direction=C.Matrix4.multiplyByPointAsVector(inverse,ray.direction,new C.Cartesian3());
        Object.assign(cameraLocal,origin);
        if(direction.z<-.01){
          let h=ground(focus.x,focus.y),x=focus.x,y=focus.y;
          for(let i=0;i<2;i++){const t=(h-origin.z)/direction.z;x=origin.x+direction.x*t;y=origin.y+direction.y*t;h=ground(x,y);}
          if(finite(x)&&finite(y)&&Math.abs(x)<(sceneData.radius||3600)*1.3&&Math.abs(y)<(sceneData.radius||3600)*1.3)return {x,y};
        }
      }
    }
    return {...focus};
  }
  function assign(car,choice,index){
    const road=choice.road;
    car.road=road;car.direction=choice.direction;car.foreground=choice.foreground;
    const along=Math.max(8,Math.min(road.length-8,choice.along+(hash(site.id+':car:'+index)%2100)/100-10.5));
    car.distance=(car.direction>0?along:road.length-along)-time*car.speed;car.last=null;car.heading=undefined;
  }
  function rank(force=false){
    const at=now();if(!force&&at-lastRank<1000)return;lastRank=at;
    focus=cameraFocus();
    ranked=paths.map((road)=>({road,...nearestRoutePoint(road,focus)})).sort((a,b)=>a.distance-b.distance||hash(a.road.id)-hash(b.road.id));
    const cameraMoved=distance(poolFocus,focus)>150;
    if(!distribution.length||cameraMoved)distribution=planTrafficDistribution(paths,focus,220);
    cars.forEach((car,index)=>{
      // Keep a visible car on its path. Recycle only cars well outside the new
      // camera neighborhood, never teleport an on-screen car each second.
      const offscreen=!car.position||!inViewport(car.position);
      const far=car.last&&distance(car.last,focus)>2800;
      if(distribution.length&&(!car.road||(cameraMoved&&offscreen)||far))assign(car,distribution[index%distribution.length],index);
    });
    if(cameraMoved)poolFocus={...focus};
    if(distance(flightFocus,focus)>250&&planes.filter((p)=>p.entity.show).every((p)=>!p.position||!inViewport(p.position))){
      flightFocus={...focus};
      // Re-enter the new neighborhood over its target, only after the previous
      // flyover has left the screen. Keep visible aircraft on their flight path.
      planes.forEach((p,i)=>{p.phase=i*2.05-time*.038;});
    }
  }
  function create(){
    if(pack)return;pack=createCityLifeModelPack();
    trafficPoints=viewer.scene.primitives.add(new C.PointPrimitiveCollection());
    const paints=['#8cb6b0','#ba7567','#c4aa75','#d8dfd8','#7696b3','#728286'].map((c)=>C.Color.fromCssColorString(c));
    if(paths.length)for(let i=0;i<populationLimit;i++){
      const seed=hash(site.id+':car:'+i);
      const choice=seed%100,vehicle=choice<70?pack.vehicles[seed%6]:choice<86?pack.vehicles[6+seed%2]:choice<92?pack.vehicles[8]:pack.vehicles[9+seed%2];
      cars.push({entity:entityModel(vehicle.url,'car',i),point:trafficPoints.add({show:false,position:world(0,0,0),pixelSize:1,color:paints[seed%paints.length],id:{lowPoly:true}}),
        kind:vehicle.kind,length:vehicle.length,road:null,distance:0,speed:7+(seed%500)/100,direction:1,last:null,sample:{},position:new C.Cartesian3(),heading:undefined});
    }
    // Original prop, regional jet and cargo silhouettes keep their authored
    // relative dimensions. No screen-size inflation or giant scaled props.
    for(let i=0;i<4;i++){const kind=['prop','regional','cargo','prop'][i];planes.push({entity:entityModel(pack.planes[kind],'plane',i),kind,altitude:[180,300,440,240][i],phase:i*2.05,position:new C.Cartesian3()});}
    pointCollection=viewer.scene.primitives.add(new C.PointPrimitiveCollection());
    if(campus&&[campus.x,campus.y,campus.width,campus.depth].every(finite))for(let i=0;i<20;i++){people.push(pointCollection.add({show:false,position:world(campus.x,campus.y,ground(campus.x,campus.y)+1),pixelSize:2.5,color:C.Color.fromCssColorString(i%2?'#dfb388':'#c8e3da'),outlineWidth:0,id:{lowPoly:true},distanceDisplayCondition:new C.DistanceDisplayCondition(0,900)}));personPositions.push(new C.Cartesian3());walkSamples.push({});}
    rank(true);flightFocus={...focus};
    const roadside=ranked.filter((r)=>/primary|secondary|tertiary|residential/.test(r.road.kind||''));
    for(let i=0;i<Math.min(40,roadside.length*2);i++){
      const route=roadside[i%roadside.length],p=sampleRoadLane(route.road,route.along+(i%2?18:-18),i%2?1:-1),s=p.segment;
      const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],side=i%2?1:-1,x=p.x+dy/s.length*((s.width||6)/2+1)*side,y=p.y-dx/s.length*((s.width||6)/2+1)*side;
      const entity=entityModel(i%5===0?pack.sign:pack.lamp,'detail',i);positionEntity(entity,x,y,ground(x,y),p.angle);details.push({entity,x,y,angle:p.angle});
    }
  }
  function inViewport(position){
    if(!C.SceneTransforms?.worldToWindowCoordinates)return true;
    const p=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,position),canvas=viewer.canvas||viewer.scene.canvas;
    return !!(p&&canvas&&p.x>=0&&p.y>=0&&p.x<=canvas.clientWidth&&p.y<=canvas.clientHeight);
  }
  function aircraftScreenPositions(visiblePlanes){
    if(!C.SceneTransforms?.worldToWindowCoordinates)return [];
    return visiblePlanes.flatMap((plane)=>{
      const p=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,plane.position);
      return p&&finite(p.x)&&finite(p.y)?[{id:plane.entity.id,x:p.x,y:p.y,inView:inViewport(plane.position)}]:[];
    });
  }
  function report(force=false){
    const at=now();if(!force&&at-lastReport<1000)return;lastReport=at;
    const visibleCars=cars.filter((c)=>c.entity.show||c.point.show),visiblePlanes=planes.filter((p)=>p.entity.show);
    stats={active,cars:visibleCars.length,planes:visiblePlanes.length,people:people.filter((p)=>p.show).length,
      carsInView:visibleCars.filter((c)=>inViewport(c.position)).length,planesInView:visiblePlanes.filter((p)=>inViewport(p.position)).length,aircraftScreen:aircraftScreenPositions(visiblePlanes),
      // Running is user intent, not whether this particular render advanced.
      // First frames, quality changes and ignored year jumps all have dt=0.
      moving:active&&viewer.clock.shouldAnimate!==false&&viewer.clock.multiplier!==0,illustrative:true,routeCount:paths.length,closestRoadM:ranked[0]?.distance??null,focus:{...focus},quality,
      carModels:visibleCars.filter((c)=>c.entity.show).length,carPoints:visibleCars.filter((c)=>c.point.show).length,distributionRadiusM:2400,
      vehicleKinds:Object.fromEntries(['car','van','bus','delivery'].map((kind)=>[kind,visibleCars.filter((c)=>c.kind===kind).length])),aircraftKinds:visiblePlanes.map((p)=>p.kind)};
    sceneData.onActivity?.({...stats});
  }
  function update(dt,forceReport=false){
    const cameraHeight=(viewer.camera?.positionCartographic?.height||0)-(sampleElevation(sceneData.elevation,0,0)||0),budget=activityBudget(quality,cameraHeight,active);
    rank();time+=dt;
    const cameraPosition=viewer.camera.positionWC||viewer.camera.position;
    if(cameraPosition)C.Matrix4.multiplyByPoint(inverse,cameraPosition,cameraLocal);
    const canvas=viewer.canvas||viewer.scene.canvas,focal=(canvas?.clientHeight||700)/(2*Math.tan((viewer.camera.frustum?.fovy||Math.PI/3)/2));
    cars.forEach((car,i)=>{
      car.entity.show=false;car.point.show=false;
      if(!car.road||i>=budget.cars)return;
      const p=sampleRoadLane(car.road,car.distance+time*car.speed,car.direction,car.sample);car.last=p;
      if(!p.visible||distance(p,focus)>2800)return;
      const z=ribbonRoadHeight(p,baseGround)+offsetAt(p.x,p.y)+.08,range=Math.hypot(p.x-cameraLocal.x,p.y-cameraLocal.y,z-cameraLocal.z);
      world(p.x,p.y,z,car.position);
      if(range<1050){car.entity.show=true;positionEntity(car.entity,p.x,p.y,z,p.angle,car);}
      else {car.point.show=true;car.point.position=car.position;car.point.pixelSize=Math.max(.65,Math.min(2,car.length*focal/range*.65));}
    });
    planes.forEach((plane,i)=>{
      plane.entity.show=i<budget.planes;if(!plane.entity.show)return;
      const a=plane.phase+time*(plane.kind==='prop'?.038:.032),x=flightFocus.x+Math.sin(a)*1050,y=flightFocus.y+Math.sin(a*2)*430;
      plane.position=positionEntity(plane.entity,x,y,ground(x,y)+plane.altitude,Math.atan2(Math.cos(a*2)*860,Math.cos(a)*1050),plane);
    });
    people.forEach((person,i)=>{person.show=i<budget.people;if(!person.show)return;
      if(i>=8&&distribution.length){const choice=distribution[((i-8)*5)%distribution.length],p=sampleRoadLane(choice.road,choice.along+time*.9,1,walkSamples[i]),s=p.segment,off=(s.width||6)/2+1-Math.min(1.65,Math.max(.5,(s.width||6)*.23)),x=p.x+(s.b[1]-s.a[1])/s.length*off,y=p.y-(s.b[0]-s.a[0])/s.length*off;
        person.position=world(x,y,(p.z??baseGround(x,y))+.9+offsetAt(x,y),personPositions[i]);return;}
      const w=campus.width+18,d=campus.depth+18,perimeter=2*(w+d),p=mod(time*.9+i*perimeter/8,perimeter);let x,y;
      if(p<w){x=p-w/2;y=-d/2;}else if(p<w+d){x=w/2;y=p-w-d/2;}else if(p<2*w+d){x=w/2-(p-w-d);y=d/2;}else{x=-w/2;y=d/2-(p-2*w-d);}
      const a=campus.angle||0,e=campus.x+x*Math.cos(a)-y*Math.sin(a),n=campus.y+x*Math.sin(a)+y*Math.cos(a);person.position=world(e,n,ground(e,n)+1,personPositions[i]);});
    details.forEach((detail,i)=>{detail.entity.show=i<budget.details&&cameraHeight<1000;if(detail.entity.show)detail.position=positionEntity(detail.entity,detail.x,detail.y,ground(detail.x,detail.y),detail.angle,detail);});
    report(forceReport);
  }
  function tick(scene,current){
    if(!active||destroyed){lastTime=null;return;}
    current ||= viewer.clock.currentTime;
    let delta=lastTime?C.JulianDate.secondsDifference(current,lastTime):0;
    lastTime=C.JulianDate.clone(current,lastTime||new C.JulianDate());
    // Clock time already includes the speed multiplier. Ignore timeline jumps.
    if(viewer.clock.shouldAnimate===false||viewer.clock.multiplier===0||!(delta>0&&delta<=2))delta=0;
    update(Math.min(.5,delta));
  }
  const removeTick=viewer.scene.preRender.addEventListener(tick);
  return {
    setActive(value){if(destroyed)return;active=!!value;lastTime=null;if(active){create();update(0,true);}else{for(const entity of entities)entity.show=false;for(const car of cars)car.point.show=false;if(pointCollection)pointCollection.show=false;if(trafficPoints)trafficPoints.show=false;report(true);}if(pointCollection)pointCollection.show=active;if(trafficPoints)trafficPoints.show=active;},
    setQuality(value){if(destroyed)return;quality=['high','balanced','low'].includes(value)?value:'high';if(active&&pack)update(0,true);},
    getStats(){return {...stats};},get stats(){return {...stats};},
    destroy(){if(destroyed)return;active=false;for(const entity of entities)entity.show=false;for(const car of cars)car.point.show=false;for(const person of people)person.show=false;report(true);destroyed=true;removeTick();for(const entity of entities)viewer.entities.remove(entity);if(pointCollection)viewer.scene.primitives.remove(pointCollection);if(trafficPoints)viewer.scene.primitives.remove(trafficPoints);pack?.destroy();entities.length=cars.length=planes.length=details.length=people.length=0;},
  };
}
