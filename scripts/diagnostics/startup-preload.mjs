// Diagnostic only. Loaded before the entry module, without changing its loader.
import { PerformanceObserver } from 'node:perf_hooks';
const gc = [];
const observer = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) gc.push({ startMs: entry.startTime, durationMs: entry.duration, ...entry.detail });
});
observer.observe({ entryTypes: ['gc'] });
globalThis.__nativeStartupMark = (phase, extra = {}) => console.log('STARTUP_EVENT=' + JSON.stringify({
  phase, uptimeMs: performance.now(), monotonicUs: Number(process.hrtime.bigint() / 1000n), cpu: process.cpuUsage(), memory: process.memoryUsage(), ...extra,
}));
globalThis.__nativeStartupMark('preload');
process.once('beforeExit', () => {
  observer.disconnect();
  globalThis.__nativeStartupMark('before-exit', { gc });
});
