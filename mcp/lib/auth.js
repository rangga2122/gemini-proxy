import {randomBytes,createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,stat} from 'node:fs/promises';
import {dirname} from 'node:path';

export class KeyStore {
  constructor(file) {
    this.file=file;
    this.records=[];
    this.fileVersion=null;
    this.reloadPromise=null;
  }

  async load() {
    try {
      // Verify the path did not change around the read. Writers publish with
      // atomic rename, so a retry gives us one complete generation.
      for(;;) {
        const before=await stat(this.file,{bigint:true});
        const contents=await readFile(this.file,'utf8');
        const after=await stat(this.file,{bigint:true});
        if(version(before)!==version(after)) continue;
        this.records=JSON.parse(contents);
        this.fileVersion=version(after);
        return;
      }
    } catch(e) {
      if(e.code!=='ENOENT') throw e;
      this.records=[];
      this.fileVersion=null;
    }
  }

  async reloadIfChanged() {
    let metadata;
    try { metadata=await stat(this.file,{bigint:true}); }
    catch(e) {
      if(e.code==='ENOENT') return;
      throw e;
    }
    if(this.fileVersion===version(metadata)) return;
    if(!this.reloadPromise) {
      this.reloadPromise=this.load().finally(()=>{this.reloadPromise=null});
    }
    await this.reloadPromise;
  }

  async save() {
    await mkdir(dirname(this.file),{recursive:true});
    const temporary=`${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify(this.records),{mode:0o600});
    await rename(temporary,this.file);
    this.fileVersion=version(await stat(this.file,{bigint:true}));
  }

  async create(label,{limit=30,userId,email}={}) {
    const key='cosmic-mcp-'+randomBytes(24).toString('base64url'),id=randomUUID();
    this.records.push({id,label,hash:createHash('sha256').update(key).digest('hex'),active:true,createdAt:new Date().toISOString(),limit,usage:0,...(userId?{userId,email}:{})});
    await this.save();
    return {key,id};
  }

  async authenticate(key) {
    await this.reloadIfChanged();
    const h=createHash('sha256').update(String(key)).digest();
    for(const r of this.records) {
      const x=Buffer.from(r.hash,'hex');
      if(x.length===h.length&&timingSafeEqual(x,h)&&r.active) {
        r.usage++;
        return r;
      }
    }
    return null;
  }

  async revoke(id) {
    const r=this.records.find(x=>x.id===id);
    if(r) r.active=false;
    await this.save();
  }
}

function version(metadata) {
  return `${metadata.mtimeNs}:${metadata.ino}:${metadata.size}`;
}
