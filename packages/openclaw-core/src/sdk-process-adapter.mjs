import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { onDecodedOutput } from '../upstream/src/process/decoded-output.js';

// The SDK owns child processes. OpenClaw owns records, scopes, deadlines and capture.
export async function createSdkProcessAdapter(vm, workspacePath, input) {
  if (input.mode !== 'child' || input.backendId !== 'exec-sandbox'
      || input.argv.length !== 3 || input.argv[0] !== 'native-sdk-shell') {
    throw new Error('Unexpected execution route');
  }
  const stdinMode = input.stdinMode ?? (input.input !== undefined ? 'pipe-closed' : 'pipe-open');
  if (!['pipe-open', 'pipe-closed'].includes(stdinMode) || input.secretInput
      || input.windowsVerbatimArguments || input.exactEnv) {
    throw new Error('Unsupported SDK process options');
  }
  const stdout = new PassThrough(), stderr = new PassThrough();
  let child;
  try {
    child = await vm.process.spawn('sh', ['-c', input.argv[2]], {
      cwd: workspacePath(input.argv[1]), env: input.env,
      onStdout: bytes => { stdout.write(bytes); },
      onStderr: bytes => { stderr.write(bytes); }, output: { retainEvents: false },
    });
  } catch (error) {
    stdout.destroy(); stderr.destroy(); throw error;
  }
  let adapterFailure;
  const kill = (signal = 'SIGKILL') => {
    void vm.process.signal(child.pid, signal).catch(error => { adapterFailure ??= error; });
  };
  const failInput = error => { adapterFailure ??= error; kill(); };
  let ended = false, closed = false, inputFinished = false, closing;
  const endInput = () => {
    ended = true;
    return closing ??= vm.process.closeStdin(child.pid).then(() => { inputFinished = true; }, failInput);
  };
  const stdin = {
    get writable() { return !ended && !closed; },
    get writableEnded() { return ended; },
    get writableFinished() { return inputFinished; },
    get destroyed() { return closed; },
    write(bytes, callback) {
      if (ended || closed) { callback?.(new Error('stdin is not writable')); return; }
      // Submit each write directly: an intermediate Writable queue would bypass
      // the SDK's pending-input byte bound until queued writes reach the SDK.
      const written = vm.process.writeStdin(child.pid, bytes);
      void written.catch(() => undefined);
      return callback ? written.then(() => callback(), error => callback(error)) : written;
    },
    end: endInput,
    destroy() { closed = true; void endInput(); },
  };
  // Attach immediately: SDK completion can precede supervisor subscriptions.
  // PassThrough buffers those early bytes within the SDK's output limit.
  const done = vm.process.wait(child.pid).then(async exit => {
    closed = true; ended = true;
    stdout.end(); stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
    if (adapterFailure) throw adapterFailure;
    if (exit.error) throw Object.assign(new Error(exit.error.message), { code: exit.error.code });
    return { code: exit.exitCode ?? null, signal: exit.signal ?? null };
  });
  void done.catch(() => undefined);
  if (input.input !== undefined) {
    stdin.write(input.input, error => { if (error) failInput(error); });
    stdin.end();
  } else if (stdinMode === 'pipe-closed') {
    stdin.end();
  }
  return {
    pid: child.hostPid, stdin, kill,
    onStdout: (listener, raw) => onDecodedOutput(stdout, listener, raw),
    onStderr: (listener, raw) => onDecodedOutput(stderr, listener, raw),
    wait: () => done,
    dispose() { closed = true; stdout.destroy(); stderr.destroy(); },
    // No extinction guarantee beyond the SDK's current process-group contract.
  };
}
