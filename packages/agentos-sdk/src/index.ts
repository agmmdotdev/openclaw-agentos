import type { AgentOs as OriginalAgentOs, AgentOsOptions } from '@rivet-dev/agentos-core';
import type { NativeOptions } from './contracts.js';
import { NativeAgentOs } from './native.js';
import { SdkError } from './contracts.js';
export { NativeAgentOs, SdkError };
export { inspectLinuxCapabilities } from './preflight.js';
export type * from './contracts.js';
export type * from './language-execution.js';
export class AgentOs {
 static create(options:NativeOptions):Promise<NativeAgentOs>;
 static create(options:{backend:'agentos';options?:AgentOsOptions}):Promise<OriginalAgentOs>;
 static async create(options:NativeOptions|{backend:'agentos';options?:AgentOsOptions}){
  if(options?.backend==='native-node')return NativeAgentOs.create(options);
  if(options?.backend==='agentos'){
   const {AgentOs:Original}=await import('@rivet-dev/agentos-core');
   return Original.create(options.options);
  }
  throw new SdkError('INVALID_BACKEND','Select native-node or agentos explicitly');
 }
}
