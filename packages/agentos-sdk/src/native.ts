import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Backend, NativeOptions, ProcessApi, NativeExit, NativeDescriptor, JavaScriptApi, Capabilities, Event } from './contracts.js';
import { SdkError, unsupported, rejectUnknown, positive } from './contracts.js';
import type { SpawnOptions, LanguageExecutionOptions, CodeExecutionResult, ExecutionSignal } from './language-execution.js';
import { createFileApi } from './filesystem.js';
import { inspectLinuxCapabilities } from './preflight.js';
type RecordEntry={ descriptor:NativeDescriptor; child:ChildProcessWithoutNullStreams; done:Promise<NativeExit>; exit?:NativeExit; events:Event[]; sequence:number; bytes:number; failure?:{code:string,message:string}; timeout:boolean; };
const allowedSpawn=['cwd','env','stdin','timeoutMs','signal','onStdout','onStderr','output'];
const signals=new Set<ExecutionSignal>(['SIGHUP','SIGINT','SIGQUIT','SIGTERM','SIGKILL','SIGSTOP','SIGCONT','SIGUSR1','SIGUSR2']);
export class NativeAgentOs implements Backend {
 readonly capabilities:Readonly<Capabilities>=Object.freeze({backend:'native-node',sandboxed:false,security:'trusted-only',processTreeLimits:false,filesystemQuota:false,virtualRoot:false,detachedDescendantContainment:false,sidecar:false});
 readonly filesystem:Backend['filesystem'];
 readonly process:ProcessApi;
 readonly javascript:JavaScriptApi;
 readonly workspaceDir:string;
 #records=new Map<number,RecordEntry>();
 #pending=new Set<Promise<unknown>>();
 #next=1;
 #closed=false;
 #dispose?:Promise<void>;
 #env:Record<string,string>;
 #maxActive:number;
 #maxOutput:number;
 #maxRetained:number;
 #inFlight=0;
 private constructor(root:string,options:NativeOptions){
  this.workspaceDir=root;
  this.#maxActive=positive(options.managedProcessLimit??32,'managedProcessLimit');
  this.#maxOutput=positive(options.outputLimitBytes??1048576,'outputLimitBytes');
  this.#maxRetained=positive(options.retainedProcessLimit??32,'retainedProcessLimit');
  this.#env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,LANG:'C.UTF-8',...options.env};
  const guard=<T extends object>(api:T,name:string):T=>new Proxy(api,{get(target,key,receiver){if(key in target||typeof key!=='string')return Reflect.get(target,key,receiver);if(key==='then')return undefined;return unsupported(`${name}.${key}`);}});
  this.filesystem=guard(createFileApi(root,()=>this.#assertOpen(),positive(options.maxFileBytes??16777216,'maxFileBytes')),'filesystem');
  const spawn=(command:string,args:string[]=[],opts:SpawnOptions={})=>{
   const pending=this.#spawn(command,args,opts);this.#pending.add(pending);
   void pending.then(()=>this.#pending.delete(pending),()=>this.#pending.delete(pending));return pending;
  };
  this.process=guard({
   spawn,wait:async pid=>this.#get(pid).done,
   get:async pid=>({...this.#get(pid).descriptor}),
   list:async()=>{this.#assertOpen();return [...this.#records.values()].map(r=>({...r.descriptor}));},
   tree:async()=>{this.#assertOpen();return [...this.#records.values()].map(r=>({...r.descriptor,children:[]}));},
   signal:async(pid,signal)=>{if(!signals.has(signal))throw new SdkError('INVALID_SIGNAL',String(signal));this.#kill(this.#get(pid),signal);},
   kill:async pid=>this.#kill(this.#get(pid),'SIGKILL'),
   writeStdin:async(pid,data)=>{const r=this.#get(pid);if(r.exit||r.child.stdin.destroyed)throw new SdkError('STDIN_CLOSED','Process stdin is closed');if(Buffer.byteLength(data)>this.#maxOutput||r.child.stdin.writableLength+Buffer.byteLength(data)>this.#maxOutput)throw new SdkError('STDIN_LIMIT',`Pending stdin exceeds outputLimitBytes=${this.#maxOutput}`);await new Promise<void>((ok,no)=>r.child.stdin.write(data,error=>error?no(error):ok()));},
   closeStdin:async pid=>{const r=this.#get(pid);if(r.child.stdin.destroyed)return;await new Promise<void>((ok,no)=>r.child.stdin.end((error?:Error)=>error?no(error):ok()));},
   readOutput:async(pid,options)=>{const r=this.#get(pid);const after=options?.after??0;if(!Number.isSafeInteger(after)||after<0)throw new SdkError('INVALID_CURSOR','Invalid output cursor');return {pid,events:r.events.filter(e=>e.sequence>after).map(e=>({...e,chunk:Uint8Array.from(e.chunk)})),nextCursor:String(r.sequence),hasMore:false,truncated:r.failure?.code==='OUTPUT_LIMIT'};},
   exec:(command,options)=>this.#exec('sh',['-c',command],options),
   execFile:(command,args=[],options)=>this.#exec(command,[...args],options),
  },'process');
  this.javascript=guard({
   execute:(source,options={})=>{const {format='module',...rest}=options;if(format!=='module'&&format!=='commonjs')throw new SdkError('UNSUPPORTED_OPTION','Unsupported JavaScript format');return this.#exec(process.execPath,[`--input-type=${format==='commonjs'?'commonjs':'module'}`,'-e',source],rest);},
   executeFile:(file,options)=>this.#exec(process.execPath,[file],options),
   spawn:(source,options)=>spawn(process.execPath,['--input-type=module','-e',source],options),
   spawnFile:(file,options)=>spawn(process.execPath,[file],options),
  },'javascript');
 }
 get sessions():never { return unsupported('sessions'); }
 get contexts():never { return unsupported('contexts'); }
 get terminal():never { return unsupported('terminal'); }
 get python():never { return unsupported('python'); }
 get typescript():never { return unsupported('typescript'); }
 get network():never { return unsupported('network'); }
 get software():never { return unsupported('software'); }
 get agents():never { return unsupported('agents'); }
 get cron():never { return unsupported('cron'); }
 get sidecar():never { return unsupported('sidecar'); }
 static async create(options:NativeOptions){
  rejectUnknown(options,['backend','workspaceDir','security','managedProcessLimit','outputLimitBytes','retainedProcessLimit','maxFileBytes','env'],'create');
  if(process.platform!=='linux')throw new SdkError('UNSUPPORTED_PLATFORM','This backend is currently tested only on Linux');
  if(options.security!=='trusted-only')throw new SdkError('SANDBOX_UNAVAILABLE','Linux sandbox execution is unavailable: no verified enforcement launcher is implemented. Trusted-only execution requires explicit opt-in.',await inspectLinuxCapabilities());
  if(typeof options.workspaceDir!=='string')throw new SdkError('INVALID_OPTION','workspaceDir is required');
  const root=await realpath(options.workspaceDir);if(!(await stat(root)).isDirectory())throw new SdkError('INVALID_WORKSPACE','Workspace must be an existing directory');
  return new NativeAgentOs(root,options);
 }
 #assertOpen(){if(this.#closed)throw new SdkError('DISPOSED','Workspace handle is disposed');}
 #get(pid:number){this.#assertOpen();const r=this.#records.get(pid);if(!r)throw new SdkError('PROCESS_NOT_FOUND','Unknown or evicted process handle');return r;}
 #kill(r:RecordEntry,signal:ExecutionSignal){
  if(r.exit||r.descriptor.state==='exited')return;
  try{process.kill(-r.child.pid!,signal);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
 }
 async #spawn(command:string,args:string[],options:SpawnOptions):Promise<NativeDescriptor>{
  this.#assertOpen();rejectUnknown(options,allowedSpawn,'spawn');if(options.output)rejectUnknown(options.output,['retainEvents'],'spawn.output');
  if(typeof command!=='string'||!command||command.includes('\0')||args.some(x=>typeof x!=='string'||x.includes('\0')))throw new SdkError('INVALID_COMMAND','Invalid executable/argv');
  if(options.timeoutMs!==undefined)positive(options.timeoutMs,'timeoutMs');
  if(options.stdin!==undefined&&Buffer.byteLength(options.stdin)>this.#maxOutput)throw new SdkError('STDIN_LIMIT',`stdin exceeds outputLimitBytes=${this.#maxOutput}`);
  if(options.signal?.aborted)throw new SdkError('ABORTED','Execution aborted before spawn');
  if(this.#inFlight+[...this.#records.values()].filter(x=>!x.exit).length>=this.#maxActive)throw new SdkError('MANAGED_PROCESS_LIMIT',`managedProcessLimit=${this.#maxActive} reached`);
  this.#inFlight++;
  try{
   const cwd=await realpath(resolve(this.workspaceDir,options.cwd??'.'));const rel=relative(this.workspaceDir,cwd);
   if(rel==='..'||rel.startsWith('..'+sep)||rel.startsWith(sep))throw new SdkError('OUTSIDE_WORKSPACE','cwd is outside workspace');
   if(!(await stat(cwd)).isDirectory())throw new SdkError('INVALID_CWD','cwd must be a directory');
   this.#assertOpen();if(options.signal?.aborted)throw new SdkError('ABORTED','Execution aborted before spawn');
   const env={...this.#env,...options.env};for(const [k,v] of Object.entries(env))if(typeof v!=='string'||v.includes('\0')||k.includes('=')||k.includes('\0'))throw new SdkError('INVALID_ENV','Invalid environment entry');
   const child=spawnChild(command,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
   const pid=this.#next++;let complete!:(exit:NativeExit)=>void;
   const done=new Promise<NativeExit>(r=>complete=r);
   const r:RecordEntry={descriptor:{pid,state:'running',command,startedAtMs:Date.now(),hostPid:child.pid},child,done,events:[],sequence:0,bytes:0,timeout:false};
   this.#records.set(pid,r);
   let timer:ReturnType<typeof setTimeout>|undefined;
   const abort=()=>{r.failure={code:'ABORTED',message:'Execution aborted'};this.#kill(r,'SIGKILL');};
   const finish=(code:number|null,signal:NodeJS.Signals|null,error?:Error)=>{
    if(r.exit)return;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
    r.descriptor.state='exited';
    const failure=error?{code:(error as NodeJS.ErrnoException).code??'PROCESS_ERROR',message:error.message}:r.failure;
    r.exit={pid,outcome:r.timeout?'timed_out':signal||failure?'signalled':'exited',...(code!==null?{exitCode:code}:{}),...(signal?{signal:signal as ExecutionSignal}:{}),...(failure?{error:failure}:{})};
    complete(r.exit);
    const finished=[...this.#records.entries()].filter(([,entry])=>entry.exit);
    for(const [id] of finished.slice(0,Math.max(0,finished.length-this.#maxRetained)))this.#records.delete(id);
   };
   const collect=(channel:'stdout'|'stderr',chunk:Buffer)=>{
    if(r.failure)return;
    const remaining=this.#maxOutput-r.bytes;
    const data=Buffer.from(chunk.subarray(0,Math.max(0,remaining)));r.bytes+=chunk.length;
    if(data.length){r.sequence++;if(options.output?.retainEvents!==false)r.events.push({pid,sequence:r.sequence,channel,chunk:data,timestampMs:Date.now()});
     try{(channel==='stdout'?options.onStdout:options.onStderr)?.(data);}catch(e){r.failure={code:'OUTPUT_CALLBACK_ERROR',message:String(e)};this.#kill(r,'SIGKILL');}}
    if(r.bytes>this.#maxOutput){r.failure={code:'OUTPUT_LIMIT',message:`outputLimitBytes=${this.#maxOutput} exceeded`};this.#kill(r,'SIGKILL');}
   };
   child.stdout.on('data',b=>collect('stdout',b));child.stderr.on('data',b=>collect('stderr',b));
   // EPIPE is exposed through writes; an unused stream error must not crash the manager.
   child.stdin.on('error',e=>{if((e as NodeJS.ErrnoException).code!=='EPIPE'&&!r.exit)r.failure={code:'STDIN_ERROR',message:e.message};});
   child.once('exit',()=>{this.#kill(r,'SIGKILL');}); // close same-group descendants holding pipes
   child.once('close',(code,signal)=>{finish(code,signal);child.stdout.removeAllListeners('data');child.stderr.removeAllListeners('data');child.removeAllListeners('error');});
   child.once('error',error=>finish(null,null,error));
   const started=new Promise<void>((ok,no)=>{child.once('spawn',ok);child.once('error',no);});
   if(options.timeoutMs)timer=setTimeout(()=>{r.timeout=true;this.#kill(r,'SIGKILL');},options.timeoutMs);
   options.signal?.addEventListener('abort',abort,{once:true});
   if(options.signal?.aborted)abort();
   await started;
   if(this.#closed)this.#kill(r,'SIGKILL');
   if(options.stdin!==undefined){try{await this.process.writeStdin(pid,options.stdin);await this.process.closeStdin(pid);}catch(e){this.#kill(r,'SIGKILL');throw e;}}
   return {...r.descriptor};
  }finally{this.#inFlight--;}
 }
 async #exec(command:string,args:string[],options:LanguageExecutionOptions={}):Promise<CodeExecutionResult>{
  const {args:extra=[],stdin,output,...rest}=options;
  if(stdin!==undefined&&Buffer.byteLength(stdin)>this.#maxOutput)throw new SdkError('STDIN_LIMIT',`stdin exceeds outputLimitBytes=${this.#maxOutput}`);
  rejectUnknown(rest,allowedSpawn.filter(x=>x!=='output'&&x!=='stdin'),'exec');
  if(output)rejectUnknown(output,['capture','retainEvents'],'exec.output');
  if(output?.retainEvents)throw new SdkError('UNSUPPORTED_OPTION','retainEvents is only supported for spawned processes');
  const capture=output?.capture??'none';if(!['none','stderr','all'].includes(capture))throw new SdkError('INVALID_OPTION','Invalid capture mode');
  const out:string[]=[];const err:string[]=[];const stdoutDecoder=new StringDecoder('utf8'),stderrDecoder=new StringDecoder('utf8');
  let exit:NativeExit;let entry:RecordEntry|undefined;
  try{
   const p=await this.process.spawn(command,[...args,...extra],{...rest,output:{retainEvents:output?.retainEvents??false},onStdout:b=>{if(capture==='all')out.push(stdoutDecoder.write(b));options.onStdout?.(b);},onStderr:b=>{if(capture!=='none')err.push(stderrDecoder.write(b));options.onStderr?.(b);}});
   // Capture the completion promise before another operation can evict old results.
   entry=this.#get(p.pid);const done=entry.done;
   if(stdin!==undefined)await this.process.writeStdin(p.pid,stdin);
   await this.process.closeStdin(p.pid);exit=await done;
  }catch(e){if(entry)this.#kill(entry,'SIGKILL');return {outcome:'failed',error:{code:(e as NodeJS.ErrnoException).code??'EXECUTION_ERROR',name:'ExecutionError',message:String(e)}};}
  out.push(stdoutDecoder.end());err.push(stderrDecoder.end());
  const base={...(exit.exitCode!==undefined?{exitCode:exit.exitCode}:{}),...(capture==='all'?{stdout:out.join('')}:{}),...(capture!=='none'?{stderr:err.join('')}:{}),stdoutTruncated:exit.error?.code==='OUTPUT_LIMIT',stderrTruncated:exit.error?.code==='OUTPUT_LIMIT'};
  if(exit.outcome==='exited'&&exit.exitCode===0&&!exit.error)return {...base,outcome:'succeeded'};
  return {...base,outcome:exit.outcome==='timed_out'?'timed_out':exit.outcome==='signalled'&&(!exit.error||exit.error.code==='ABORTED')?'cancelled':'failed',error:{code:exit.error?.code??'EXECUTION_FAILED',name:'ExecutionError',message:exit.error?.message??`Process ${exit.outcome} (${exit.exitCode??exit.signal})`}};
 }
 dispose():Promise<void>{
  if(this.#dispose)return this.#dispose;
  this.#closed=true;
  this.#dispose=(async()=>{
   await Promise.allSettled([...this.#pending]);
   const records=[...this.#records.values()];for(const r of records)this.#kill(r,'SIGKILL');
   // Trusted diagnostics cannot contain setsid() escapees: bound teardown instead
   // of claiming an entire hostile descendant tree is controlled.
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([Promise.all(records.map(r=>r.done)),new Promise<void>((_,no)=>{timer=setTimeout(()=>no(new SdkError('CLEANUP_TIMEOUT','A descendant may have escaped the managed process group')),3000);})]);}
   finally{clearTimeout(timer);for(const r of records){r.child.stdin.destroy();r.child.stdout.destroy();r.child.stderr.destroy();}this.#records.clear();}
  })();return this.#dispose;
 }
}
