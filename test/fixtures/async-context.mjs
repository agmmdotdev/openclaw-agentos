import { AsyncLocalStorage, AsyncResource } from './compat/async-hooks.mjs';
const observations = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const delays of [[5], [5, 20], [20, 5]]) {
  const storage = new AsyncLocalStorage();
  const tasks = delays.map((ms, i) => storage.run('context-' + i, async () => {
    await delay(ms);
    return storage.getStore();
  }));
  const immediate = storage.getStore();
  observations.push({ test: 'overlap', delays, immediate, results: await Promise.all(tasks), after: storage.getStore() });
}
const a = new AsyncLocalStorage(), b = new AsyncLocalStorage();
observations.push({ test: 'nested', result: await a.run('outer', async () => {
  const inner = await a.run('inner', async () => { await delay(1); return a.getStore(); });
  const restored = a.getStore();
  return [inner, restored, await b.run('second-store', async () => { await Promise.resolve(); return [a.getStore(), b.getStore()]; })];
}), after: a.getStore() });
observations.push({ test: 'rejection', results: await Promise.all(['left', 'right'].map(label => a.run(label, async () => {
  const trace = [];
  try { await delay(1); throw new Error(label); }
  catch (error) { trace.push(error.message, a.getStore()); }
  finally { await delay(1); trace.push(a.getStore()); }
  return trace;
}))), after: a.getStore() });
observations.push({ test: 'callbacks', results: await Promise.all(['left', 'right'].map(label => a.run(label, () => Promise.all([
  new Promise(resolve => setTimeout(() => resolve(a.getStore()), 1)),
  new Promise(resolve => queueMicrotask(() => resolve(a.getStore()))),
  Promise.resolve().then(() => a.getStore()),
  Promise.reject(new Error('expected')).catch(() => a.getStore()),
])))), after: a.getStore() });
observations.push({ test: 'async-then-callback', results: await Promise.all(['left', 'right'].map(label => a.run(label, () =>
  Promise.resolve().then(async () => { await delay(label === 'left' ? 5 : 1); return a.getStore(); }).then(value => [value, a.getStore()])
))), after: a.getStore() });
async function* values() { yield a.getStore(); await delay(1); yield a.getStore(); }
observations.push({ test: 'async-generator', results: await Promise.all(['left', 'right'].map(label => a.run(label, async () => {
  const result = []; for await (const value of values()) result.push(value); return result;
}))), after: a.getStore() });
let bound, snapshot, resource;
if (typeof AsyncLocalStorage.snapshot === 'function' && Object.hasOwn(AsyncLocalStorage, 'bind')) {
a.run('captured', () => b.run('other', () => {
  bound = AsyncLocalStorage.bind(function (arg) { return [a.getStore(), b.getStore(), this.id, arg]; });
  snapshot = AsyncLocalStorage.snapshot();
  resource = new AsyncResource('fixture');
}));
observations.push({ test: 'capture', bound: bound.call({ id: 7 }, 8), snapshot: snapshot(() => [a.getStore(), b.getStore()]), resource: resource.runInAsyncScope(() => [a.getStore(), b.getStore()]), after: a.getStore() });
} else {
  observations.push({ test: 'capture', unsupported: 'static bind/snapshot' });
}
const promise = Promise.resolve('same-object');
observations.push({ test: 'promise-identity', same: a.run('identity', () => promise) === promise, after: a.getStore() });
let thrown;
try { a.run('throwing', () => { throw new Error('expected'); }); } catch (error) { thrown = error.message; }
observations.push({ test: 'throw-cleanup', thrown, after: a.getStore() });
let complete;
const externallyResolved = a.run('waiter', async () => { await new Promise(resolve => { complete = resolve; }); return a.getStore(); });
a.run('resolver', () => complete());
observations.push({ test: 'external-resolution', result: await externallyResolved, after: a.getStore() });
observations.push({ test: 'exit', result: await a.run('outer', async () => {
  const inside = await a.exit(async () => { await delay(1); return a.getStore() ?? null; });
  return [inside, a.getStore()];
}), after: a.getStore() });
console.log('ASYNC_CONTEXT_RESULT=' + JSON.stringify(observations));
