import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTrafficGraph,spawnTrafficVehicle,sampleTrafficArc,sampleTrafficVehicle,advanceTraffic,vehicleFitsRoad,trafficStatesConflict,createTrafficSpawnIndex,updateTrafficSpawnIndex} from '../apps/web/js/traffic-routes.js';

const car={kind:'car',length:4.24,width:1.92,minRoadWidth:4,speed:10};
const road=(id,points,width=8,tags={})=>({id,kind:'residential',width,points,tags});
function spawn(graph,vehicles,source,x,y,seed=1,profile=car,direction=1){
  const vehicle={...profile,speed:profile.speed,route:null};
  vehicle.route=spawnTrafficVehicle(graph,vehicles,{road:source,x,y,direction},profile,seed);
  assert.ok(vehicle.route,'fixture has room for a vehicle');vehicles.push(vehicle);return vehicle;
}

test('mapped shared endpoints and ground intersections form connected arcs while grade separation remains distinct',()=>{
  const horizontal=road('h',[[-100,0,12],[100,0,12]]),vertical=road('v',[[0,-100,12],[0,100,12]]);
  const graph=buildTrafficGraph([horizontal,vertical]);
  assert.equal(graph.nodes.length,5);assert.equal(graph.arcs.length,8);
  const junction=graph.nodes.find((n)=>Math.abs(n.x)+Math.abs(n.y)<.001);assert.equal(junction.out.length,4);
  assert.equal(buildTrafficGraph([horizontal,{...vertical,tags:{bridge:'yes',layer:'1'}}]).nodes.length,4);
  assert.equal(buildTrafficGraph([horizontal,road('high',[[0,-100,25],[0,100,25]])]).nodes.length,4);
  const bridge=buildTrafficGraph([road('approach',[[-100,0,12],[0,0,12]]),road('bridge',[[0,0,12],[100,0,12]],8,{bridge:'yes',layer:'1'})]);
  assert.equal(bridge.nodes.length,3,'explicit shared ends still join a bridge approach');
  assert.equal(buildTrafficGraph([{...horizontal,kind:'footway'}]).arcs.length,0);
});

test('one-way source direction, reverse-one-way and roundabout metadata constrain every outgoing arc',()=>{
  for(const [tags,direction] of [[{oneway:'yes'},1],[{oneway:'-1'},-1],[{junction:'roundabout'},1]]){
    const graph=buildTrafficGraph([road('one',[[0,0,5],[100,0,5],[200,0,5]],8,tags)]);
    assert.equal(graph.arcs.length,1);assert.equal(graph.arcs[0].sourceDirection,direction);
    assert.equal(graph.arcs[0].oneway,true);assert.equal(graph.arcs[0].reverseId,null);
    assert.equal(graph.nodes[graph.arcs[0].to].out.length,0);
  }
});

test('vehicles cross connected roads and visibly turn around at a dead end without wrapping or teleporting',()=>{
  const a=road('a',[[0,0,12],[100,0,12]]),b=road('b',[[100,0,12],[200,0,12]]),graph=buildTrafficGraph([a,b]),vehicles=[];
  const vehicle=spawn(graph,vehicles,a,45,0),initial=sampleTrafficVehicle(vehicle.route,{});
  let previous={...initial},maxX=initial.x,minAfter=Infinity,returned=false,transitions=0;
  for(let frame=0;frame<600;frame++){
    const oldArc=vehicle.route.arc.id;advanceTraffic(graph,vehicles,.1);const p=sampleTrafficVehicle(vehicle.route,{});
    assert.equal(p.visible,true);assert.equal(p.z,12);
    assert.ok(Math.hypot(p.x-previous.x,p.y-previous.y)<=1.05,'one frame never jumps to a road start');
    assert.ok(Math.abs(p.y)<=4,'turnarounds stay in the mapped road corridor');
    if(vehicle.route.arc.id!==oldArc)transitions++;
    maxX=Math.max(maxX,p.x);if(maxX>185){minAfter=Math.min(minAfter,p.x);if(p.x<30)returned=true;}
    previous={...p};
  }
  assert.ok(maxX>185&&returned&&minAfter<30);assert.ok(transitions>=4);
});

