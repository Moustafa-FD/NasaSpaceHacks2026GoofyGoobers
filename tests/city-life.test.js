import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficRoutes,sampleRoadLane,activityBudget,trafficModelBudget,nearestRoutePoint,ribbonRoadHeight,planTrafficDistribution,attachCityLife} from '../apps/web/js/city-life.js';
import {buildCityLifeModels,createCityLifeModelPack,ROAD_VEHICLE_SCALE} from '../apps/web/js/city-life-models.js';
test('lane samples retain real positions and never wrap or hide at road ends',()=>{
  const road={a:[0,0],b:[100,0],width:8,kind:'residential'};
  const east=sampleRoadLane(road,25,1),west=sampleRoadLane(road,25,-1);
  assert.equal(east.x,25);assert.equal(west.x,75);assert.ok(east.y<0&&west.y>0);assert.ok(Math.abs(east.y)<road.width/2);
  assert.equal(sampleRoadLane(road,100).visible,true);assert.equal(sampleRoadLane(road,125).x,100);
  assert.equal(trafficRoutes([road,{...road,kind:'footway'},{...road,b:[20,0]}]).length,2,'short mapped connector ways remain available');
  assert.equal(sampleRoadLane({a:[1,1],b:[1,1]},2),null);
});
test('city activity respects camera and quality budgets',()=>{
  assert.deepEqual(activityBudget('high',600),{cars:510,people:20,planes:4,details:40});
  assert.deepEqual(activityBudget('high',2000),{cars:300,people:0,planes:3,details:0});
  assert.deepEqual(activityBudget('low',600),{cars:150,people:4,planes:2,details:10});
  assert.equal(activityBudget('balanced',600).cars,300);
  assert.deepEqual(['low','balanced','high'].map((q)=>trafficModelBudget(q,600)),[25,50,85]);
  assert.equal(trafficModelBudget('high',2000),0);assert.equal(trafficModelBudget('high',0,false),0);
  assert.deepEqual(activityBudget('high',600,false),{cars:0,people:0,planes:0,details:0});
});

test('connected short mapped segments preserve bends and exact road-top heights',()=>{
  const [road]=trafficRoutes([{id:'mapped',kind:'residential',width:7,points:[[0,0,102],[20,0,104],[40,0,106],[40,20,108],[40,40,110]]}]);
  assert.equal(road.length,80);
  const p=sampleRoadLane(road,50);
  assert.equal(p.y,10);assert.ok(p.x>40);assert.equal(p.z,107);assert.equal(p.angle,Math.PI/2);
  assert.equal(ribbonRoadHeight(p,()=>-999),107);
  assert.equal(nearestRoutePoint(road,{x:44,y:30}).along,70);
  const joined=trafficRoutes([{id:'way/1:1',kind:'residential',a:[0,0],b:[20,0]},{id:'way/1:2',kind:'residential',a:[20,0],b:[40,0]},{id:'way/1:3',kind:'residential',a:[40,0],b:[40,20]}]);
  assert.equal(joined.length,1);assert.equal(joined[0].length,60);
  assert.equal(trafficRoutes([{kind:'cycleway',points:road.points}]).length,0);
});

test('fallback road height follows rendered ribbon triangles instead of bilinear DEM below the road',()=>{
  const road={a:[0,0],b:[100,0],width:8};
  const p=sampleRoadLane(road,50);
  const h=ribbonRoadHeight(p,(x)=>x===0||x===100?20:0);
  assert.equal(h,20.2);
});

function readModel(buffer){
  const view=new DataView(buffer),length=view.getUint32(12,true),doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length))),start=28+length;
  const values=(i)=>{const a=doc.accessors[i],b=doc.bufferViews[a.bufferView];return new Float32Array(buffer,start+(b.byteOffset||0),a.count*3);};
  return {doc,values};
}

