import childProcess from 'node:child_process';
export * from 'node:child_process';

// agentOS 0.2.19 has a separate child emitter, not events.EventEmitter.
// Its public off() also misses once listeners. Keep this narrowly scoped to
// its pinned listener-table representation; fail if that representation changes.
const prototype = childProcess.ChildProcess.prototype;
if (typeof prototype.removeAllListeners !== 'function') {
  Object.defineProperty(prototype, 'removeAllListeners', {
    configurable: true, writable: true,
    value: function (event) {
      const tables = [this._listeners, this._onceListeners];
      if (tables.some(table => !table || typeof table !== 'object')) {
        throw new Error('Unsupported agentOS child-process listener representation');
      }
      const events = arguments.length ? [event] : [...new Set(tables.flatMap(table => Reflect.ownKeys(table)))];
      // Removal notifications must remain installed until other events clear.
      events.sort((a, b) => Number(a === 'removeListener') - Number(b === 'removeListener'));
      for (const name of events) {
        for (const table of tables) {
          const listeners = table[name] ?? [];
          delete table[name];
          if (name !== 'removeListener') {
            for (const listener of [...listeners].reverse()) this.emit('removeListener', name, listener);
          }
        }
      }
      return this;
    },
  });
}
export default childProcess;

const nativeExecFileSync = childProcess.execFileSync;
const loginEnvironmentCommand = "printf '\\0'; env -0";
// The published agentOS env command hangs with -0; printenv -0 has the same
// environment-only output. Match only OpenClaw's exact login-shell probe,
// retaining its shell, flags, startup files, sentinel, options and errors.
export function execFileSync(file, args, options) {
  const loginProbe = file === '/bin/sh' && Array.isArray(args)
    && ((args.length === 3 && args[0] === '-l' && args[1] === '-c')
      || (args.length === 2 && args[0] === '-lic'))
    && args.at(-1) === loginEnvironmentCommand;
  return nativeExecFileSync(file, loginProbe
    ? [...args.slice(0, -1), "printf '\\0'; printenv -0"] : args, options);
}
childProcess.execFileSync = execFileSync;
