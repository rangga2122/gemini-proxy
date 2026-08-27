export class FixedWindow{
  constructor(now=Date.now,{maxKeys=10000}={}){this.now=now;this.maxKeys=maxKeys;this.map=new Map}
  take(key,limit=30){const n=this.now(),start=Math.floor(n/60000)*60000;let r=this.map.get(key);if(!r||r.start!==start)r={start,count:0};r.count++;this.map.delete(key);this.map.set(key,r);this.prune(start);return r.count<=limit?{ok:true,remaining:limit-r.count}:{ok:false,retryAfterMs:start+60000-n}}
  prune(start){for(const [k,v] of this.map){if(v.start<start)this.map.delete(k)}while(this.map.size>this.maxKeys)this.map.delete(this.map.keys().next().value)}
}
export class SingleFlight{
  constructor(){this.active=new Set}
  acquire(key){if(this.active.has(key))return null;this.active.add(key);let released=false;return()=>{if(released)return;released=true;this.active.delete(key)}}
}
export class Semaphore{constructor(max,queueMax=30){if(!Number.isInteger(max)||max<1||!Number.isInteger(queueMax)||queueMax<0)throw new TypeError('invalid semaphore limits');this.max=max;this.queueMax=queueMax;this.active=0;this.queue=[]}acquire(){if(this.active<this.max){this.active++;return Promise.resolve(this.releaseFn())}if(this.queue.length>=this.queueMax){const e=new Error('backend busy: overloaded');e.code=-32002;return Promise.reject(e)}return new Promise((resolve,reject)=>this.queue.push({resolve,reject}))}releaseFn(){let done=false;return()=>{if(done)return;done=true;const n=this.queue.shift();if(n)n.resolve(this.releaseFn());else this.active--}}async run(fn){const release=await this.acquire();try{return await fn()}finally{release()}}close(){for(const x of this.queue){const e=new Error('shutting down');e.code=-32002;x.reject(e)}this.queue=[]}}
