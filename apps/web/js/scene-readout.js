// Keep data text at CSS resolution even when adaptive graphics lower WebGL resolution.
export function readoutPlacement({x,y,width,height,viewportWidth,viewportHeight,panelRight=0,top=0,bottom=viewportHeight,obstacle}){
  const left=Math.max(panelRight+12,12),right=viewportWidth-width-12;
  if(right<left||!Number.isFinite(x)||!Number.isFinite(y))return null;
  let px=Math.max(left,Math.min(right,x-width/2)),py=Math.max(top+12,Math.min(bottom-height-12,y-height-55));
  if(obstacle&&px<obstacle.right+10&&px+width>obstacle.left-10&&py<obstacle.bottom+10&&py+height>obstacle.top-10){
    if(obstacle.right+12<=right)px=obstacle.right+12;
    else py=obstacle.bottom+12;
  }
  return py+height<bottom-8?{x:px,y:py}:null;
}
export function attachSceneReadout(viewer,{eventTarget=window,document:doc=document}={}){
  const C=globalThis.Cesium,root=doc.createElement('aside');root.id='sceneModelReadout';root.className='scene-model-readout';root.hidden=true;root.setAttribute('aria-label','Model values in the 3D scene');root.setAttribute('role','status');
  const title=doc.createElement('h3'),value=doc.createElement('strong'),context=doc.createElement('p');root.append(title,value,context);doc.body.append(root);
  let state=null,world=null,last='',cameraKey='',dirty=true;
  function place(){
    if(!state||!world){root.hidden=true;return;}
    const camera=viewer.camera,p=camera.positionWC,d=camera.directionWC,u=camera.upWC,key=[p?.x,p?.y,p?.z,d?.x,d?.y,d?.z,u?.x,u?.y,u?.z,doc.documentElement.clientWidth,doc.documentElement.clientHeight].join(',');
    if(!dirty&&key===cameraKey)return;dirty=false;cameraKey=key;
    if(C.Cartesian3.distance&&C.Cartesian3.distance(viewer.camera.positionWC,world)>1600000){root.hidden=true;return;}
    if(C.Ellipsoid?.WGS84&&C.Cartesian3.dot){const normal=C.Ellipsoid.WGS84.geodeticSurfaceNormal(world,new C.Cartesian3()),towardCamera=C.Cartesian3.subtract(camera.positionWC,world,new C.Cartesian3());if(C.Cartesian3.dot(normal,towardCamera)<=0){root.hidden=true;return;}}
    const point=C.SceneTransforms.worldToWindowCoordinates(viewer.scene,world);if(!point){root.hidden=true;return;}
    const canvas=viewer.scene.canvas.getBoundingClientRect(),panel=doc.querySelector('#panel')?.getBoundingClientRect(),top=doc.querySelector('#topbar')?.getBoundingClientRect(),bottom=doc.querySelector('#timeline')?.getBoundingClientRect(),obstacle=doc.querySelector('[aria-label="3D neighborhood"]')?.getBoundingClientRect();
    root.hidden=false;
    const rect=root.getBoundingClientRect(),position=readoutPlacement({x:point.x+canvas.left,y:point.y+canvas.top,width:rect.width,height:rect.height,viewportWidth:doc.documentElement.clientWidth,viewportHeight:doc.documentElement.clientHeight,panelRight:panel?.right||0,top:top?.bottom||0,bottom:bottom?.top||doc.documentElement.clientHeight,obstacle});
    if(!position){root.hidden=true;return;}
    const transform=`translate(${Math.round(position.x)}px,${Math.round(position.y)}px)`;if(transform!==last){root.style.transform=transform;last=transform;}
  }
  function update({detail}){
    state=detail?.presentation;dirty=true;if(!state){root.hidden=true;world=null;return;}
    const lines=state.label.split('\n');title.textContent=lines[0];value.textContent=lines[1]||'';context.textContent=lines.slice(2).join('\n');root.title=state.note;
    world=C.Cartesian3.fromDegrees(state.position.lon,state.position.lat,280);place();
  }
  eventTarget.addEventListener('cs:future-scene',update);const remove=viewer.scene.postRender.addEventListener(place);
  return {destroy(){eventTarget.removeEventListener('cs:future-scene',update);remove();root.remove();}};
}