test('visible car body and cabin roof face outward with Cesium back-face culling',()=>{
  const {doc,values}=readModel(buildCityLifeModels().cars[0]),paint=doc.meshes[0].primitives[0];
  const p=values(paint.attributes.POSITION),n=values(paint.attributes.NORMAL);
  // First 36 vertices are the closed painted body box, centered at y=.575.
  for(let i=0;i<36;i++)assert.ok(p[i*3]*n[i*3]+(p[i*3+1]-.575)*n[i*3+1]+p[i*3+2]*n[i*3+2]>0);
  for(let i=36;i<42;i++)assert.ok(n[i*3+1]>.9,'cabin roof must face up');
});

function fakeScene(){
  class Vec3 {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(){return new Vec3();}}
  class Property {constructor(value){this.value=value;}setValue(value){this.value=value;}}
  class Mat4 {static inverseTransformation(a){return a;}static multiplyByPoint(a,p,out){return Object.assign(out,p);}static multiplyByPointAsVector(a,p,out){return Object.assign(out,p);}}
  class JulianDate {constructor(seconds=0){this.seconds=seconds;}static secondsDifference(a,b){return a.seconds-b.seconds;}static clone(a,b=new JulianDate()){b.seconds=a.seconds;return b;}}
  class Points {constructor(){this.points=[];}add(p){this.points.push(p);return p;}}
  const listeners=new Set(),entityList=[],primitives=new Set();
  let focusX=0,viewX=null;
  const C={Cartesian3:Vec3,Cartesian2:class {constructor(x,y){Object.assign(this,{x,y});}},Matrix4:Mat4,Matrix3:class {},JulianDate,
    Transforms:{eastNorthUpToFixedFrame:()=>new Mat4(),rotationMatrixFromPositionVelocity:(p,v)=>v},Quaternion:{fromRotationMatrix:(v)=>({heading:Math.atan2(v.y,v.x)})},Ellipsoid:{WGS84:{}},
    ShadowMode:{CAST_ONLY:1},DistanceDisplayCondition:class {constructor(near,far){Object.assign(this,{near,far});}},PointPrimitiveCollection:Points,Color:{fromCssColorString:(v)=>v}};
  C.SceneTransforms={worldToWindowCoordinates:(scene,p)=>p?{x:500+(p.x-(viewX??focusX))*2,y:350-p.y*1.5}:undefined};
  const viewer={canvas:{clientWidth:1000,clientHeight:700},clock:{shouldAnimate:true,currentTime:new JulianDate()},camera:{positionCartographic:{height:450},getPickRay:()=>({origin:new Vec3(focusX,-300,400),direction:new Vec3(0,1,-1)})},
    entities:{add(options){const entity={...options,position:new Property(options.position)};Object.defineProperty(entity,'orientation',{get(){return this._orientation;},set(v){this._orientation=v instanceof Property?v:new Property(v);}});entityList.push(entity);return entity;},remove(e){entityList.splice(entityList.indexOf(e),1);}},
    scene:{preRender:{addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);}},primitives:{add(p){primitives.add(p);return p;},remove(p){primitives.delete(p);}}}};
  return {C,viewer,entityList,listeners,primitives,setFocus(x){focusX=x;},setViewCenter(x){viewX=x;viewer.camera.directionWC=new Vec3(x===0?0:.8,1,-1);},frame(seconds){viewer.clock.currentTime=new JulianDate(seconds);for(const fn of listeners)fn(viewer.scene,viewer.clock.currentTime);}};
}