test('an unconnected one-way terminal stops visibly rather than inventing a link or disappearing',()=>{
  const source=road('one',[[0,0,20],[120,0,20]],6,{oneway:'yes'}),graph=buildTrafficGraph([source]),vehicles=[];
  const vehicle=spawn(graph,vehicles,source,80,0);
  for(let frame=0;frame<300;frame++)advanceTraffic(graph,vehicles,.1);
  const p=sampleTrafficVehicle(vehicle.route,{});
  assert.ok(p.x>105&&p.x<120);assert.equal(p.visible,true);assert.equal(vehicle.route.speed,0);
  const still={...p};advanceTraffic(graph,vehicles,.1);assert.deepEqual(sampleTrafficVehicle(vehicle.route,{}),still);
});

test('same-lane traffic retains bumper headway with faster followers and one turn reservation per junction',()=>{
  const source=road('lane',[[0,0,8],[500,0,8]]),graph=buildTrafficGraph([source]),vehicles=[];
  spawn(graph,vehicles,source,40,0,1,{...car,speed:13});
  spawn(graph,vehicles,source,65,0,2,{...car,speed:9});
  spawn(graph,vehicles,source,90,0,3,{...car,speed:5});
  for(let frame=0;frame<1800;frame++){
    advanceTraffic(graph,vehicles,.1);
    for(const a of vehicles)for(const b of vehicles){
      if(a===b||a.route.turn||b.route.turn||a.route.arc.id!==b.route.arc.id)continue;
      assert.ok(Math.abs(a.route.distance-b.route.distance)>=(a.length+b.length)/2+3.999,'bumpers cannot overlap when a follower is faster');
    }
    const turns=vehicles.filter((v)=>v.route.turn).map((v)=>v.route.turn.junction);
    assert.equal(new Set(turns).size,turns.length,'intersecting turn paths have exclusive access');
  }
  const before=vehicles.map((v)=>sampleTrafficVehicle(v.route,{}));advanceTraffic(graph,vehicles,0);
  assert.deepEqual(vehicles.map((v)=>sampleTrafficVehicle(v.route,{})),before,'zero motion speed leaves route/turn positions unchanged');
});

test('lane centers, widths, vertical samples and short connectors retain sane physical vehicle dimensions',()=>{
  const narrow=road('narrow',[[0,0,100],[100,0,120]],4),wide=road('wide',[[100,0,120],[108,0,120],[200,0,130]],12);
  const graph=buildTrafficGraph([narrow,wide]),bus={kind:'bus',length:10.6,width:2.67,minRoadWidth:7,speed:8};
  assert.equal(vehicleFitsRoad(graph.byRoad.get('narrow')[0],bus),false);
  assert.equal(vehicleFitsRoad(graph.byRoad.get('wide')[0],bus),true);
  const arc=graph.byRoad.get('narrow').find((a)=>a.sourceDirection===1),p=sampleTrafficArc(arc,50);
  assert.equal(p.z,110);assert.ok(Math.abs(p.y)+car.width/2<=narrow.width/2);
  const unknown=buildTrafficGraph([road('unknown',[[0,0],[100,0]])]);assert.equal(sampleTrafficArc(unknown.arcs[0],50).z,null);
  const short=buildTrafficGraph([road('a',[[0,0,0],[100,0,0]]),road('connector',[[100,0,0],[106,0,0]]),road('c',[[106,0,0],[206,0,0]])]);
  assert.ok(short.byRoad.has('connector'));assert.equal(vehicleFitsRoad(short.byRoad.get('connector')[0],car),true);
});

