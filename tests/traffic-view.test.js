import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficRoutes,buildTrafficCoverage,planTrafficView,projectTrafficPoint,trafficViewChanged,isMajorTrafficRoad,selectTrafficModels} from '../apps/web/js/city-life.js';

const road=(id,kind,y,length=3000)=>({id,kind,width:kind==='residential'?6:14,points:[[-length/2,y,0],[length/2,y,0]]});
const multiply=(a,b)=>Array.from({length:16},(_,i)=>{const r=i%4,c=Math.floor(i/4);return [0,1,2,3].reduce((sum,k)=>sum+a[k*4+r]*b[c*4+k],0);});
function perspective(position,direction,up=[0,0,1],fov=Math.PI/3){
  const unit=(v)=>{const n=Math.hypot(...v);return v.map(x=>x/n);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const d=unit(direction),r=unit(cross(d,up)),u=cross(r,d),p=position;
  const v=[r[0],u[0],-d[0],0,r[1],u[1],-d[1],0,r[2],u[2],-d[2],0,-dot(r,p),-dot(u,p),dot(d,p),1];
  const f=1/Math.tan(fov/2),near=1,far=20000,projection=[f/1.5,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0];
  return {x:p[0],y:p[1],z:p[2],direction:d,up:u,fov,width:1200,height:800,matrix:multiply(projection,v),circle:null};
}

test('camera-frustum projection includes angled distant streets and rejects geometry behind the camera',()=>{
  const view=perspective([0,-500,800],[0,1,-.25]);
  const p=projectTrafficPoint({x:0,y:3500,z:0},view);
  assert.ok(p.x>=0&&p.x<=view.width&&p.y>=0&&p.y<=view.height);
  assert.equal(projectTrafficPoint({x:0,y:-2500,z:0},view),null);
  const coverage=buildTrafficCoverage(trafficRoutes([road('distant','primary',3500),road('farther','secondary',5000)]));
  const selected=planTrafficView(coverage,{x:0,y:0},600,{project:p=>projectTrafficPoint(p,view),width:view.width,height:view.height});
  assert.equal(selected.plan.length,600);assert.ok(selected.plan.every(p=>p.distance>2400));assert.ok(selected.stats.majorRoadCells>10);
});

test('main-road weighting fills multiple visible road cells rather than consuming the pool around the focus',()=>{
  const roads=[];for(let y=-1200;y<=1200;y+=150)roads.push(road('local'+y,'residential',y));
  roads.push(road('arterial','primary',800),road('highway','trunk',1450));
  const coverage=buildTrafficCoverage(trafficRoutes(roads)),view=perspective([0,0,6000],[0,0,-1],[0,1,0],1.3);
  const result=planTrafficView(coverage,{x:0,y:0},600,{project:p=>projectTrafficPoint(p,view),width:view.width,height:view.height});
  assert.equal(result.plan.length,600);
  for(const n of [150,300,510]){
    const major=result.plan.slice(0,n).filter(p=>isMajorTrafficRoad(p.road.kind));
    assert.ok(major.length>n*.4);assert.ok(new Set(major.map(p=>p.cell)).size>10);
  }
  assert.deepEqual(result,planTrafficView(coverage,{x:0,y:0},600,{project:p=>projectTrafficPoint(p,view),width:view.width,height:view.height}));
  assert.ok(result.stats.projectionChecks<coverage.slots.length+coverage.cells.length*6);
});

test('coverage honors the rendered circle and only resamples the static source patch once',()=>{
  const coverage=buildTrafficCoverage(trafficRoutes([road('near','secondary',800,6000),road('outside','primary',3200,6000)]));
  const view=perspective([0,0,6000],[0,0,-1],[0,1,0],1.3),circle={x:0,y:0,radius:2200};
  const result=planTrafficView(coverage,{x:0,y:0},600,{project:p=>projectTrafficPoint(p,view),width:view.width,height:view.height,circle});
  assert.ok(result.plan.length>0);assert.ok(result.plan.every(p=>Math.hypot(p.x,p.y)<2110));
  assert.ok(result.plan.every(p=>p.road.id!=='outside'));
  const bounded=buildTrafficCoverage(trafficRoutes([road('huge','primary',0,100000)]),{maxSlots:100});
  assert.equal(bounded.slots.length,100);assert.equal(bounded.limited,true);
});

test('meaningful camera position, angle, zoom, viewport and clip changes invalidate coverage while jitter does not',()=>{
  const before=perspective([0,-500,800],[0,1,-.25]);
  assert.equal(trafficViewChanged(before,{...before,x:before.x+2}),false);
  assert.equal(trafficViewChanged(before,{...before,x:before.x+80}),true);
  assert.equal(trafficViewChanged(before,perspective([0,-500,800],[.2,1,-.25])),true);
  assert.equal(trafficViewChanged(before,{...before,fov:before.fov*1.1}),true);
  assert.equal(trafficViewChanged(before,{...before,width:before.width+100}),true);
  assert.equal(trafficViewChanged(before,{...before,circle:{x:0,y:0,radius:2500}}),true);
});

test('visible projected size selects distant vehicle meshes without a range gate and overview remains points',()=>{
  const candidates=[{id:'near-subpixel',range:600,pixels:.8,inView:true},{id:'distant-bus',range:3200,pixels:8,inView:true},
    {id:'near-car',range:400,pixels:3,inView:true},{id:'off-screen-truck',range:200,pixels:30,inView:false}];
  assert.deepEqual(selectTrafficModels(candidates,'low',600).map(c=>c.id),['distant-bus','near-car']);
  assert.deepEqual(selectTrafficModels(candidates,'high',2000),[]);
  for(const [quality,cap] of [['low',25],['balanced',50],['high',85]]){
    const many=Array.from({length:600},(_,i)=>({pixels:2+i/10,inView:true,order:i})),selected=selectTrafficModels(many,quality,500);
    assert.equal(selected.length,cap);assert.equal(selected[0].order,599);assert.equal(selected.at(-1).order,600-cap);
  }
});
