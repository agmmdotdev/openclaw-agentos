// Opt-in diagnostics. Keep disabled for performance comparisons.
import { getHeapStatistics, getHeapSpaceStatistics, getHeapCodeStatistics } from 'node:v8';
export function nativeMemoryCheckpoint(label) {
  if (!['worker-ready', 'cold-turn:end', 'warm-turn-50:end', 'idle:start', 'idle:end'].includes(label)) return {};
  let collection;
  if (label === 'idle:start' && process.env.BENCH_GC_AT_IDLE === '1') {
    if (typeof globalThis.gc !== 'function') throw new Error('Idle GC diagnostic requires --expose-gc');
    const before = process.memoryUsage(), start = performance.now();
    globalThis.gc();
    collection = { before, durationMs: performance.now() - start };
  }
  return { nativeMemory: { usage: process.memoryUsage(), heap: getHeapStatistics(),
    spaces: getHeapSpaceStatistics(), code: getHeapCodeStatistics(), collection } };
}
