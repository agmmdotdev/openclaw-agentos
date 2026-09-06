// Public API slice extracted from agentOS 0.2.19 declarations (Apache-2.0).
import type { ProcessDescriptor, ProcessExit, SpawnOptions, LanguageExecutionOptions, CodeExecutionResult, ExecutionSignal, OutputReplay, JavaScriptExecutionOptions, LanguageSpawnOptions } from "./language-execution.js";
export interface FileApi {
readFile: (path: string) => Promise<Uint8Array>;
writeFile: (path: string, content: string | Uint8Array) => Promise<void>;
readFiles: (paths: string[]) => Promise<BatchReadResult[]>;
writeFiles: (entries: BatchWriteEntry[]) => Promise<BatchWriteResult[]>;
stat: (path: string) => Promise<VirtualStat>;
mkdir: (path: string, options?: {
            recursive?: boolean;
        }) => Promise<void>;
readdir: (path: string) => Promise<string[]>;
readdirEntries: (path: string) => Promise<ReaddirEntry[]>;
readdirRecursive: (path: string, options?: ReaddirRecursiveOptions) => Promise<DirEntry[]>;
exists: (path: string) => Promise<boolean>;
move: (from: string, to: string) => Promise<void>;
remove: (path: string, options?: {
            recursive?: boolean;
        }) => Promise<void>;
}
export interface ProcessApi {
exec: (command: string, options?: LanguageExecutionOptions) => Promise<CodeExecutionResult>;
execFile: (command: string, args?: readonly string[], options?: Omit<LanguageExecutionOptions, "args">) => Promise<CodeExecutionResult>;
spawn: (command: string, args?: string[], options?: SpawnOptions) => Promise<ProcessDescriptor>;
get: (pid: number) => Promise<ProcessDescriptor>;
list: () => Promise<ProcessDescriptor[]>;
tree: () => Promise<ProcessTreeNode[]>;
wait: (pid: number) => Promise<ProcessExit>;
signal: (pid: number, signal: ExecutionSignal) => Promise<void>;
kill: (pid: number) => Promise<void>;
writeStdin: (pid: number, data: string | Uint8Array) => Promise<void>;
closeStdin: (pid: number) => Promise<void>;
readOutput: (pid: number, options?: {
            after?: number;
        }) => Promise<OutputReplay>;
}
export interface JavaScriptApi {
execute: (source: string, options?: JavaScriptExecutionOptions) => Promise<CodeExecutionResult>;
executeFile: (path: string, options?: LanguageExecutionOptions) => Promise<CodeExecutionResult>;
spawn: (source: string, options?: LanguageSpawnOptions) => Promise<ProcessDescriptor>;
spawnFile: (path: string, options?: LanguageSpawnOptions) => Promise<ProcessDescriptor>;
}
export interface ProcessTreeNode extends ProcessDescriptor {
	ppid?: number;
	children: ProcessTreeNode[];
}
export interface DirEntry {
	/** Absolute path to the entry. */
	path: string;
	type: "file" | "directory" | "symlink";
	size: number;
}
export interface ReaddirEntry {
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}
export interface ReaddirRecursiveOptions {
	/** Maximum depth to recurse (0 = only immediate children). */
	maxDepth?: number;
	/** Directory names to skip. */
	exclude?: string[];
}
export interface BatchWriteEntry {
	path: string;
	content: string | Uint8Array;
}
export interface BatchWriteResult {
	path: string;
	success: boolean;
	error?: string;
}
export interface BatchReadResult {
	path: string;
	content: Uint8Array | null;
	error?: string;
}
export interface VirtualStat {
	mode: number;
	size: number;
	sizeExact?: bigint;
	blocks: number;
	dev: number;
	rdev: number;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
	ino: number;
	inoExact?: bigint;
	nlink: number;
	nlinkExact?: bigint;
	uid: number;
	gid: number;
}
