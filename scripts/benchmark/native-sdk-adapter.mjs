// Trusted-only diagnostic backend. This adapter does NOT establish a sandbox.
import { AgentOs } from '../../packages/agentos-sdk/dist/native-entry.js';
import { join } from 'node:path';
import { createAgentOsToolRuntime } from '../../packages/openclaw-core/src/sdk-tool-runtime.mjs';
export async function createNativeSdkAdapter(root) {
 const workspace=join(root,'workspace');
 const experiment=process.env.AGENTOS_LINUX_EXPERIMENT==='1';
 const vm=experiment
  ?await AgentOs.createLinuxExperiment({acknowledgement:process.env.AGENTOS_LINUX_ACK,workspaceDir:workspace,cgroupDir:process.env.AGENTOS_TEST_CGROUP,runtimeManifest:process.env.AGENTOS_RUNTIME_MANIFEST})
  :await AgentOs.create({backend:'native-node',workspaceDir:workspace,security:'trusted-only',filesystemBackend:process.env.AGENTOS_SDK_FILESYSTEM??'node'});
 const counts={read:0,stat:0,shell:0};
 const runtime=createAgentOsToolRuntime(vm,{env:experiment?{}:{HOME:vm.workspaceDir,PATH:process.env.PATH}});
 const bridge=runtime.sandbox.fsBridge;
 const sandbox={...runtime.sandbox,fsBridge:{...bridge,
  readFile(...args){counts.read++;return bridge.readFile(...args);},
  stat(...args){counts.stat++;return bridge.stat(...args);},
 }};
 function spawn(...args){counts.shell++;return runtime.spawn(...args);}
 return {vm,sandbox,spawn,counts,dispose:()=>vm.dispose()};
}
