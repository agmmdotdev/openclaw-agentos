import type { ProcessExit, ProcessOutputEvent, ProcessDescriptor } from "./language-execution.js";
import type { FileApi, ProcessApi, JavaScriptApi } from "./sdk-surface.js";
export type { FileApi, ProcessApi, JavaScriptApi } from "./sdk-surface.js";
// Native extensions leave the extracted agentOS declaration slice unchanged.
export interface FileOperationOptions { signal?: AbortSignal; }
export interface FileReadOptions extends FileOperationOptions { maxBytes?: number; }
export interface NativeFileApi extends FileApi {
 readFile(path: string, options?: FileReadOptions): Promise<Uint8Array>;
 writeFile(path: string, content: string | Uint8Array, options?: FileOperationOptions): Promise<void>;
 createFileExclusive(path: string, content: string | Uint8Array, options?: FileOperationOptions): Promise<void>;
 stat(path: string, options?: FileOperationOptions): ReturnType<FileApi['stat']>;
 mkdir(path: string, options?: FileOperationOptions & { recursive?: boolean }): Promise<void>;
 move(from: string, to: string, options?: FileOperationOptions): Promise<void>;
 remove(path: string, options?: FileOperationOptions & { recursive?: boolean }): Promise<void>;
}
export interface Backend {
 readonly filesystem: NativeFileApi;
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
 experimentalEnforcement?: 'unverified-linux';
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
export interface NativeDescriptor extends ProcessDescriptor { hostPid?: number; supervisorPid?: number; cgroup?: string; }
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
