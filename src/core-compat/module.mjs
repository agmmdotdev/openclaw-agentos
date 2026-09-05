import module from 'node:module';
import * as sqlite from './sqlite.mjs';
import hooks from './async-hooks.mjs';
import './child-process.mjs';
export * from 'node:module';
export default module;
export function createRequire(url) {
  const original = module.createRequire(url);
  const require = (name) => name === 'node:sqlite' ? sqlite : ['async_hooks', 'node:async_hooks'].includes(name) ? hooks : original(name);
  return Object.assign(require, original);
}
// Optimization only: agentOS has no Node on-disk compile cache to flush.
export function flushCompileCache() {}
