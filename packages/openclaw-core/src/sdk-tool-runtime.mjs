import { resolve, relative, sep } from 'node:path';
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
  const supervisor = createProcessSupervisorWithAdapter(input => createSdkProcessAdapter(vm, workspacePath, input));
  return { sandbox, supervisor };
}
