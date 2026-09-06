import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, stat, statfs, rmdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import type { NativeOptions } from './contracts.js';
import { SdkError, positive, rejectUnknown } from './contracts.js';
import { inspectLinuxCapabilities } from './preflight.js';
export interface LinuxExperimentOptions {
  acknowledgement: 'unverified-test-only';
  workspaceDir: string;
  cgroupDir: string;
  runtimeManifest: string;
  memoryMaxBytes?: number;
  pidsMax?: number;
  cpuQuotaMicros?: number;
  cpuPeriodMicros?: number;
  managedProcessLimit?: number;
  outputLimitBytes?: number;
  maxFileBytes?: number;
}
interface Manifest { version: 1; node: string; files: Array<{ path: string; sha256: string }>; commands?: Record<string, string>; }
export interface LinuxJob {
  child: ChildProcessWithoutNullStreams;
  readonly rootPid: number | undefined;
  readonly cgroup: string;
  ready: Promise<void>;
  signal(signal: string): void;
  finish(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
const binary = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const read = async (p: string) => (await readFile(p, 'utf8')).trim();
const contains = (parent: string, path: string) => { const r = relative(parent, path); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
async function digest(path: string) { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); }
export class LinuxProcessDriver {
  private constructor(private root: string, private delegation: string, private manifest: Manifest, private controls: Record<string, string>) {}
  static async create(options: LinuxExperimentOptions) {
    rejectUnknown(options, ['acknowledgement', 'workspaceDir', 'cgroupDir', 'runtimeManifest', 'memoryMaxBytes', 'pidsMax', 'cpuQuotaMicros', 'cpuPeriodMicros', 'managedProcessLimit', 'outputLimitBytes', 'maxFileBytes'], 'linuxExperiment');
    if (options.acknowledgement !== 'unverified-test-only') throw new SdkError('EXPERIMENTAL_ACKNOWLEDGEMENT_REQUIRED', 'This test backend is unverified');
    const host = await inspectLinuxCapabilities();
    if (host.platform !== 'linux' || host.architecture !== 'x64' || !((host.landlock as { landlockAbi?: number })?.landlockAbi! >= 6)) throw new SdkError('SANDBOX_UNAVAILABLE', 'Experimental Linux execution requires usable Landlock ABI >=6 on x86_64', host);
    const root = await realpath(options.workspaceDir), delegation = await realpath(options.cgroupDir);
    if (!(await stat(root)).isDirectory()) throw new SdkError('INVALID_WORKSPACE', 'Existing workspace directory required');
    if (/^\/(proc|sys|dev)(\/|$)/.test(root) || contains(root, delegation) || contains(delegation, root) ||
      contains(root, binary('linux-supervisor-experimental')) || contains(root, fileURLToPath(import.meta.url))) {
      throw new SdkError('UNSAFE_WORKSPACE', 'Workspace must be separate from system trees, delegation and trusted SDK code');
    }
    if ([0x63677270, 0x27e0eb, 0x9fa0, 0x62656572].includes((await statfs(root)).type)) throw new SdkError('UNSAFE_WORKSPACE', 'Workspace cannot be a kernel control filesystem');
    if ((await statfs(delegation)).type !== 0x63677270) throw new SdkError('CGROUP_UNAVAILABLE', 'Expected cgroup v2 delegation');
    const enabled = (await read(join(delegation, 'cgroup.subtree_control'))).split(/\s+/);
    if (!['cpu', 'memory', 'pids'].every(x => enabled.includes(x))) throw new SdkError('CGROUP_UNAVAILABLE', 'cpu/memory/pids must already be enabled in the delegation');
    const manifest = JSON.parse(await readFile(options.runtimeManifest, 'utf8')) as Manifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 256) throw new SdkError('INVALID_MANIFEST', 'A bounded version-1 runtime manifest is required');
    for (const f of manifest.files) {
      if (!isAbsolute(f.path) || /^\/(proc|sys|dev)(\/|$)/.test(f.path) || await realpath(f.path) !== f.path || !(await stat(f.path)).isFile()) throw new SdkError('INVALID_MANIFEST', 'Runtime grants must be canonical regular files');
      if (contains(root, f.path)) throw new SdkError('UNSAFE_WORKSPACE', 'Writable workspace cannot contain a runtime grant');
      if (await digest(f.path) !== f.sha256) throw new SdkError('RUNTIME_HASH_MISMATCH', f.path);
    }
    if (manifest.node !== await realpath(process.execPath) || !manifest.files.some(f => f.path === manifest.node)) throw new SdkError('INVALID_MANIFEST', 'This experiment requires the host Node in its runtime closure');
    for (const [alias, path] of Object.entries(manifest.commands ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(alias) || !manifest.files.some(f => f.path === path)) throw new SdkError('INVALID_MANIFEST', 'Command aliases must select runtime files');
    }
    const controls = { 'memory.max': String(positive(options.memoryMaxBytes ?? 268435456, 'memoryMaxBytes')),
      'memory.swap.max': '0', 'memory.oom.group': '1', 'pids.max': String(positive(options.pidsMax ?? 64, 'pidsMax')),
      'cpu.max': `${positive(options.cpuQuotaMicros ?? 20000, 'cpuQuotaMicros')} ${positive(options.cpuPeriodMicros ?? 100000, 'cpuPeriodMicros')}` };
    return new LinuxProcessDriver(root, delegation, manifest, controls);
  }
  async prepare(command: string, args: string[], cwd: string): Promise<PreparedLinuxJob> {
    let executable = isAbsolute(command) ? command : this.manifest.commands?.[command];
    if (!executable) throw new SdkError('UNSUPPORTED_COMMAND', `No reviewed runtime alias for ${command}`);
    executable = await realpath(executable);
    if (!this.manifest.files.some(f => f.path === executable)) throw new SdkError('UNSUPPORTED_COMMAND', 'Entry executable must be in the reviewed runtime manifest');
    const rel = relative(this.root, cwd);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new SdkError('OUTSIDE_WORKSPACE', 'cwd must be inside workspace');
    const path = [...new Set(Object.values(this.manifest.commands ?? {}).map(dirname))].join(':') || '/nonexistent';
    if (Object.values(this.manifest.commands ?? {}).some(p => p.includes(':'))) throw new SdkError('INVALID_MANIFEST', 'Command paths cannot contain PATH separators');
    const group = join(this.delegation, `agentos-job-${randomUUID()}`);
    await mkdir(group);
    try {
      for (const [file, value] of Object.entries(this.controls)) await writeFile(join(group, file), value);
      await writeFile(join(group, 'cgroup.kill'), '1');
    } catch (e) { await rmdir(group).catch(() => {}); throw e; }
    const argv = [group, '--', binary('linux-launcher-experimental'), '--workspace', this.root,
      '--cwd', rel || '.', '--path', path, '--cgroup', group, '--memory', this.controls['memory.max'],
      '--pids', this.controls['pids.max'], '--cpu', this.controls['cpu.max'],
      ...this.manifest.files.flatMap(f => ['--runtime-file', f.path]), '--', executable, ...args];
    // Admission/cancellation is rechecked by the SDK before invoking this closure.
    let used = false;
    const start = () => {
      if (used) throw new SdkError('INVALID_STATE', 'Job can only start once'); used = true;
      const child = spawn(binary('linux-supervisor-experimental'), argv, { env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
      let readyOk!: () => void, readyFail!: (e: unknown) => void;
      const ready = new Promise<void>((ok, no) => { readyOk = ok; readyFail = no; });
      // Prevent a fast setup failure being unhandled before the SDK awaits readiness.
      void ready.catch(() => {});
      let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let rootPid: number | undefined;
      let cleaned = false, failure: Error | undefined, pending = '', bytes = 0;
      const control = child.stdio[4] as import('node:stream').Duplex;
      control.on('error', () => {});
      const fail = (e: Error) => { failure ??= e; readyFail(e); if (!control.destroyed) control.end('K'); };
      const timer = setTimeout(() => fail(new SdkError('LAUNCH_TIMEOUT', 'No Linux restriction readiness within 5 seconds')), 5000);
      (child.stdio[3] as import('node:stream').Readable).on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) { fail(new SdkError('STATUS_LIMIT', 'Supervisor status limit exceeded')); return; }
        pending += chunk.toString();
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.event === 'enrolled') rootPid = event.pid;
            if (event.stage === 'restricted-before-exec') { clearTimeout(timer); readyOk(); }
            if (event.event === 'root-exit') {
              const signal = event.signal ? Object.entries(constants.signals).find(([, n]) => n === event.signal)?.[0] as NodeJS.Signals | undefined : null;
              if (signal === undefined) fail(new SdkError('UNSUPPORTED_EXIT_SIGNAL', `Unmapped Linux exit signal ${event.signal}`));
              else rootExit = { code: event.code < 0 ? null : event.code, signal };
            }
            if (event.event === 'cleanup-complete' && event.populated === 0) cleaned = true;
            if (event.event === 'supervisor-error' || event.errno) fail(new SdkError('LINUX_LAUNCH_FAILED', `Linux launcher failed at ${event.stage}`, event));
          } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); }
        }
      });
      child.once('error', fail);
      let closed!: () => void; const close = new Promise<void>(ok => { closed = ok; });
      child.once('close', () => { clearTimeout(timer); readyFail(failure ?? new SdkError('LINUX_LAUNCH_FAILED', 'Supervisor exited before readiness')); closed(); });
      let completion: ReturnType<LinuxJob['finish']> | undefined;
      return { child, ready, cgroup: group, get rootPid() { return rootPid; },
        signal: (signal: string) => {
          if (signal !== 'SIGKILL') throw new SdkError('UNSUPPORTED_SIGNAL', 'Experimental Linux jobs support whole-job SIGKILL only');
          if (!control.destroyed && !control.writableEnded) control.end('K');
        },
        finish: () => completion ??= (async () => {
          await close;
          // Remove only this job's empty group. Never remove the delegated parent.
          try {
            if (!(await read(join(group, 'cgroup.events'))).split('\n').includes('populated 0')) throw new SdkError('CLEANUP_FAILED', 'Workload cgroup remains populated');
            await rmdir(group);
          } catch (e) { failure ??= e as Error; }
          if (failure) throw failure;
          if (!cleaned || !rootExit) throw new SdkError('CLEANUP_FAILED', 'Supervisor did not confirm reaping and empty cgroup');
          return rootExit;
        })(),
      };
    };
    // Cleanup of an allocated but unstarted group is attached to the closure.
    return Object.assign(start, { cancel: async () => { if (!used) { used = true; await rmdir(group); } } });
  }
}
export type PreparedLinuxJob = (() => LinuxJob) & { cancel(): Promise<void> };
export function nativeOptions(options: LinuxExperimentOptions): NativeOptions {
  return { backend: 'native-node', workspaceDir: options.workspaceDir, security: 'trusted-only', filesystemBackend: 'linux-openat2',
    managedProcessLimit: options.managedProcessLimit, outputLimitBytes: options.outputLimitBytes, maxFileBytes: options.maxFileBytes };
}
