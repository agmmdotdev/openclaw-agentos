// Trusted-only diagnostic backend. This adapter does NOT establish a sandbox.
import { AgentOs } from '../../packages/agentos-sdk/dist/native-entry.js';
import { join, resolve, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
export async function createNativeSdkAdapter(root) {
 const workspace=join(root,'workspace');
 const vm=await AgentOs.create({backend:'native-node',workspaceDir:workspace,security:'trusted-only'});
 const counts={read:0,stat:0,shell:0};
 function path(file,cwd=workspace){const p=resolve(cwd,file);const r=relative(workspace,p);if(r==='..'||r.startsWith('..'+sep)||r.startsWith(sep))throw new Error('Outside workspace');return p;}
 const bridge={
  resolvePath:({filePath,cwd})=>({containerPath:path(filePath,cwd)}),
  async readFile({filePath,cwd}){counts.read++;return Buffer.from(await vm.filesystem.readFile(path(filePath,cwd)));},
  async writeFile({filePath,cwd,data}){await vm.filesystem.writeFile(path(filePath,cwd),data);},
  async stat({filePath,cwd}){counts.stat++;const s=await vm.filesystem.stat(path(filePath,cwd));return {...s,type:s.isDirectory?'directory':'file'};},
  async mkdirp({filePath,cwd}){await vm.filesystem.mkdir(path(filePath,cwd),{recursive:true});},
 };
 // OpenClaw calls this interface "sandbox"; capabilities below describe the actual boundary.
 const sandbox={required:true,workspaceDir:workspace,agentWorkspaceDir:workspace,workspaceAccess:'rw',containerName:'native-sdk-trusted-only',containerWorkdir:workspace,fsBridge:bridge,
  backend:{workdirValidation:'backend',env:{HOME:workspace,PATH:process.env.PATH},
   async validateWorkdir(cwd){const p=path(cwd);if(!(await vm.filesystem.stat(p)).isDirectory)throw new Error('Invalid cwd');return p;},
   async buildExecSpec({command,workdir,env,usePty}){if(usePty)throw new Error('PTY unsupported');return {argv:['native-sdk-shell',path(workdir),command],env,stdinMode:'pipe'};},
  },
 };
 async function spawn(spec){
  if(spec.backendId!=='exec-sandbox'||spec.argv?.[0]!=='native-sdk-shell')throw new Error('Unexpected execution route');
  counts.shell++;const out=new StringDecoder('utf8'),err=new StringDecoder('utf8');
  const p=await vm.process.spawn('sh',['-c',spec.argv[2]],{cwd:path(spec.argv[1]),env:spec.env,timeoutMs:spec.timeoutMs,onStdout:b=>spec.onStdout?.(out.write(b)),onStderr:b=>spec.onStderr?.(err.write(b)),output:{retainEvents:false}});
  const done=vm.process.wait(p.pid);let cancelled;
  return {pid:p.pid,stdin:{write:b=>vm.process.writeStdin(p.pid,b),end:()=>vm.process.closeStdin(p.pid)},
   cancel(reason){cancelled=reason;void vm.process.kill(p.pid).catch(e=>console.error('SDK cancellation failed',e));},
   async wait(){const e=await done;const a=out.end(),b=err.end();if(a)spec.onStdout?.(a);if(b)spec.onStderr?.(b);return {exitCode:e.exitCode,exitSignal:e.signal,reason:cancelled??(e.outcome==='timed_out'?'timeout':e.outcome==='exited'?'exit':'signal'),timedOut:e.outcome==='timed_out'||cancelled==='timeout'};},
  };
 }
 return {vm,sandbox,spawn,counts,dispose:()=>vm.dispose()};
}