test('camera-near traffic is visible, uses exact road heights, moves once on the shared clock, pauses and releases resources',(t)=>{
  let wall=0,offset=0;const harness=fakeScene(),reports=[];t.mock.method(performance,'now',()=>wall);
  const roadPaths=[{id:'near',kind:'residential',width:8,points:[[-350,0,120],[0,0,120],[350,0,120]]},{id:'far',kind:'residential',width:8,points:[[2400,0,150],[2750,0,150],[3100,0,150]]}];
  const scene=attachCityLife(harness.viewer,{id:'test'},{Cesium:harness.C,center:{lat:0,lon:0},campusFocus:{x:0,y:0},roadPaths,heightOffset:()=>offset,onActivity:(s)=>reports.push(s)});
  scene.setQuality('low');scene.setActive(true);
  assert.equal(scene.stats.moving,true,'initial render reports intentional running even with zero delta');
  const cars=()=>harness.entityList.filter((e)=>e.id.includes('-car-')&&e.show),planes=()=>harness.entityList.filter((e)=>e.id.includes('-plane-')&&e.show);
  assert.ok(scene.stats.cars>100&&scene.stats.cars<=150);assert.ok(scene.stats.carModels<=25);assert.equal(planes().length,2);
  for(const entity of [...cars(),...planes()]){const scale=entity.id.includes('-car-')?ROAD_VEHICLE_SCALE:1;assert.equal(entity.model.scale,scale);assert.equal(entity.model.maximumScale,scale);assert.equal(entity.model.minimumPixelSize,0);}
  assert.ok(cars().every((e)=>Math.abs(e.position.value.x)<500));
  const roadOrigin=.015-.08*ROAD_VEHICLE_SCALE;
  assert.ok(cars().every((e)=>Math.abs(e.position.value.z-120-roadOrigin)<1e-8));
  assert.ok(Math.hypot(planes()[0].position.value.x,planes()[0].position.value.y)<200,'first plane starts over the campus');
  assert.ok(planes()[0].position.value.z<270,'flyover is below the initial campus camera');
  harness.frame(0);const car=cars()[0],before={...car.position.value},planeBefore={...planes()[0].position.value};wall=1100;harness.frame(.1);
  assert.ok(Math.hypot(car.position.value.x-before.x,car.position.value.y-before.y)>.6,'real position advances each frame');
  assert.notDeepEqual({...planes()[0].position.value},planeBefore);assert.equal(scene.stats.moving,true);
  const paused={...car.position.value};harness.viewer.clock.shouldAnimate=false;wall=2200;harness.frame(.2);
  assert.deepEqual({...car.position.value},paused);assert.equal(scene.stats.moving,false);
  harness.viewer.clock.shouldAnimate=true;wall=3300;harness.frame(10000);assert.deepEqual({...car.position.value},paused,'year jumps do not teleport activity');
  assert.equal(scene.stats.moving,true,'ignored timeline discontinuities do not claim intentional pause');
  wall=4400;harness.frame(10001.2);assert.notDeepEqual({...car.position.value},paused,'low frame rate gaps still advance bounded activity');
  harness.viewer.clock.multiplier=0;const zeroSpeed={...car.position.value};wall=5500;harness.frame(10001.4);assert.deepEqual({...car.position.value},zeroSpeed);assert.equal(scene.stats.moving,false);
  harness.viewer.clock.multiplier=.35;
  offset=12;scene.setQuality('balanced');assert.ok(cars().every((e)=>Math.abs(e.position.value.z-132-roadOrigin)<1e-8));assert.ok(scene.stats.cars>=100&&scene.stats.cars<=300,'safe spacing can reduce a short-road population below the quality ceiling');
  const stable={...car.position.value};wall=6600;harness.frame(10001.4);assert.deepEqual({...car.position.value},stable,'ranking does not re-seed visible vehicles');
  harness.setFocus(2750);wall=7700;harness.frame(10001.4);assert.ok(cars().every((e)=>e.position.value.x>2000),'old off-screen pool recycles near the new camera');
  scene.setActive(false);assert.equal(harness.entityList.filter((e)=>e.show).length,0);assert.equal(scene.stats.active,false);
  scene.destroy();scene.destroy();assert.equal(harness.entityList.length,0);assert.equal(harness.listeners.size,0);assert.equal(harness.primitives.size,0);assert.ok(reports.length>=5);
});

