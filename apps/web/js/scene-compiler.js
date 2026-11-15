// Worker transport is separate from Cesium so progressive messages, cancellation
// and stale replies can be tested without a graphics context.
export function createSceneCompiler(createWorker) {
  let worker=null,nextId=0;
  const jobs=new Map();
  function connect() {
    if(worker)return worker;
    const connected=createWorker();worker=connected;
    connected.onmessage=({data})=>{
      if(worker!==connected)return;
      const job=jobs.get(data.id);if(!job)return;
      if(data.error){finish(data.id,new Error(data.error));return;}
      try {
        if(data.stage==='preview'){job.onProgress?.(data.result);return;}
        if(data.stage==='detail'){
          job.detail=data.result;job.onProgress?.(job.detail);return;
        }
        if(data.stage==='complete'){
          if(!job.detail){finish(data.id,new Error('Neighborhood detail is missing'));return;}
          Object.assign(job.detail,data.result);
          finish(data.id,null,job.detail);
        }
      }catch(error){
        finish(data.id,error);
        try{connected.postMessage({id:data.id,cancel:true});}catch{/* Already failed. */}
      }
    };
    connected.onerror=(event)=>{
      if(worker!==connected)return;
      worker=null;connected.terminate();
      for(const id of [...jobs.keys()])finish(id,new Error(event.message||'Neighborhood generator failed'));
    };
    return worker;
  }
  function finish(id,error,result) {
    const job=jobs.get(id);if(!job)return;
    jobs.delete(id);job.cleanup();error?job.reject(error):job.resolve(result);
  }
  return {
    compile(input,{signal,onProgress}={}) {
      if(signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
      return new Promise((resolve,reject)=>{
        const id=++nextId;
        const abort=()=>{
          finish(id,new DOMException('Aborted','AbortError'));
          try{worker?.postMessage({id,cancel:true});}catch{/* Worker failure already settled this job. */}
        };
        const cleanup=()=>signal?.removeEventListener('abort',abort);
        jobs.set(id,{resolve,reject,cleanup,onProgress,detail:null});
        signal?.addEventListener('abort',abort,{once:true});
        try{connect().postMessage({...input,id,progressive:!!onProgress});}
        catch(error){finish(id,error);}
      });
    },
    destroy(){
      worker?.terminate();worker=null;
      for(const id of [...jobs.keys()])finish(id,new DOMException('Aborted','AbortError'));
    },
  };
}