test('graph/spawn/traversal are deterministic and work budgets bound dense inputs',()=>{
  const roads=[];for(let n=-300;n<=300;n+=30)roads.push(road('h'+n,[[-400,n,4],[400,n,4]]),road('v'+n,[[n,-400,4],[n,400,4]]));
  const a=buildTrafficGraph(roads,{maxSegments:10,maxIntersectionChecks:50}),b=buildTrafficGraph(roads,{maxSegments:10,maxIntersectionChecks:50});
  assert.deepEqual(a.stats,b.stats);assert.equal(a.stats.limited,true);assert.ok(a.stats.sourceSegments<=10);assert.ok(a.stats.intersectionChecks<=50);
  const run=()=>{const graph=buildTrafficGraph([roads[0]]),vehicles=[];spawn(graph,vehicles,roads[0],-100,-300);for(let i=0;i<100;i++)advanceTraffic(graph,vehicles,.1);return sampleTrafficVehicle(vehicles[0].route,{});};
  assert.deepEqual(run(),run());
});

test('spawning stays near its selected city sector after a long road is split at intersections',()=>{
  const source=road('long',[[0,0,5],[500,0,5]]),roads=[source];
  for(const x of [100,200,300,400])roads.push(road('cross-'+x,[[x,-80,5],[x,80,5]]));
  const graph=buildTrafficGraph(roads),vehicles=[],vehicle=spawn(graph,vehicles,source,350,0);
  assert.ok(Math.abs(sampleTrafficVehicle(vehicle.route,{}).x-350)<1,'a distant first arc must not steal a spawn from the selected neighborhood');
  assert.ok(!('edges' in graph.nodes[0]),'runtime graphs do not retain construction/source-piece trees');
});

test('redundant 12 m road samples compact without losing mapped bends or road-top vertical detail',()=>{
  const points=[];for(let x=0;x<=120;x+=12)points.push([x,0,x<=60?100+x*.1:106+(x-60)*.25]);
  const graph=buildTrafficGraph([road('terrain',points)]),arc=graph.arcs.find((a)=>a.sourceDirection===1);
  assert.ok(graph.stats.sourceSegments<points.length-1);
  for(const p of points)assert.ok(Math.abs(sampleTrafficArc(arc,p[0]).z-p[2])<.0021);
  const bend=buildTrafficGraph([road('bend',[[0,0,5],[50,0,5],[50,50,5]])]);
  const path=bend.arcs.find((a)=>a.sourceDirection===1),a=sampleTrafficArc(path,49.999),b=sampleTrafficArc(path,50.001);
  assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<.01,'lane offsets meet continuously at the mapped bend');
});

test('respawning reserves both lanes occupied by an in-progress junction turn',()=>{
  const a=road('a',[[0,0,8],[100,0,8]]),b=road('b',[[100,0,8],[200,0,8]]),graph=buildTrafficGraph([a,b]),vehicles=[];
  const turning=spawn(graph,vehicles,a,86,0);
  for(let i=0;i<40&&!turning.route.turn;i++)advanceTraffic(graph,vehicles,.1);
  assert.ok(turning.route.turn);
  const outgoing=turning.route.turn.next,position=sampleTrafficArc(outgoing,turning.route.turn.after);
  const fresh={...car,route:spawnTrafficVehicle(graph,vehicles,{road:b,x:position.x,y:position.y,direction:1},car,2)};
  assert.ok(fresh.route);assert.equal(trafficStatesConflict(turning.route,fresh.route),false);
  const stale={...fresh.route,arc:outgoing,distance:turning.route.turn.after,turn:null};
  assert.equal(trafficStatesConflict(turning.route,stale),true,'quality re-enable detects a stale car in the turn exit');
});

