import {Semaphore} from './limits.js';

const imageSchema={oneOf:[{type:'string',description:'Image data URL'},{type:'object',properties:{mimeType:{type:'string'},base64:{type:'string'}},required:['mimeType','base64'],additionalProperties:false}]};
const definitions=[
  {name:'chat_text',description:'Chat with text',properties:{prompt:{type:'string'}},required:['prompt']},
  {name:'analyze_image',description:'Analyze image',properties:{prompt:{type:'string'},image:imageSchema},required:['prompt','image']},
  {name:'generate_image',description:'Generate image',properties:{prompt:{type:'string'},aspect_ratio:{type:'string'},image:imageSchema,extraImages:{type:'array',items:imageSchema}},required:['prompt']},
  {name:'generate_gpt_image',description:'Generate image with GPT Image 2.5 (Leonardo) — high quality AI image from a text prompt, optionally guided by a reference image. Returns image URL. aspect_ratio: 16:9 | 9:16 | 4:5 (feed Instagram). model: openai/gpt-image-2.5-flare | openai/gpt-image-2.5-sunburst. Defaults: size MEDIUM, quality MEDIUM (ukuran MEDIUM ~56 kredit di akun Leonardo FREE yang bersaldo 150 kredit/gambar).',properties:{prompt:{type:'string'},aspect_ratio:{type:'string',enum:['16:9','9:16','4:5']},size:{type:'string',enum:['SMALL','MEDIUM','LARGE']},quality:{type:'string',enum:['LOW','MEDIUM','HIGH']},model:{type:'string',enum:['openai/gpt-image-2.5-flare','openai/gpt-image-2.5-sunburst','gpt-image-2']},image:imageSchema},required:['prompt']},
  {name:'generate_minimax_video',description:'Generate video with MiniMax Hailuo 03 (Leonardo) — text-to-video or image-to-video. Returns video URL. Slow: usually 1-5 minutes. Fixed settings: 768p (720p HD) resolution, TURBO quality.',properties:{prompt:{type:'string'},aspect_ratio:{type:'string',enum:['9:16','16:9']},duration:{type:'integer',enum:[6,10]},image:imageSchema},required:['prompt']},
  {name:'edit_image',description:'Edit image',properties:{prompt:{type:'string'},image:imageSchema,aspect_ratio:{type:'string'}},required:['prompt','image']},
  {name:'generate_audio',description:'Generate audio',properties:{text:{type:'string'},voice:{type:'string'}},required:['text']},
  {name:'generate_video',description:'Generate video (Omni Video) from text prompt and optionally a reference image. Returns job id — poll with check_video. resolution: 720p (default, cepat) atau 1080p (lebih tajam, mesin lebih lama).',properties:{prompt:{type:'string'},image:imageSchema,aspect_ratio:{type:'string',enum:['16:9','9:16']},resolution:{type:'string',enum:['720p','1080p']}},required:['prompt']},
  {name:'check_video',description:'Check Omni Video job status (poll after generate_video). Returns status and video URL when done.',properties:{job_id:{type:'string'}},required:['job_id']},
  {name:'remove_watermark',description:'Remove watermark from an uploaded MP4 video via Omni Video. Returns job id — poll with check_video.',properties:{video_url:{type:'string',description:'URL of the MP4 video'}},required:['video_url']},
  ...['list_voices','get_pool_status','get_service_status'].map(name=>({name,description:name.replaceAll('_',' '),properties:{},required:[]}))
];
const toolError=(message,code=-32602)=>Object.assign(new Error(message),{code});
const result=text=>({content:[{type:'text',text:String(text??'')} ]});
const artifactUrl=(base,id)=>`${String(base).replace(/\/+$/,'')}/artifacts/${id}`;
// Angka env yang aman: harus bilangan bulat > 0, kalau tidak pakai cadangan.
const positive=(v,fallback)=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:fallback};

