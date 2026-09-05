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
