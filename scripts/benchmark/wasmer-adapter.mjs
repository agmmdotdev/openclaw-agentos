// Experimental benchmark adapter: trusted native core, Wasmer SDK file/shell tools.
import { Wasmer } from '@wasmer/sdk/node';
import { StringDecoder } from 'node:string_decoder';
import { join, posix } from 'node:path';

export async function createWasmerAdapter(root) {
  const workspace = join(root, 'workspace');
  const wasmer = new Wasmer({ parallelism: 2, cache: { directory: process.env.WASMER_CACHE_DIR ?? '/tmp/openclaw-wasmer-cache' } });
  let guestSandbox;
  try { guestSandbox = await wasmer.sandboxes.create({ packages: ['wasmer/edgejs@0.2.0'], network: { mode: 'disabled' } }); }
  catch (error) { await wasmer.close(); throw error; }
  // SDK filesystem paths are relative to the guest /workspace mount.
  const sdkPath = path => path === '/workspace' ? '/' : path.slice('/workspace'.length);
  const filesystem = {};
  for (const method of ['readFile', 'writeFile', 'stat', 'mkdir']) filesystem[method] = (path, ...args) => guestSandbox.fs[method](sdkPath(path), ...args);
  const vm = { filesystem };
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
    async stat({ filePath, cwd }) { counts.stat++; const s = await vm.filesystem.stat(guest(filePath, cwd)); return { ...s, type: (s.kind === 'directory') ? 'directory' : 'file' }; },
    async mkdirp({ filePath, cwd }) { await vm.filesystem.mkdir(guest(filePath, cwd), { recursive: true }); },
    async writeFile({ filePath, cwd, data }) { await vm.filesystem.writeFile(guest(filePath, cwd), data); },
  };
  const sandbox = {
    required: true, workspaceDir: workspace, agentWorkspaceDir: workspace, workspaceAccess: 'rw',
    containerName: 'wasmer', containerWorkdir: '/workspace', fsBridge: bridge,
    backend: {
      workdirValidation: 'backend', env: { HOME: '/workspace', PATH: '/usr/local/bin:/usr/bin:/bin' },
      async validateWorkdir(p) { const s = await vm.filesystem.stat(guest(p)); if (!(s.kind === 'directory')) throw new Error('Workdir is not a directory'); return guest(p); },
      async buildExecSpec({ command, workdir, env, usePty }) {
        if (usePty) throw new Error('PTY is not implemented in this benchmark');
        return { argv: ['wasmer-benchmark-shell', guest(workdir), command], env, stdinMode: 'pipe' };
      },
    },
  };
  async function spawn(spec) {
    if (spec.backendId !== 'exec-sandbox' || spec.argv?.[0] !== 'wasmer-benchmark-shell') throw new Error('Hybrid benchmark refuses host shell execution');
    counts.shell++;
    const proc = await guestSandbox.command('sh', ['-c', spec.argv[2]], { cwd: guest(spec.argv[1]), env: spec.env }).spawn({
      timeoutMs: spec.timeoutMs, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    async function pump(stream, callback) {
      const decoder = new StringDecoder('utf8');
      for await (const chunk of stream) { const text = decoder.write(chunk); if (text) callback?.(text); }
      const tail = decoder.end(); if (tail) callback?.(tail);
    }
    const streams = Promise.all([pump(proc.stdout, spec.onStdout), pump(proc.stderr, spec.onStderr)]);
    let cancelled;
    const timer = spec.timeoutMs ? setTimeout(() => { cancelled = "timeout"; void proc.kill().catch(() => {}); }, spec.timeoutMs) : undefined;
    return {
      pid: proc.id,
      stdin: { write: data => proc.stdin.write(data), end: () => proc.stdin.close() },
      cancel(reason) { cancelled = reason; void proc.kill().catch(() => {}); },
      async wait() { let e; try { [e] = await Promise.all([proc.wait(), streams]); } finally { clearTimeout(timer); } return { exitCode: e.exitCode, exitSignal: null,
        reason: cancelled ?? (e.reason === 'exited' ? 'exit' : e.reason === 'timeout' ? 'timeout' : 'signal'),
        timedOut: cancelled === 'timeout' || e.reason === 'timeout' }; },
    };
  }
  return { sandbox, spawn, counts, vm, async dispose() { try { await guestSandbox.close(); } finally { await wasmer.close(); } } };
}
