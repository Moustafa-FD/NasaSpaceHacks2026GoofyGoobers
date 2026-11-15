// Observe the provider's own scheduled requests. Returning undefined is Cesium's
// backpressure signal; never turn it into a Promise or retry outside its scheduler.
const tracked=new WeakMap();

export function trackImageryProvider(provider){
  if(!provider||typeof provider.requestImage!=='function')throw new TypeError('Imagery readiness requires a provider.requestImage function');
  if(tracked.has(provider))return tracked.get(provider);
  const original=provider.requestImage;
  const counts={pending:0,completed:0,failed:0,requested:0,revision:0};
  const tracker=Object.freeze({get snapshot(){return Object.freeze({...counts});}});
  provider.requestImage=function(...args){
    let result;
    try{result=original.apply(this,args);}
    catch(error){counts.requested++;counts.failed++;counts.revision+=2;throw error;}
    if(result===undefined)return undefined;
    counts.requested++;counts.revision++;
    let asynchronous;
    try{asynchronous=result!==null&&typeof result.then==='function';}
    catch(error){counts.failed++;counts.revision++;throw error;}
    if(!asynchronous){
      if(result!==null)counts.completed++;
      counts.revision++;return result;
    }
    counts.pending++;
    return Promise.resolve(result).then(image=>{
      counts.pending--;counts.revision++;
      if(image!==null&&image!==undefined)counts.completed++;
      return image;
    },error=>{
      counts.pending--;counts.failed++;counts.revision++;throw error;
    });
  };
  tracked.set(provider,tracker);
  return tracker;
}
