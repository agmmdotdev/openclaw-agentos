import hooks from 'node:async_hooks';
export * from 'node:async_hooks';
const instances = new Set();
const registry = new FinalizationRegistry(ref => instances.delete(ref));
export class AsyncLocalStorage extends hooks.AsyncLocalStorage {
  constructor(...args) {
    super(...args);
    const ref = new WeakRef(this);
    instances.add(ref);
    registry.register(this, ref);
  }
  static snapshot() {
    const stores = [...instances].map(ref => ref.deref()).filter(Boolean).map(storage => [storage, storage.getStore()]);
    return (fn, ...args) => {
      const run = index => index === stores.length ? fn(...args) : stores[index][0].run(stores[index][1], () => run(index + 1));
      return run(0);
    };
  }
  static bind(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected a function');
    const snapshot = this.snapshot();
    return function (...args) { return snapshot(() => Reflect.apply(fn, this, args)); };
  }
}
export default { ...hooks, AsyncLocalStorage };