test('a narrow Homes camera only 500 m from campus receives off-screen traffic and a new flyover',(t)=>{
  let wall=0;const h=fakeScene();t.mock.method(performance,'now',()=>wall);
  const roadPaths=[{id:'campus',kind:'service',width:8,points:[[-200,0,12],[200,0,12]]},{id:'homes',kind:'residential',width:8,points:[[450,0,12],[850,0,12]]}];
  const scene=attachCityLife(h.viewer,{id:'near-camera'},{Cesium:h.C,center:{lat:0,lon:0},campusFocus:{x:0,y:0},roadPaths});
  scene.setQuality('low');scene.setActive(true);h.frame(0);
  assert.ok(scene.stats.carsInView>=12);
  const campusCars=h.entityList.filter((e)=>e.id.includes('-car-')&&e.show).map((e)=>({...e.position.value}));
  h.setFocus(500);wall=1100;h.frame(.1);
  assert.ok(scene.stats.focus.x>490&&scene.stats.focus.x<510,'world pick ray is projected to the new local ground target');
  assert.ok(scene.stats.carsInView>=8,'off-screen campus pool moves to actual Homes roads without requiring a 1100 m jump');
  assert.ok(h.entityList.some((e)=>e.id.includes('-car-')&&e.show&&e.position.value.x>=450));
  assert.ok(scene.stats.planesInView>=1);assert.ok(scene.stats.aircraftScreen[0].inView);
  assert.ok(campusCars.some((p)=>p.x<450));scene.destroy();
});
test('original model kit contains valid finite GLB geometry and separate car colors',()=>{
  const models=buildCityLifeModels();assert.equal(models.cars.length,6);
  for(const buffer of [...models.cars,...models.vans,models.bus,...models.delivery,...models.trucks,...Object.values(models.planes),models.lamp,models.sign]){
    const view=new DataView(buffer);assert.equal(view.getUint32(0,true),0x46546c67);assert.equal(view.getUint32(8,true),buffer.byteLength);
    const length=view.getUint32(12,true),doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));
    assert.equal(doc.meshes[0].primitives.length,1,'each model is one color-baked draw primitive');
    const primitive=doc.meshes[0].primitives[0];assert.equal(doc.accessors[primitive.attributes.COLOR_0].count,doc.accessors[primitive.attributes.POSITION].count);
    for(const accessor of doc.accessors){assert.ok(accessor.count>0);assert.ok([...accessor.min,...accessor.max].every(Number.isFinite));}
    for(const material of doc.materials)assert.ok(material.pbrMetallicRoughness.baseColorFactor.every((value)=>value>=0&&value<=1));
  }
});

