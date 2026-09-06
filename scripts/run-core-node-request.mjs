// Opt-in, version-pinned profile for trusted request workers. Liftoff keeps
// WebAssembly execution native while avoiding its optimizing compiler's large
// transient allocations. This internal V8 flag must be revalidated on upgrades.
const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: node scripts/run-core-node-request.mjs [node options] entry.mjs [arguments]');
if (process.version !== 'v24.19.0' || process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The request profile requires revalidation outside Node 24.19.0 / Linux x64');
}
if (typeof process.execve !== 'function') throw new Error('The request profile requires process.execve');
process.execve(process.execPath, [process.execPath, '--max-semi-space-size=8', '--liftoff-only', ...args], {
  ...process.env, MALLOC_ARENA_MAX: '1', MALLOC_TRIM_THRESHOLD_: '65536', MALLOC_MMAP_THRESHOLD_: '65536',
});
