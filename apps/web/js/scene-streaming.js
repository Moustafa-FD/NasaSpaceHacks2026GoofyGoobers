// Request orchestration is independent of Cesium and never fetches per frame.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function streamKey(point){return `${(Math.round(point.lat*100)/100).toFixed(2)},${(Math.round(point.lon*100)/100).toFixed(2)}`;}
export function geographicDistance(a,b){return Math.hypot((a.lat-b.lat)*111320,(a.lon-b.lon)*111320*Math.cos((a.lat+b.lat)*Math.PI/360));}
export function streamRadius(height){return clamp(2200+Math.max(0,height)*.35,2200,3000);}
export function radialCoverage(point,circle,feather=600){const t=clamp((Math.hypot(point.x-circle.x,point.y-circle.y)-(circle.radius-feather))/feather,0,1);return 1-t*t*(3-2*t);}
export function fadeWeights(elapsed,duration=2000){const incoming=clamp(elapsed/duration,0,1);return {incoming,outgoing:1-incoming};}

/** A parsed GLB is not render-ready. Set show=true with zero shader coverage,
 * add it to the scene, then wait for the actual ready event before replacing. */
export function waitForModelReady(model,signal,{timeoutMs=45000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
  if(model.ready)return Promise.resolve(model);
  return new Promise((resolve,reject)=>{
    const removers=[];let timer,settled=false;
    function finish(error){if(settled)return;settled=true;for(const remove of removers)remove();signal?.removeEventListener('abort',abort);if(timer!==undefined)clearTimer(timer);error?reject(error):resolve(model);}
    const abort=()=>finish(new DOMException('Aborted','AbortError'));
    removers.push(model.readyEvent.addEventListener(()=>finish()));
    removers.push(model.errorEvent.addEventListener((error)=>finish(error instanceof Error?error:new Error(String(error)))));
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimer(()=>finish(new Error('Scenery took too long to become render-ready')),timeoutMs);
    if(model.ready)finish();
  });
}

export function createSceneStreamer({request,prepare=async(v)=>v,onReady=()=>{},onState=()=>{},now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,cacheSize=2,threshold=1150}={}){
  let epoch=0,anchor=null,target=null,queued=null,job=null,destroyed=false,state='idle';
  const cache=new Map(),cooldowns=new Map();
  const emit=(next,extra={})=>{state=next;onState({state:next,...extra});};
  function wait(ms,signal){return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}
    const abort=()=>{clearTimer(timer);reject(new DOMException('Aborted','AbortError'));};
    const timer=setTimer(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});
  });}
  async function fetchReady(point,signal){
    for(;;){
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      const response=await request(point,signal),body=await response.json();
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      if(response.status===202){emit('loading',{key:streamKey(point)});await wait(clamp(Number(body.retryAfterMs)||2000,1000,10000),signal);continue;}
      if(response.status!==200||body.status!=='ready'){const error=new Error(body.error||body.message||'Mapped scenery is unavailable for this area');error.cooldown=Number(body.retryAfterMs)||60000;throw error;}
      return body;
    }
  }
  function remember(key,data){cache.delete(key);cache.set(key,data);while(cache.size>cacheSize)cache.delete(cache.keys().next().value);}
  function pump(){
    if(destroyed||job||!queued)return;
    const point=queued;queued=null;const key=streamKey(point),token=epoch,controller=new AbortController();
    const task={controller,key,promise:null};job=task;
    task.promise=(async()=>{
      try{
        let data=cache.get(key);
        if(data){cache.delete(key);cache.set(key,data);}else{
          if((cooldowns.get(key)||0)>now())return;
          emit('loading',{key});const response=await fetchReady(point,controller.signal);
          if(token!==epoch||controller.signal.aborted)return;
          emit('building',{key});data=await prepare(response,controller.signal);
          if(token!==epoch||controller.signal.aborted)return;remember(key,data);
        }
        if(token!==epoch||controller.signal.aborted||!target||geographicDistance(point,target)>1400)return;
        emit('uploading',{key});await onReady(data,point,controller.signal);
        if(token!==epoch||controller.signal.aborted)return;
        anchor=data.center||point;emit('ready',{key,center:anchor});
        if(queued&&geographicDistance(anchor,queued)<threshold)queued=null;
      }catch(error){
        if(token===epoch&&!controller.signal.aborted){cooldowns.set(key,now()+clamp(error.cooldown||60000,10000,120000));while(cooldowns.size>16)cooldowns.delete(cooldowns.keys().next().value);emit('failed',{key,error:error.message});}
      }finally{if(job===task)job=null;if(token===epoch)pump();}
    })();
  }
  return {
    setAnchor(point){anchor=point;},
    update(point,{enabled=true,height=0}={}){
      if(destroyed)return;
      if(!enabled||height>=2100){this.cancel();return;}
      target=point;
      if(anchor&&geographicDistance(anchor,point)<threshold){
        queued=null;
        if(job){
          // Returning to already loaded scenery invalidates even a nearby job:
          // its normal relevance tolerance would otherwise install it later.
          this.cancel();emit('ready',{key:streamKey(anchor),center:anchor,reused:true});
        }
        return;
      }
      if(job?.key===streamKey(point))return;
      if((cooldowns.get(streamKey(point))||0)>now())return;
      queued=point;pump();
    },
    cancel(){epoch++;target=queued=null;job?.controller.abort();job=null;if(state!=='idle')emit('idle');},
    reset(point){this.cancel();anchor=point;cache.clear();cooldowns.clear();},
    async idle(){while(job)await job.promise;},
    get pending(){return !!job;},get state(){return state;},get cacheKeys(){return [...cache.keys()];},
    destroy(){if(destroyed)return;this.cancel();destroyed=true;cache.clear();cooldowns.clear();},
  };
}
