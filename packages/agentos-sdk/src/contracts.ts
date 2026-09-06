import type { ProcessExit, ProcessOutputEvent, ProcessDescriptor } from "./language-execution.js";
import type { FileApi, ProcessApi, JavaScriptApi } from "./sdk-surface.js";
export type { FileApi, ProcessApi, JavaScriptApi } from "./sdk-surface.js";
export interface Backend {
 readonly filesystem: FileApi;
 readonly process: ProcessApi;
 readonly javascript: JavaScriptApi;
 readonly workspaceDir: string;
 readonly capabilities: Readonly<Capabilities>;
 dispose(): Promise<void>;
}
export interface Capabilities {
 backend: 'native-node'; sandboxed: false; security: 'trusted-only';
 processTreeLimits: false; filesystemQuota: false; virtualRoot: false;
 detachedDescendantContainment: false; sidecar: false;
 filesystemBackend: 'node' | 'linux-openat2';
}
export interface NativeOptions {
 backend: 'native-node';
 workspaceDir: string;
 // Required explicit opt-in for unprotected diagnostic execution.
 security: 'trusted-only' | 'linux-sandbox';
 managedProcessLimit?: number;
 outputLimitBytes?: number;
 retainedProcessLimit?: number;
 maxFileBytes?: number;
 // This selects host file access only. Process execution remains trusted-only.
 filesystemBackend?: 'node' | 'linux-openat2';
 env?: Record<string,string>;
}
export interface NativeExit extends ProcessExit { error?: { code: string; message: string }; }
export interface NativeDescriptor extends ProcessDescriptor { hostPid?: number; }
export type Event = ProcessOutputEvent;
export class SdkError extends Error {
 constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name='SdkError'; }
}
export function unsupported(name: string): never { throw new SdkError('UNSUPPORTED_CAPABILITY', `${name} is not implemented by the native backend`); }
export function rejectUnknown(value: object, allowed: readonly string[], context: string) {
 for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new SdkError('UNSUPPORTED_OPTION', `${context}.${key} is not supported`);
}
export function positive(value: number, name: string) {
 if (!Number.isSafeInteger(value) || value <= 0) throw new SdkError('INVALID_OPTION', `${name} must be a positive safe integer`);
 return value;
}
