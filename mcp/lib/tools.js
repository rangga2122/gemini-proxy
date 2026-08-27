import {Semaphore} from './limits.js';

const imageSchema={oneOf:[{type:'string',description:'Image data URL'},{type:'object',properties:{mimeType:{type:'string'},base64:{type:'string'}},required:['mimeType','base64'],additionalProperties:false}]};
const definitions=[
  {name:'chat_text',description:'Chat with text',properties:{prompt:{type:'string'}},required:['prompt']},
  {name:'analyze_image',description:'Analyze image',properties:{prompt:{type:'string'},image:imageSchema},required:['prompt','image']},
  {name:'generate_image',description:'Generate image',properties:{prompt:{type:'string'},aspect_ratio:{type:'string'},image:imageSchema},required:['prompt']},
  {name:'edit_image',description:'Edit image',properties:{prompt:{type:'string'},image:imageSchema,aspect_ratio:{type:'string'}},required:['prompt','image']},
  {name:'generate_audio',description:'Generate audio',properties:{text:{type:'string'},voice:{type:'string'}},required:['text']},
  ...['list_voices','get_pool_status','get_service_status'].map(name=>({name,description:name.replaceAll('_',' '),properties:{},required:[]}))
];
const toolError=(message,code=-32602)=>Object.assign(new Error(message),{code});
const result=text=>({content:[{type:'text',text:String(text??'')} ]});
const artifactUrl=(base,id)=>`${String(base).replace(/\/+$/,'')}/artifacts/${id}`;

export function createTools(client,store,{publicBaseUrl='',limits={}}={}){
  const queueMax=limits.queueMax??30;
  const sem={chat:new Semaphore(limits.chat??12,queueMax),vision:new Semaphore(limits.vision??6,queueMax),image:new Semaphore(limits.image??3,queueMax),audio:new Semaphore(limits.audio??4,queueMax),read:new Semaphore(limits.read??12,queueMax)};
  const list=()=>definitions.map(({name,description,properties,required})=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}));
  async function call(name,a={}){
    const d=definitions.find(x=>x.name===name); if(!d)throw toolError('unknown tool',-32601);
    for(const k of d.required)if(a[k]===undefined||a[k]===null||a[k]==='')throw toolError(`${k} is required`);
    let r;
    if(name==='chat_text'){r=await sem.chat.run(()=>client.post('/v1/chat/completions',{messages:[{role:'user',content:a.prompt}]},{timeoutMs:45000}));return result(r.json?.choices?.[0]?.message?.content)}
    if(name==='analyze_image'){r=await sem.vision.run(()=>client.post('/v1/chat/completions',{prompt:a.prompt,referenceImage:a.image},{timeoutMs:45000}));return result(r.json?.choices?.[0]?.message?.content)}
    if(name==='generate_image'||name==='edit_image'){
      const path=name==='generate_image'?'/v1/images/generations':'/v1/images/variations';
      r=await sem.image.run(()=>client.post(path,{prompt:a.prompt,...(a.image!==undefined?{image:a.image}:{}),...(a.aspect_ratio?{ratio:a.aspect_ratio}:{})},{timeoutMs:120000}));
      const item=r.json?.data?.[0]; const mime=item?.mimeType||r.json?.image?.mimeType||mimeFromDataUrl(item?.url)||'image/png';
      const base64=item?.b64_json||r.json?.image?.base64||base64FromDataUrl(item?.url); const art=await store.putBase64(base64,mime);return result(artifactUrl(publicBaseUrl,art.id));
    }
    if(name==='generate_audio'){r=await sem.audio.run(()=>client.post('/v1/audio/speech',{input:a.text,...(a.voice?{voice:a.voice}:{})},{timeoutMs:60000}));const audio=r.json?.audio;const art=r.data?await store.put(r.data,r.mime):await store.putBase64(audio?.base64||audio||r.json?.data?.[0]?.b64_json,audio?.mimeType||r.json?.mimeType||r.json?.mime||'audio/mpeg');return result(artifactUrl(publicBaseUrl,art.id))}
    const path=name==='list_voices'?'/v1/tts/voices':name==='get_pool_status'?'/api/pool':'/api/health';r=await sem.read.run(()=>client.get(path,{timeoutMs:45000}));return result(JSON.stringify(r.json));
  }
  return{list,call,semaphores:sem};
}
function mimeFromDataUrl(v){return typeof v==='string'?v.match(/^data:([^;,]+);base64,/)?.[1]:undefined}
function base64FromDataUrl(v){return typeof v==='string'?v.match(/^data:[^;,]+;base64,(.*)$/)?.[1]:undefined}
