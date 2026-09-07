import { resolve, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Adapts an existing SDK handle; its caller owns creation and disposal.
// OpenClaw's historical "sandbox" name does not imply an isolation guarantee.
export function createAgentOsToolRuntime(vm, { env = {} } = {}) {
  const workspace = vm.workspaceDir;
  const experiment = vm.capabilities.experimentalEnforcement === 'unverified-linux';
  function workspacePath(file, cwd = workspace) {
    const path = resolve(cwd, file);
    const local = relative(workspace, path);
    if (local === '..' || local.startsWith('..' + sep) || local.startsWith(sep)) {
      throw new Error('Outside workspace');
    }
    return path;
  }
  const sdkPath = (file, cwd) => vm.capabilities.filesystemBackend === 'linux-openat2'
    ? (relative(workspace, workspacePath(file, cwd)) || '.') : workspacePath(file, cwd);
  const fsBridge = {
    resolvePath: ({ filePath, cwd }) => ({ containerPath: workspacePath(filePath, cwd) }),
    async readFile({ filePath, cwd }) {
      return Buffer.from(await vm.filesystem.readFile(sdkPath(filePath, cwd)));
    },
    async writeFile({ filePath, cwd, data }) {
      await vm.filesystem.writeFile(sdkPath(filePath, cwd), data);
    },
    async stat({ filePath, cwd }) {
      const stat = await vm.filesystem.stat(sdkPath(filePath, cwd));
      return { ...stat, type: stat.isDirectory ? 'directory' : 'file' };
    },
    async mkdirp({ filePath, cwd }) {
      await vm.filesystem.mkdir(sdkPath(filePath, cwd), { recursive: true });
    },
  };
  const sandbox = {
    required: true, workspaceDir: workspace, agentWorkspaceDir: workspace,
    workspaceAccess: 'rw', containerWorkdir: workspace,
    containerName: experiment ? 'native-sdk-linux-unverified' : 'native-sdk-trusted-only',
    fsBridge,
    backend: {
      workdirValidation: 'backend', env,
      async validateWorkdir(cwd) {
        const path = workspacePath(cwd);
        if (!(await vm.filesystem.stat(sdkPath(path))).isDirectory) throw new Error('Invalid cwd');
        return path;
      },
      async buildExecSpec({ command, workdir, env, usePty }) {
        if (usePty) throw new Error('PTY unsupported');
        return { argv: ['native-sdk-shell', workspacePath(workdir), command], env, stdinMode: 'pipe-open' };
      },
    },
  };
  async function spawn(spec) {
    if (spec.backendId !== 'exec-sandbox' || spec.argv?.[0] !== 'native-sdk-shell') {
      throw new Error('Unexpected execution route');
    }
    const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
    const process = await vm.process.spawn('sh', ['-c', spec.argv[2]], {
      cwd: workspacePath(spec.argv[1]), env: spec.env, timeoutMs: spec.timeoutMs,
      onStdout: bytes => spec.onStdout?.(out.write(bytes)),
      onStderr: bytes => spec.onStderr?.(err.write(bytes)), output: { retainEvents: false },
    });
    const done = vm.process.wait(process.pid);
    let cancelled;
    return {
      pid: process.pid,
      stdin: {
        write(bytes, callback) {
          const written = vm.process.writeStdin(process.pid, bytes);
          // OpenClaw's process tool awaits the Node-style callback. Direct SDK
          // callers can still await the promise when no callback is supplied.
          return callback ? written.then(() => callback(), error => callback(error)) : written;
        },
        end: () => vm.process.closeStdin(process.pid),
      },
      cancel(reason = 'manual-cancel') {
        cancelled = reason;
        void vm.process.kill(process.pid).catch(error => console.error('SDK cancellation failed', error));
      },
      async wait() {
        const exit = await done;
        const stdout = out.end(), stderr = err.end();
        if (stdout) spec.onStdout?.(stdout);
        if (stderr) spec.onStderr?.(stderr);
        const reason = cancelled ?? (exit.outcome === 'timed_out' ? 'overall-timeout'
          : exit.outcome === 'exited' ? 'exit' : 'signal');
        return {
          exitCode: exit.exitCode, exitSignal: exit.signal, reason,
          timedOut: exit.outcome === 'timed_out' || reason === 'overall-timeout' || reason === 'no-output-timeout',
          noOutputTimedOut: reason === 'no-output-timeout',
        };
      },
    };
  }
  return { sandbox, spawn };
}
