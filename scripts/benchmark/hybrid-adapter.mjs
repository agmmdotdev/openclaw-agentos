// Experimental benchmark adapter: trusted native core, agentOS file/shell tools.
import { AgentOs } from '@rivet-dev/agentos-core';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function createHybridAdapter(root) {
  const workspace = join(root, 'workspace');
  const vm = await AgentOs.create({
    sidecar: { kind: 'shared', pool: `hybrid-${randomUUID()}` },
    mounts: [{ path: '/workspace', plugin: { id: 'chunked_local', config: {
      metadataPath: join(root, 'workspace.sqlite'), blockRoot: join(root, 'workspace-blocks'),
      uid: 1000, gid: 1000, dirMode: 0o700, fileMode: 0o600,
    } } }],
    permissions: { fs: 'allow', process: 'allow', childProcess: 'allow', env: 'allow', network: 'deny', binding: 'deny' },
    limits: { resources: { maxProcesses: 32, maxOpenFds: 256, maxFilesystemBytes: 512 * 1024 * 1024 },
      jsRuntime: { v8HeapLimitMb: 256, cpuTimeLimitMs: 120000, wallClockLimitMs: 180000 } },
  });
  const counts = { read: 0, stat: 0, shell: 0 };
  function guest(filePath, cwd = workspace) {
    if (filePath.includes('\0') || filePath.split('/').includes('..')) throw new Error('Invalid tool path');
    const mapped = filePath === workspace || filePath.startsWith(workspace + '/') ? '/workspace' + filePath.slice(workspace.length) : filePath;
    const base = cwd === workspace || cwd.startsWith(workspace + '/') ? '/workspace' + cwd.slice(workspace.length) : cwd;
    const result = posix.resolve(base, mapped);
    if (result !== '/workspace' && !result.startsWith('/workspace/')) throw new Error('Tool path outside workspace');
    return result;
  }
  const bridge = {
    resolvePath({ filePath, cwd }) { return { containerPath: guest(filePath, cwd) }; },
    async readFile({ filePath, cwd }) { counts.read++; return Buffer.from(await vm.filesystem.readFile(guest(filePath, cwd))); },
    async stat({ filePath, cwd }) { counts.stat++; const s = await vm.filesystem.stat(guest(filePath, cwd)); return { ...s, type: s.isDirectory ? 'directory' : 'file' }; },
    async mkdirp({ filePath, cwd }) { await vm.filesystem.mkdir(guest(filePath, cwd), { recursive: true }); },
    async writeFile({ filePath, cwd, data }) { await vm.filesystem.writeFile(guest(filePath, cwd), data); },
  };
  const sandbox = {
    required: true, workspaceDir: workspace, agentWorkspaceDir: workspace, workspaceAccess: 'rw',
    containerName: 'agentos', containerWorkdir: '/workspace', fsBridge: bridge,
    backend: {
      workdirValidation: 'backend', env: { HOME: '/workspace', PATH: '/usr/local/bin:/usr/bin:/bin' },
      async validateWorkdir(p) { const s = await vm.filesystem.stat(guest(p)); if (!s.isDirectory) throw new Error('Workdir is not a directory'); return guest(p); },
      async buildExecSpec({ command, workdir, env, usePty }) {
        if (usePty) throw new Error('PTY is not implemented in this benchmark');
        return { argv: ['agentos-benchmark-shell', guest(workdir), command], env, stdinMode: 'pipe' };
      },
    },
  };
  async function spawn(spec) {
    if (spec.backendId !== 'exec-sandbox' || spec.argv?.[0] !== 'agentos-benchmark-shell') throw new Error('Hybrid benchmark refuses host shell execution');
    counts.shell++;
    const proc = await vm.process.spawn('sh', ['-c', spec.argv[2]], {
      cwd: guest(spec.argv[1]), env: spec.env, timeoutMs: spec.timeoutMs,
      onStdout: b => spec.onStdout?.(Buffer.from(b).toString()),
      onStderr: b => spec.onStderr?.(Buffer.from(b).toString()), output: { retainEvents: false },
    });
    let cancelled;
    const timer = spec.timeoutMs ? setTimeout(() => { cancelled = 'timeout'; void vm.process.kill(proc.pid).catch(() => {}); }, spec.timeoutMs) : undefined;
    return {
      pid: proc.pid,
      stdin: { write: data => vm.process.writeStdin(proc.pid, data), end: () => vm.process.closeStdin(proc.pid) },
      cancel(reason) { cancelled = reason; void vm.process.kill(proc.pid).catch(() => {}); },
      async wait() { let e; try { e = await vm.process.wait(proc.pid); } finally { clearTimeout(timer); } return { exitCode: e.exitCode, exitSignal: e.signal, reason: cancelled ?? (e.outcome === 'timed_out' ? 'timeout' : e.outcome === 'exited' ? 'exit' : 'signal'), timedOut: cancelled === 'timeout' || e.outcome === 'timed_out' }; },
    };
  }
  return { sandbox, spawn, counts, vm, async dispose() { await vm.dispose(); await vm.sidecar.dispose(); } };
}