test('mapped parking aisles and driveways keep small vehicles slow and exclude oversized bodies',()=>{
  const source={...road('parking',[[0,0,5],[100,0,5]],3.5,{oneway:'yes',service:'parking_aisle'}),kind:'service'};
  const graph=buildTrafficGraph([source]),arc=graph.arcs[0],vehicles=[];
  assert.equal(arc.service,'parking_aisle');assert.equal(vehicleFitsRoad(arc,car),true);
  assert.equal(vehicleFitsRoad(arc,{kind:'bus',width:2.67,length:10.6,minRoadWidth:7}),false);
  const vehicle=spawn(graph,vehicles,source,30,0);advanceTraffic(graph,vehicles,.1);
  assert.ok(vehicle.route.speed<=2.8);
  const a=sampleTrafficVehicle(vehicle.route,{});assert.ok(Math.abs(a.y)+car.width/2<source.width/2);
});

test('worker structured clone retains shared arc references, height samples and independent locks',()=>{
  const source=road('clone',[[0,0,12],[100,0,12]]),original=buildTrafficGraph([source]),copy=structuredClone(original),vehicles=[];
  assert.ok(copy.byRoad instanceof Map);assert.ok(copy.locks instanceof Map);
  const arc=copy.arcs[0];assert.equal(copy.byRoad.get('clone')[0],arc);assert.ok(copy.nodes[arc.from].out.includes(arc));
  const vehicle=spawn(copy,vehicles,source,40,0);advanceTraffic(copy,vehicles,.1);
  assert.equal(sampleTrafficVehicle(vehicle.route,{}).z,12);copy.locks.set(0,123);assert.equal(original.locks.size,0);
});

test('sharp bends within one mapped way use a steering curve instead of snapping the vehicle heading',()=>{
  const source=road('corner',[[0,0,8],[120,0,8],[120,120,8]]),graph=buildTrafficGraph([source]),vehicles=[];
  const vehicle=spawn(graph,vehicles,source,60,0);let previous=sampleTrafficVehicle(vehicle.route,{}),turned=false;
  for(let frame=0;frame<190;frame++){
    advanceTraffic(graph,vehicles,.1);const p=sampleTrafficVehicle(vehicle.route,{});
    const rotation=Math.abs(Math.atan2(Math.sin(p.angle-previous.angle),Math.cos(p.angle-previous.angle)));
    assert.ok(rotation<.65,'no one-frame right-angle steering snap');
    assert.ok(Math.hypot(p.x-previous.x,p.y-previous.y)<1);
    if(p.y>30)turned=true;previous={...p};
  }
  assert.equal(turned,true);
});

test('indexed dense spawning matches full lane scans for mixed physical lengths and recycling',()=>{
  const source=road('dense',[[0,0,8],[1500,0,8]],12),graph=buildTrafficGraph([source]),full=[],indexed=[],index=createTrafficSpawnIndex([]);
  for(let i=0;i<100;i++){
    const profile={...car,length:i%7===0?8.1:3.23,width:i%7===0?2.03:1.46,minRoadWidth:3.04};
    const slot={road:source,x:25+(i*29)%1400,y:0,direction:i%2?1:-1};
    const a={...profile,route:spawnTrafficVehicle(graph,full,slot,profile,i+1)},b={...profile,route:spawnTrafficVehicle(graph,indexed,slot,profile,i+1,{index})};
    assert.equal(b.route?.arc.id,a.route?.arc.id);assert.equal(b.route?.distance,a.route?.distance);
    full.push(a);indexed.push(b);updateTrafficSpawnIndex(index,b);
  }
  const recycled=indexed[10],old=recycled.route;
  recycled.route=null;updateTrafficSpawnIndex(index,recycled);
  const slot={road:source,x:old.distance,y:0,direction:old.arc.sourceDirection};
  const replacement=spawnTrafficVehicle(graph,indexed,slot,recycled,101,{index,ignoreVehicle:recycled});
  assert.ok(replacement);
  recycled.route=replacement;updateTrafficSpawnIndex(index,recycled);assert.ok(index.members.get(recycled).length>0);
});