export function createTools(client,store,{publicBaseUrl='',limits={},omni=null}={}){
  const queueMax=limits.queueMax??30;
  const sem={chat:new Semaphore(limits.chat??12,queueMax),vision:new Semaphore(limits.vision??6,queueMax),image:new Semaphore(limits.image??3,queueMax),gptImage:new Semaphore(limits.gptImage??3,queueMax),audio:new Semaphore(limits.audio??4,queueMax),read:new Semaphore(limits.read??12,queueMax),video:new Semaphore(limits.video??positive(process.env.VIDEO_CONCURRENCY,100),queueMax)};
  const list=()=>definitions.map(({name,description,properties,required})=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}));
  async function call(name,a={}){
    const d=definitions.find(x=>x.name===name); if(!d)throw toolError('unknown tool',-32601);
    for(const k of d.required)if(a[k]===undefined||a[k]===null||a[k]==='')throw toolError(`${k} is required`);
    let r;
    if(name==='chat_text'){r=await sem.chat.run(()=>client.post('/v1/chat/completions',{messages:[{role:'user',content:a.prompt}]},{timeoutMs:45000}));return result(r.json?.choices?.[0]?.message?.content)}
    if(name==='analyze_image'){r=await sem.vision.run(()=>client.post('/v1/chat/completions',{prompt:a.prompt,referenceImage:a.image},{timeoutMs:45000}));return result(r.json?.choices?.[0]?.message?.content)}
    if(name==='generate_image'||name==='edit_image'){
      const path=name==='generate_image'?'/v1/images/generations':'/v1/images/variations';
      r=await sem.image.run(()=>client.post(path,{prompt:a.prompt,...(a.image!==undefined?{image:a.image}:{}),...(Array.isArray(a.extraImages)&&a.extraImages.length?{extraImages:a.extraImages}:{}),...(a.aspect_ratio?{ratio:a.aspect_ratio}:{})},{timeoutMs:120000}));
      const item=r.json?.data?.[0]; const mime=item?.mimeType||r.json?.image?.mimeType||mimeFromDataUrl(item?.url)||'image/png';
      const base64=item?.b64_json||r.json?.image?.base64||base64FromDataUrl(item?.url); const art=await store.putBase64(base64,mime);return result(artifactUrl(publicBaseUrl,art.id));
    }
    if(name==='generate_gpt_image'){
      r=await sem.gptImage.run(()=>client.post('/v1/images/gpt',{prompt:a.prompt,...(a.aspect_ratio?{ratio:a.aspect_ratio}:{}),...(a.size?{size:a.size}:{}),...(a.quality?{quality:a.quality}:{}),...(a.model?{model:a.model}:{}),...(a.image!==undefined?{image:a.image}:{})},{timeoutMs:300000}));
      const items=Array.isArray(r.json?.data)?r.json.data.filter(x=>x?.url):[];
      if(!items.length)throw new Error(r.json?.error||'GPT Image tidak mengembalikan gambar');
      const urls=[];
      for(const it of items){
        const resp=await fetch(it.url,{signal:AbortSignal.timeout(120000)});
        if(!resp.ok)throw new Error(`gagal unduh gambar: HTTP ${resp.status}`);
        const buf=Buffer.from(await resp.arrayBuffer());
        const mime=sniffImageMime(buf)||normalizeMime(it.mimeType)||'image/jpeg';
        const art=await store.put(buf,mime);
        urls.push(artifactUrl(publicBaseUrl,art.id));
      }
      return result(`${urls.join('\n')}\n(model ${r.json?.model||'openai/gpt-image-2.5-sunburst'}${r.json?.width?`, ${r.json.width}x${r.json.height}`:''})`);
    }
    if(name==='generate_minimax_video'){
      r=await sem.video.run(()=>client.post('/v1/videos/omni',{prompt:a.prompt,resolution:'768p',quality:'TURBO',...(a.aspect_ratio?{ratio:a.aspect_ratio}:{}),...(a.duration?{duration:a.duration}:{}),...(a.image!==undefined?{image:a.image}:{})},{timeoutMs:900000}));
      const vids=Array.isArray(r.json?.data)?r.json.data.filter(x=>x?.url):[];
      if(!vids.length)throw new Error(r.json?.error||'Omni Video tidak mengembalikan video');
      const vurls=[];
      // CDN Leonardo menolak request tanpa User-Agent/Referer (403/404) — header ini wajib.
      const cdnHeaders={
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        'Referer':'https://app.leonardo.ai/','Origin':'https://app.leonardo.ai','Accept':'*/*',
      };
      for(const it of vids){
        const resp=await fetch(it.url,{headers:cdnHeaders,signal:AbortSignal.timeout(300000)});
        if(!resp.ok)throw new Error(`gagal unduh video: HTTP ${resp.status}`);
        const buf=Buffer.from(await resp.arrayBuffer());
        const art=await store.put(buf,sniffVideoMime(buf)||it.mimeType||'video/mp4');
        vurls.push(artifactUrl(publicBaseUrl,art.id));
      }
      return result(`${vurls.join('\n')}\n(Omni Video / MiniMax ${r.json?.model||'hailuo-03'} — ${r.json?.ratio||'9:16'} ${r.json?.resolution||'768p'} ${r.json?.duration||10}s ${r.json?.quality||'TURBO'}, ${r.json?.mode||'text-to-video'})`);
    }
    if(name==='generate_audio'){r=await sem.audio.run(()=>client.post('/v1/audio/speech',{input:a.text,...(a.voice?{voice:a.voice}:{})},{timeoutMs:60000}));const audio=r.json?.audio;const art=r.data?await store.put(r.data,r.mime):await store.putBase64(audio?.base64||audio||r.json?.data?.[0]?.b64_json,audio?.mimeType||r.json?.mimeType||r.json?.mime||'audio/mpeg');return result(artifactUrl(publicBaseUrl,art.id))}
    if(name==='generate_video')return omniVideo(a,store,publicBaseUrl);
    if(name==='check_video')return omniCheck(a);
    if(name==='remove_watermark')return omniWatermark(a,store,publicBaseUrl);
    const path=name==='list_voices'?'/v1/tts/voices':name==='get_pool_status'?'/api/pool':'/api/health';r=await sem.read.run(()=>client.get(path,{timeoutMs:45000}));return result(JSON.stringify(r.json));
  }

  // ---- Omni Video helpers ----
  const vname=v=>String(v||'').replace(/^\/video\//,'').replace(/^\//,'');
  async function pollVideo(jobId,{timeoutMs=2000000,intervalMs=5000}={}){
    const t0=Date.now();
    while(Date.now()-t0<timeoutMs){
      await new Promise(ok=>setTimeout(ok,intervalMs));
      const st=await omni(`/api/status/${jobId}`,{method:'GET'});
      const j=st.json||{};
      if(j.status==='done')return j;
      if(j.status==='failed'||j.status==='error')throw new Error(`Omni Video gagal: ${j.error||'unknown'}`);
    }
    throw new Error('Omni Video timeout — job masih diproses, cek lagi dengan check_video');
  }

  async function omniVideo(a,artStore,base){
    if(!omni)throw toolError('Omni Video tidak tersedia');
    const ratio=(a.aspect_ratio==='9:16')?'9:16':'16:9';
    // Resolusi: 720p default; 1080p hanya bila diminta eksplisit.
    const res=(a.resolution==='1080p')?'1080p':'720p';
    return sem.video.run(async()=>{
      let jobId;
      if(a.image){
        // image-to-video: kirim multipart
        const {buf,mime,ext}=await imgBuf(a.image);
        const fd=new FormData();
        fd.append('image',new Blob([buf],{type:mime}),`ref.${ext}`);
        fd.append('prompt',String(a.prompt));
        fd.append('ratio',ratio);
        fd.append('resolution',res);
        const r=await omni('/api/generate',{method:'POST',body:fd});
        if(!r.json?.id)throw new Error(`Omni Video gagal antre: ${JSON.stringify(r.json).slice(0,200)}`);
        jobId=r.json.id;
      }else{
        const body=new FormData();
        body.append('prompt',String(a.prompt));
        body.append('ratio',ratio);
        body.append('resolution',res);
        const r=await omni('/api/t2v',{method:'POST',body});
        if(!r.json?.id)throw new Error(`Omni Video gagal antre: ${JSON.stringify(r.json).slice(0,200)}`);
        jobId=r.json.id;
      }
      const done=await pollVideo(jobId);
      const mp4=await omni(`/video/${vname(done.video)}`,{method:'GET'});
      const art=await artStore.put(mp4.data,'video/mp4');
      return result(`${artifactUrl(base,art.id)}\n(video ${done.video}, rasio ${done.ratio}, resolusi ${done.resolution||res})`);
    });
  }

  async function omniCheck(a){
    if(!omni)throw toolError('Omni Video tidak tersedia');
    if(!/^[a-f0-9]{6,32}$/.test(String(a.job_id)))throw toolError('job_id tidak valid');
    const st=await omni(`/api/status/${a.job_id}`,{method:'GET'});
    const j=st.json||{};
    if(j.status==='done'&&j.video)return result(JSON.stringify({status:'done',video_url:`/omni/video/${j.video}`,ratio:j.ratio}));
    return result(JSON.stringify(j));
  }

  async function omniWatermark(a,artStore,base){
    if(!omni)throw toolError('Omni Video tidak tersedia');
    return sem.video.run(async()=>{
      // unduh video dari URL
      let src=String(a.video_url);
      if(!/^https?:\/\//i.test(src))throw toolError('video_url harus http(s)');
      const resp=await fetch(src,{signal:AbortSignal.timeout(120000)});
      if(!resp.ok)throw new Error(`gagal unduh video: HTTP ${resp.status}`);
      const buf=Buffer.from(await resp.arrayBuffer());
      if(buf.length>100*1024*1024)throw new Error('video lebih dari 100 MB');
      const fd=new FormData();
      fd.append('video',new Blob([buf],{type:'video/mp4'}),'in.mp4');
      fd.append('remove_wm','1');
      const r=await omni('/api/upload',{method:'POST',body:fd});
      if(!r.json?.id)throw new Error(`Omni Video gagal antre: ${JSON.stringify(r.json).slice(0,200)}`);
      const done=await pollVideo(r.json.id,{timeoutMs:900000});
      const mp4=await omni(`/video/${vname(done.video)}`,{method:'GET'});
      const art=await artStore.put(mp4.data,'video/mp4');
      return result(`${artifactUrl(base,art.id)}\n(watermark dihapus: ${done.video})`);
    });
  }

  return{list,call,semaphores:sem};
}
function mimeFromDataUrl(v){return typeof v==='string'?v.match(/^data:([^;,]+);base64,/)?.[1]:undefined}
function normalizeMime(v){if(typeof v!=='string')return null;const m=v.split(';')[0].trim().toLowerCase();return m==='image/jpg'?'image/jpeg':(m||null)}
function sniffImageMime(buf){
  if(!buf||buf.length<12)return null;
  if(buf[0]===0x89&&buf[1]===0x50&&buf[2]===0x4e&&buf[3]===0x47)return'image/png';
  if(buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return'image/jpeg';
  if(buf.slice(0,4).toString('ascii')==='RIFF'&&buf.slice(8,12).toString('ascii')==='WEBP')return'image/webp';
  return null;
}
function base64FromDataUrl(v){return typeof v==='string'?v.match(/^data:[^;,]+;base64,(.*)$/)?.[1]:undefined}
function sniffVideoMime(buf){
  if(!buf||buf.length<12)return null;
  const ascii=buf.slice(0,12).toString('ascii');
  if(buf.slice(4,8).toString('ascii')==='ftyp'){
    if(ascii.includes('mp4')||ascii.includes('isom')||ascii.includes('iso2')||ascii.includes('avc1')||ascii.includes('mp42'))return'video/mp4';
    if(ascii.includes('qt'))return'video/quicktime';
  }
  if(buf[0]===0x1a&&buf[1]===0x45&&buf[2]===0xdf&&buf[3]===0xa3)return'video/webm';
  return null;
}
async function imgBuf(image){
  if(typeof image==='string'){
    const m=image.match(/^data:([^;,]+);base64,(.*)$/);
    if(m)return{buf:Buffer.from(m[2],'base64'),mime:m[1],ext:m[1]==='image/png'?'png':'jpg'};
    throw new Error('image harus data URL atau {mimeType,base64}');
  }
  const mime=image.mimeType||'image/jpeg';
  return{buf:Buffer.from(image.base64,'base64'),mime,ext:mime==='image/png'?'png':'jpg'};
}
