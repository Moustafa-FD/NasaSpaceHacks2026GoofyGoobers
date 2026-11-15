// A resource can own one imagery layer or an inseparable comparison pair.
// Wall-clock opacity is independent of the environmental/timeline motion clock.
const aborted=()=>new DOMException('Map request cancelled','AbortError');

// Keep the user's chosen total opacity constant under source-over compositing,
// including when it is less than one. Otherwise two translucent years brighten
// the map midway through every fade, then jump when the old layer is removed.
export function mapCrossfadeAlphas(opacity,mix){
  const a=Math.max(0,Math.min(1,opacity)),t=Math.max(0,Math.min(1,mix)),front=a*t;
  return [front>=1?0:a*(1-t)/(1-front),front];
}

export function createMapTransition({load,whenReady,setOpacity,dispose,onCommit,onState,durationMs=700,
  now=()=>performance.now(),requestFrame=(fn)=>requestAnimationFrame(fn),cancelFrame=(id)=>cancelAnimationFrame(id)}={}){
  if(![load,whenReady,setOpacity,dispose].every((f)=>typeof f==='function'))throw new TypeError('Map transitions need load, whenReady, setOpacity and dispose hooks');
  let current=null,incoming=null,pending=null,queued=null,frame=null,started=0,running=false,destroyed=false,state='idle';
  const notify=(value,key,error)=>{state=value;try{onState?.({state:value,key,error});}catch{/* Diagnostic callbacks cannot leak map resources. */}};
  const release=(record)=>{if(!record||record.disposed)return;record.disposed=true;try{dispose(record.resource);}catch{/* Continue releasing the other comparison group. */}};
  const settle=(job,value,error)=>{if(job.settled)return;job.settled=true;error?job.reject(error):job.resolve(value);};
  function stopFrame(){if(frame!==null){cancelFrame(frame);frame=null;}}
  function finishFade(){
    if(!incoming)return;
    stopFrame();setOpacity(incoming.resource,1);release(current);current=incoming;incoming=null;
    settle(current.job,current.resource);notify('ready',current.key);
  }
  function tick(){
    frame=null;if(destroyed||!incoming)return;
    const t=Math.max(0,Math.min(1,(now()-started)/Math.max(1,durationMs))),weight=t*t*(3-2*t);
    try{
      // The new imagery is above the old imagery. Keep the lower pair opaque:
      // source-over compositing supplies its (1-weight) contribution already.
      // Fading both opacities would expose the base globe halfway through.
      if(current)setOpacity(current.resource,1);setOpacity(incoming.resource,weight);
      if(t>=1)finishFade();else frame=requestFrame(tick);
    }catch(error){
      const failed=incoming;incoming=null;release(failed);if(current)setOpacity(current.resource,1);
      settle(failed.job,null,error);notify('failed',failed.key,error);
    }
  }
  async function readiness(resource,signal){
    if(signal.aborted)throw aborted();
    return new Promise((resolve,reject)=>{
      const cancel=()=>{cleanup();reject(aborted());},cleanup=()=>signal.removeEventListener('abort',cancel);
      signal.addEventListener('abort',cancel,{once:true});
      Promise.resolve().then(()=>whenReady(resource,signal)).then((value)=>{cleanup();signal.aborted?reject(aborted()):resolve(value);},(error)=>{cleanup();reject(error);});
    });
  }
  async function pump(){
    if(running||destroyed)return;running=true;
    try{
      while(queued&&!destroyed){
        const job=queued;queued=null;pending=job;let record;
        try{
          // Only one load runs at a time. An uncooperative cancelled loader may
          // finish late, but cannot create a third resource alongside a new load.
          const resource=await load(job.payload,job.abort.signal);
          if(resource==null)throw new Error('Map loader returned no resource');
          record={key:job.key,resource,payload:job.payload,job,disposed:false};
          if(job.abort.signal.aborted||destroyed){release(record);settle(job,null);continue;}
          setOpacity(resource,0);await readiness(resource,job.abort.signal);
          if(job.abort.signal.aborted||destroyed){release(record);settle(job,null);continue;}
          incoming=record;started=now();onCommit?.(resource,job.payload,job.key);
          if(incoming!==record||job.abort.signal.aborted)continue;
          notify('transitioning',job.key);
          if(durationMs<=0)finishFade();else frame=requestFrame(tick);
        }catch(error){
          if(incoming===record)incoming=null;release(record);
          if(job.abort.signal.aborted||destroyed)settle(job,null);
          else{if(current)setOpacity(current.resource,1);settle(job,null,error);notify('failed',job.key,error);}
        }finally{if(pending===job)pending=null;}
      }
    }finally{running=false;}
  }
  function cancelWaiting(){
    if(pending){pending.abort.abort();settle(pending,null);}
    if(queued){queued.abort.abort();settle(queued,null);queued=null;}
  }
  function clear(){
    stopFrame();cancelWaiting();
    if(incoming){settle(incoming.job,null);release(incoming);incoming=null;}
    release(current);current=null;if(!destroyed)notify('idle',null);
  }
  return {
    show(key,payload){
      if(destroyed)return Promise.reject(aborted());
      if(incoming?.key===key)return incoming.job.promise;
      if(pending?.key===key&&!pending.abort.signal.aborted)return pending.promise;
      if(queued?.key===key)return queued.promise;
      // A new target promotes the already-ready incoming map before loading.
      // This bounds live resources to current+replacement during rapid scrubs.
      if(incoming)finishFade();
      cancelWaiting();
      if(current?.key===key){notify('ready',key);return Promise.resolve(current.resource);}
      const job={key,payload,abort:new AbortController(),settled:false};
      job.promise=new Promise((resolve,reject)=>Object.assign(job,{resolve,reject}));
      queued=job;notify('loading',key);void pump();return job.promise;
    },
    clear,
    destroy(){if(destroyed)return;destroyed=true;clear();notify('destroyed',null);},
    get state(){return state;},get currentKey(){return incoming?.key??current?.key??null;},
  };
}