function cityRoads(){const roads=[];for(let n=-2000;n<=2000;n+=250){roads.push({id:'east-'+n,kind:'residential',width:8,points:[[-2200,n,12],[2200,n,12]]},{id:'north-'+n,kind:'secondary',width:9,points:[[n,-2200,12],[n,2200,12]]});}return roads;}
test('citywide traffic covers sectors and many streets while every quality prefix retains a modest foreground quota',()=>{
  const routes=trafficRoutes(cityRoads()),plan=planTrafficDistribution(routes,{x:0,y:0});
  assert.equal(plan.length,510);assert.deepEqual(planTrafficDistribution(routes,{x:0,y:0}),plan);
  for(const count of [150,300,510]){
    const prefix=plan.slice(0,count);assert.equal(prefix.filter((p)=>p.foreground).length,Math.floor(count*7/20));
    assert.ok(new Set(prefix.map((p)=>p.cell)).size>=Math.min(count/4,120));assert.ok(new Set(prefix.map((p)=>p.road.id)).size>12);
    assert.equal(new Set(prefix.map((p)=>Math.floor((Math.atan2(p.y,p.x)+Math.PI)/(Math.PI/4))%8)).size,8);
    assert.ok(Math.max(...prefix.map((p)=>p.x))-Math.min(...prefix.map((p)=>p.x))>3000);
    assert.ok(Math.max(...prefix.map((p)=>p.y))-Math.min(...prefix.map((p)=>p.y))>3000);
    assert.ok(prefix.every((p)=>p.distance<=2400));
  }
});
test('larger pools use bounded model/point LOD, varied real-sized vehicles and distinct aircraft without resource leaks',(t)=>{
  let wall=0;const h=fakeScene();t.mock.method(performance,'now',()=>wall);
  const scene=attachCityLife(h.viewer,{id:'citywide'},{Cesium:h.C,center:{lat:0,lon:0},roadPaths:cityRoads(),campusFocus:{x:0,y:0},campuses:[{x:0,y:0,width:80,depth:60}]});
  scene.setActive(true);assert.ok(scene.stats.cars>=450&&scene.stats.cars<=510);assert.ok(scene.stats.carModels>10&&scene.stats.carModels<=85);assert.ok(scene.stats.carPoints>=350);
  assert.ok(Object.values(scene.stats.vehicleKinds).every((n)=>n>0));assert.deepEqual(new Set(scene.stats.aircraftKinds),new Set(['prop','regional','cargo']));
  const allocated=h.entityList.length;assert.equal(h.entityList.filter((e)=>e.id.includes('-car-')).length,85,'only the fixed model pool can allocate road meshes');
  scene.setQuality('low');assert.equal(scene.stats.cars,150);assert.ok(scene.stats.carModels<=25);assert.equal(h.entityList.length,allocated);
  for(const entity of h.entityList.filter((e)=>/-car-|-plane-/.test(e.id))){const scale=entity.id.includes('-car-')?ROAD_VEHICLE_SCALE:1;assert.equal(entity.model.minimumPixelSize,0);assert.equal(entity.model.maximumScale,scale);assert.equal(entity.model.scale,scale);}
  const pointCollection=[...h.primitives].find((p)=>p.points.length===510),point=pointCollection.points.find((p)=>p.show),before={...point.position};h.frame(0);wall=1100;h.frame(.1);assert.notDeepEqual({...point.position},before);
  assert.ok(pointCollection.points.filter((p)=>p.show).every((p)=>p.pixelSize<=1.6));
  scene.setQuality('balanced');assert.equal(scene.stats.cars,300);assert.ok(scene.stats.carModels<=50);assert.equal(h.entityList.length,allocated);
  scene.setQuality('high');assert.ok(scene.stats.cars>=450&&scene.stats.cars<=510);assert.ok(scene.stats.carModels<=85);assert.equal(h.entityList.length,allocated);
  scene.setActive(false);assert.ok(pointCollection.points.every((p)=>!p.show));scene.destroy();assert.equal(h.listeners.size,0);assert.equal(h.primitives.size,0);assert.equal(h.entityList.length,0);
  const models=buildCityLifeModels(),span=(b)=>{const {doc}=readModel(b),a=doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];return a.max[0]-a.min[0];};
  assert.ok(span(models.planes.prop)<12);assert.ok(span(models.planes.regional)>=26);assert.ok(span(models.planes.cargo)>=33);
  const {doc}=readModel(models.cars[0]),body=doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];assert.ok(body.max[2]-body.min[2]<4.4);
});

test('vehicle routing dimensions conservatively cover authored car, van, bus and distinct truck meshes',()=>{
  const models=buildCityLifeModels(),pack=createCityLifeModelPack();
  try{
    const buffers=[...models.cars,...models.vans,models.bus,...models.delivery,...models.trucks];
    assert.equal(buffers.length,pack.vehicles.length);assert.equal(models.trucks.length,2);
    for(let i=0;i<buffers.length;i++){
      const {doc}=readModel(buffers[i]),a=doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION],profile=pack.vehicles[i];
      assert.equal(profile.scale,ROAD_VEHICLE_SCALE);
      const width=(a.max[0]-a.min[0])*profile.scale,length=(a.max[2]-a.min[2])*profile.scale;
      assert.ok(width<=profile.width+1e-5,`${profile.kind}: headway/lane tests must include wheels and lights`);
      assert.ok(length<=profile.length+1e-5,`${profile.kind}: bumper spacing covers the entire mesh`);
      assert.ok(width<=2.1&&length<=8.2,'all rendered road vehicles use the smaller coherent scale');
      assert.ok(Math.abs(a.min[1]*profile.scale+profile.groundOffsetM-.015)<1e-6,'scaled tires sit on the road rather than hovering');
      assert.equal(profile.length,profile.authoredLength*ROAD_VEHICLE_SCALE);assert.equal(profile.width,profile.authoredWidth*ROAD_VEHICLE_SCALE);
      if(['bus','truck','delivery'].includes(profile.kind))assert.ok(profile.minRoadWidth>=6.5*ROAD_VEHICLE_SCALE);
    }
    assert.notDeepEqual(new Uint8Array(models.trucks[0]),new Uint8Array(models.trucks[1]),'rigid box and loaded flatbed have distinct silhouettes');
  }finally{pack.destroy();}
});

