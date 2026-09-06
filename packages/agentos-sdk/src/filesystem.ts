import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, sep, dirname } from 'node:path';
import type { FileApi } from './contracts.js';
import { SdkError } from './contracts.js';
// Trusted-input adapter only. Rechecks and O_NOFOLLOW are defensive, not an
// atomic path-resolution boundary against a concurrent malicious rename.
export function createFileApi(root:string, assertOpen:()=>void, maxBytes:number):FileApi {
 const within=(path:string) => { const r=relative(root,path); return r==='' || (r!=='..' && !r.startsWith('..'+sep) && !r.startsWith(sep)); };
 async function path(input:string, missing=false):Promise<string> {
  assertOpen();
  if(typeof input!=='string'||input.includes('\0'))throw new SdkError('INVALID_PATH','Invalid filesystem path');
  const p=resolve(root,input);
  if(!within(p))throw new SdkError('OUTSIDE_WORKSPACE','Path is outside the assigned workspace');
  let cursor=p;
  for (;;) {
   try { const real=await fs.realpath(cursor); if(!within(real))throw new SdkError('OUTSIDE_WORKSPACE','Symlink points outside workspace'); return p; }
   catch(e) { if(!missing || (e as NodeJS.ErrnoException).code!=='ENOENT' || cursor===root)throw e; cursor=dirname(cursor); }
  }
 }
 const api:FileApi={
  async readFile(p) { const h=await fs.open(await path(p),constants.O_RDONLY|constants.O_NOFOLLOW);try{
   const s=await h.stat();if(!s.isFile())throw new SdkError('INVALID_FILE','Only regular files can be read');
   if(s.size>maxBytes)throw new SdkError('FILE_SIZE_LIMIT',`File exceeds maxFileBytes=${maxBytes}`);
   // Size the first buffer to this regular file plus one EOF/growth probe byte.
   // Stable files need neither 64 KiB per tiny read nor a second full-size copy.
   // Read only initialized slices; keep checking the bound if the file grows.
   const chunks:Buffer[]=[];let total=0;
   for(;;){
    const b=Buffer.allocUnsafe(Math.min(chunks.length?65536:s.size+1,maxBytes+1-total));
    const {bytesRead}=await h.read(b);if(!bytesRead)break;total+=bytesRead;
    if(total>maxBytes)throw new SdkError('FILE_SIZE_LIMIT',`Read exceeds maxFileBytes=${maxBytes}`);
    chunks.push(b.subarray(0,bytesRead));
    if(bytesRead<b.length) {
     // A short regular-file read need not be EOF; use a small next probe.
     const probe=Buffer.allocUnsafe(1);const next=await h.read(probe);
     if(!next.bytesRead)break;
     if(++total>maxBytes)throw new SdkError('FILE_SIZE_LIMIT',`Read exceeds maxFileBytes=${maxBytes}`);
     chunks.push(probe);
    }
   }
   return chunks.length===1?chunks[0]:Buffer.concat(chunks,total);
  }finally{await h.close();} },
  async writeFile(p,data) {const bytes=typeof data==='string'?Buffer.byteLength(data):data.byteLength;if(bytes>maxBytes)throw new SdkError('FILE_SIZE_LIMIT',`Write exceeds maxFileBytes=${maxBytes}`);const h=await fs.open(await path(p,true),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{await h.writeFile(data);}finally{await h.close();}},
  async stat(p) {const s=await fs.stat(await path(p));return {...s,isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink()};},
  async mkdir(p,options) {await fs.mkdir(await path(p,true),{recursive:options?.recursive??false,mode:0o700});},
  async readdir(p) {return fs.readdir(await path(p));},
  async readdirEntries(p) {return (await fs.readdir(await path(p),{withFileTypes:true})).map(s=>({name:s.name,isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink()}));},
  async exists(p) {try{await path(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  async move(a,b) {const from=await path(a);if(from===root)throw new SdkError('INVALID_PATH','Cannot move workspace root');await fs.rename(from,await path(b,true));},
  async remove(p,options) {const file=await path(p);if(file===root)throw new SdkError('INVALID_PATH','Cannot remove workspace root');if((await fs.lstat(file)).isDirectory()&&!options?.recursive)await fs.rmdir(file);else await fs.rm(file,{recursive:options?.recursive??false,force:false});},
  async readFiles(paths) {if(paths.length>1024)throw new SdkError('BATCH_LIMIT','At most 1024 files per batch');const results=[];let total=0;for(const p of paths){try{const content=await api.readFile(p);total+=content.byteLength;if(total>maxBytes)throw new SdkError('BATCH_SIZE_LIMIT',`Batch exceeds maxFileBytes=${maxBytes}`);results.push({path:p,content});}catch(e){results.push({path:p,content:null,error:String(e)});}}return results;},
  async writeFiles(entries) {if(entries.length>1024)throw new SdkError('BATCH_LIMIT','At most 1024 files per batch');const results=[];for(const e of entries){try{await api.writeFile(e.path,e.content);results.push({path:e.path,success:true});}catch(error){results.push({path:e.path,success:false,error:String(error)});}}return results;},
  async readdirRecursive(p,options) {const result:Array<{path:string,type:'directory'|'file'|'symlink',size:number}>=[];const maxDepth=options?.maxDepth??32;if(!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>64)throw new SdkError('INVALID_OPTION','maxDepth must be 0..64');
   async function walk(dir:string,depth:number){for(const e of await fs.readdir(await path(dir),{withFileTypes:true})){if(options?.exclude?.includes(e.name))continue;const child=resolve(dir,e.name);const s=await fs.lstat(child);result.push({path:child,type:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':'file',size:s.size});if(result.length>10000)throw new SdkError('DIRECTORY_LIMIT','At most 10000 entries per walk');if(e.isDirectory()&&depth<maxDepth)await walk(child,depth+1);}}
   await walk(await path(p),0);return result;
  },
 };
 return api;
}
