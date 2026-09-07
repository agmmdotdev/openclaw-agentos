import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, sep, dirname } from 'node:path';
import type { NativeFileApi, FileOperationOptions } from './contracts.js';
import { SdkError } from './contracts.js';
import { checkFileOptions, readLimit } from './file-options.js';
// Trusted-input adapter only. Rechecks and O_NOFOLLOW are defensive, not an
// atomic path-resolution boundary against a concurrent malicious rename.
export function createFileApi(root:string, assertOpen:()=>void, maxBytes:number):NativeFileApi {
 const within=(path:string) => { const r=relative(root,path); return r==='' || (r!=='..' && !r.startsWith('..'+sep) && !r.startsWith(sep)); };
 async function path(input:string, missing=false):Promise<string> {
  assertOpen();
  if(typeof input!=='string'||input.includes('\0'))throw new SdkError('INVALID_PATH','Invalid filesystem path');
  const p=resolve(root,input);
  if(!within(p))throw new SdkError('OUTSIDE_WORKSPACE','Path is outside the assigned workspace');
  let cursor=p, absent:unknown;
  for (;;) {
   try { const real=await fs.realpath(cursor); if(!within(real))throw new SdkError('OUTSIDE_WORKSPACE','Symlink points outside workspace'); break; }
   catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT' || cursor===root)throw e; absent??=e;cursor=dirname(cursor); }
  }
  if(!missing&&absent)throw absent;
  return p;
 }
 async function write(p:string,data:string|Uint8Array,options:FileOperationOptions={},exclusive=false) {
  checkFileOptions(options);
  const bytes=typeof data==='string'?Buffer.byteLength(data):data.byteLength;
  if(bytes>maxBytes)throw new SdkError('FILE_SIZE_LIMIT',`Write exceeds maxFileBytes=${maxBytes}`);
  const target=await path(p,true);options.signal?.throwIfAborted();
  const h=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK|(exclusive?constants.O_EXCL:0),0o600);
  try {
   if(!(await h.stat()).isFile())throw new SdkError('INVALID_FILE','Only regular files can be written');
   options.signal?.throwIfAborted();
   await h.truncate(0);await h.writeFile(data,{signal:options.signal});
  }finally{await h.close();}
 }
 const api:NativeFileApi={
  async readFile(p,options={}) { const limit=readLimit(options,maxBytes);const target=await path(p);options.signal?.throwIfAborted();const h=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
   const s=await h.stat();if(!s.isFile())throw new SdkError('INVALID_FILE','Only regular files can be read');
   if(s.size>limit)throw new SdkError('FILE_SIZE_LIMIT',`File exceeds maxFileBytes=${limit}`);
   // Size the first buffer to this regular file plus one EOF/growth probe byte.
   // Stable files need neither 64 KiB per tiny read nor a second full-size copy.
   // Read only initialized slices; keep checking the bound if the file grows.
   const chunks:Buffer[]=[];let total=0;
   for(;;){
    options.signal?.throwIfAborted();
    const b=Buffer.allocUnsafe(Math.min(chunks.length?65536:s.size+1,limit+1-total));
    const {bytesRead}=await h.read(b);if(!bytesRead)break;total+=bytesRead;
    if(total>limit)throw new SdkError('FILE_SIZE_LIMIT',`Read exceeds maxFileBytes=${limit}`);
    chunks.push(b.subarray(0,bytesRead));
    if(bytesRead<b.length) {
     // A short regular-file read need not be EOF; use a small next probe.
     const probe=Buffer.allocUnsafe(1);const next=await h.read(probe);
     if(!next.bytesRead)break;
     if(++total>limit)throw new SdkError('FILE_SIZE_LIMIT',`Read exceeds maxFileBytes=${limit}`);
     chunks.push(probe);
    }
   }
   options.signal?.throwIfAborted();
   return chunks.length===1?chunks[0]:Buffer.concat(chunks,total);
  }finally{await h.close();} },
  writeFile: write,
  createFileExclusive: (p,data,options)=>write(p,data,options,true),
  async stat(p,options={}) {checkFileOptions(options);const target=await path(p);options.signal?.throwIfAborted();const s=await fs.stat(target);return {...s,isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink()};},
  async mkdir(p,options={}) {checkFileOptions(options,['recursive']);const target=await path(p,true);options.signal?.throwIfAborted();await fs.mkdir(target,{recursive:options.recursive??false,mode:0o700});},
  async readdir(p) {return fs.readdir(await path(p));},
  async readdirEntries(p) {return (await fs.readdir(await path(p),{withFileTypes:true})).map(s=>({name:s.name,isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink()}));},
  async exists(p) {try{await path(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  async move(a,b,options={}) {checkFileOptions(options);const from=await path(a),to=await path(b,true);if(from===root||to===root)throw new SdkError('INVALID_PATH','Cannot move workspace root');options.signal?.throwIfAborted();await fs.rename(from,to);},
  async remove(p,options={}) {checkFileOptions(options,['recursive']);const file=await path(p);if(file===root)throw new SdkError('INVALID_PATH','Cannot remove workspace root');const s=await fs.lstat(file);options.signal?.throwIfAborted();if(s.isDirectory()&&!options.recursive)await fs.rmdir(file);else await fs.rm(file,{recursive:options?.recursive??false,force:false});},
  async readFiles(paths) {if(paths.length>1024)throw new SdkError('BATCH_LIMIT','At most 1024 files per batch');const results=[];let total=0;for(const p of paths){try{const content=await api.readFile(p);total+=content.byteLength;if(total>maxBytes)throw new SdkError('BATCH_SIZE_LIMIT',`Batch exceeds maxFileBytes=${maxBytes}`);results.push({path:p,content});}catch(e){results.push({path:p,content:null,error:String(e)});}}return results;},
  async writeFiles(entries) {if(entries.length>1024)throw new SdkError('BATCH_LIMIT','At most 1024 files per batch');const results=[];for(const e of entries){try{await api.writeFile(e.path,e.content);results.push({path:e.path,success:true});}catch(error){results.push({path:e.path,success:false,error:String(error)});}}return results;},
  async readdirRecursive(p,options) {const result:Array<{path:string,type:'directory'|'file'|'symlink',size:number}>=[];const maxDepth=options?.maxDepth??32;if(!Number.isInteger(maxDepth)||maxDepth<0||maxDepth>64)throw new SdkError('INVALID_OPTION','maxDepth must be 0..64');
   async function walk(dir:string,depth:number){for(const e of await fs.readdir(await path(dir),{withFileTypes:true})){if(options?.exclude?.includes(e.name))continue;const child=resolve(dir,e.name);const s=await fs.lstat(child);result.push({path:child,type:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':'file',size:s.size});if(result.length>10000)throw new SdkError('DIRECTORY_LIMIT','At most 10000 entries per walk');if(e.isDirectory()&&depth<maxDepth)await walk(child,depth+1);}}
   await walk(await path(p),0);return result;
  },
 };
 return api;
}