test('paused panning preserves visible vehicle states while the fixed model pool changes representation',(t)=>{
  let wall=0;const h=fakeScene();t.mock.method(performance,'now',()=>wall);
  const controller=attachCityLife(h.viewer,{id:'dense-pan'},{Cesium:h.C,center:{lat:0,lon:0},roadPaths:cityRoads(),campusFocus:{x:0,y:0}});
  controller.setActive(true);h.frame(0);h.viewer.clock.shouldAnimate=false;
  const points=[...h.primitives].find((p)=>p.points.length===510).points;
  const overlap=points.map((point,index)=>({index,position:{...point.position}})).filter(({position:p})=>p.z>1&&p.x>=0&&p.x<=200&&p.y>=-100&&p.y<=200);
  assert.ok(overlap.length>5,'fixture tracks cars visible before and after the small pan');
  h.setFocus(200);wall=1100;h.frame(.1);
  for(const tracked of overlap)assert.deepEqual({...points[tracked.index].position},tracked.position,'a visible paused car does not respawn to another road');
  assert.equal(h.entityList.filter((e)=>e.id.includes('-car-')).length,85);assert.ok(controller.stats.carModels<=85);
  controller.destroy();assert.equal(h.primitives.size,0);
});

test('camera rotation retargets distant visible main roads quickly without changing model caps or rebuilding a still view',(t)=>{
  let wall=0;const h=fakeScene();t.mock.method(performance,'now',()=>wall);h.setViewCenter(0);
  const roads=[{id:'local',kind:'residential',width:8,points:[[-400,0,12],[400,0,12]]},{id:'main',kind:'primary',width:14,points:[[2600,0,12],[3400,0,12]]}];
  const controller=attachCityLife(h.viewer,{id:'turn-view'},{Cesium:h.C,center:{lat:0,lon:0},roadPaths:roads,campusFocus:{x:0,y:0}});
  controller.setQuality('low');controller.setActive(true);h.frame(0);
  const builds=controller.stats.coverageRebuilds;assert.ok(controller.stats.carsInView>40);assert.equal(controller.stats.majorRoadVehiclesInView,0);
  wall=1100;h.frame(.1);assert.equal(controller.stats.coverageRebuilds,builds,'a still view reuses its road-cell projection');
  h.setViewCenter(3000);wall=2200;h.frame(.2);
  assert.equal(controller.stats.coverageRebuilds,builds+1);assert.ok(controller.stats.majorRoadVehiclesInView>50,'visible main-road traffic is not restricted to a 2.4 km focus disk');
  assert.ok(controller.stats.majorRoadCells>0);assert.ok(controller.stats.carModels<=25,'only sufficiently large projected vehicles use the bounded model pool');
  assert.ok(controller.stats.carPoints>50);assert.equal(h.entityList.filter(e=>e.id.includes('-car-')).length,85);
  h.viewer.clock.shouldAnimate=false;const points=[...h.primitives].find(p=>p.points.length===510)?.points||[...h.primitives].find(p=>p.points.length>100).points;
  const before=points.map(p=>({...p.position}));wall=3300;h.frame(.3);
  for(let i=0;i<points.length;i++)if(before[i].x>2700&&before[i].x<3250)assert.deepEqual({...points[i].position},before[i],'a paused visible main-road car is not recycled');
  h.viewer.camera.positionCartographic.height=2200;controller.setQuality('high');assert.equal(controller.stats.carModels,0,'high-altitude overview remains entirely point based');
  controller.destroy();assert.equal(h.primitives.size,0);
});
