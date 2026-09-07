import { resolve, relative, sep, dirname } from 'node:path';
import { constants } from 'node:fs';
import { createProcessSupervisorWithAdapter } from '../upstream/src/process/supervisor/supervisor-runtime.js';
import { createSdkProcessAdapter } from './sdk-process-adapter.mjs';

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
  async function write({ filePath, cwd, data, encoding, mkdir = true, signal }, exclusive = false) {
    signal?.throwIfAborted();
    const target = workspacePath(filePath, cwd);
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding) : data;
    if (mkdir) await vm.filesystem.mkdir(sdkPath(dirname(target)), { recursive: true, signal });
    await vm.filesystem[exclusive ? 'createFileExclusive' : 'writeFile'](sdkPath(target), bytes, { signal });
  }
  const fsBridge = {
    resolvePath: ({ filePath, cwd }) => {
      const containerPath = workspacePath(filePath, cwd);
      return { containerPath, relativePath: relative(workspace, containerPath) };
    },
    async readFile({ filePath, cwd, signal, maxBytes }) {
      const bytes = await vm.filesystem.readFile(sdkPath(filePath, cwd), { signal, maxBytes });
      return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    },
    writeFile: write,
    async createFileExclusive(params) {
      try { await write(params, true); return 'created'; }
      catch (error) { if (!params.signal?.aborted && error?.code === 'EEXIST') return 'exists'; throw error; }
    },
    async stat({ filePath, cwd, signal }) {
      try {
        const stat = await vm.filesystem.stat(sdkPath(filePath, cwd), { signal });
        return { size: stat.size, mtimeMs: stat.mtimeMs,
          type: stat.isDirectory ? 'directory' : (stat.mode & constants.S_IFMT) === constants.S_IFREG ? 'file' : 'other' };
      } catch (error) { if (!signal?.aborted && error?.code === 'ENOENT') return null; throw error; }
    },
    async mkdirp({ filePath, cwd, signal }) {
      await vm.filesystem.mkdir(sdkPath(filePath, cwd), { recursive: true, signal });
    },
    async remove({ filePath, cwd, recursive = false, force = false, signal }) {
      try { await vm.filesystem.remove(sdkPath(filePath, cwd), { recursive, signal }); }
      catch (error) { if (signal?.aborted || !force || error?.code !== 'ENOENT') throw error; }
    },
    async rename({ from, to, cwd, signal }) {
      await vm.filesystem.move(sdkPath(from, cwd), sdkPath(to, cwd), { signal });
    },
  };
  const sandbox = {
    required: true, workspaceDir: workspace, agentWorkspaceDir: workspace,
    workspaceAccess: 'rw', containerWorkdir: workspace,
    docker: { binds: [], env },
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
  const supervisor = createProcessSupervisorWithAdapter(input => createSdkProcessAdapter(vm, workspacePath, input));
  return { sandbox, supervisor };
}
