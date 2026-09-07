// Diagnostic only: include collected objects to observe startup allocation churn.
// Never load this preload in uninstrumented performance comparisons.
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import './startup-preload.mjs';

const output = process.env.STARTUP_ALLOCATION_OUTPUT;
if (!output) throw new Error('STARTUP_ALLOCATION_OUTPUT is required');
const session = new Session();
session.connect();
// An in-process Session delivers these heap commands synchronously. Fail closed
// if that changes, rather than writing a partial or late startup profile.
function post(method, params = {}) {
  let done = false, error, value;
  session.post(method, params, (err, result) => { done = true; error = err; value = result; });
  if (!done) throw new Error('Heap profiler command became asynchronous: ' + method);
  if (error) throw error;
  return value;
}
const options = { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
post('HeapProfiler.startSampling', options);
const mark = globalThis.__nativeStartupMark;
let stopped = false;
globalThis.__nativeStartupMark = (phase, extra) => {
  mark(phase, extra);
  if (phase !== 'worker-ready') return;
  const { profile } = post('HeapProfiler.stopSampling');
  stopped = true;
  session.disconnect();
  const raw = JSON.stringify({ node: process.version, options, endPhase: phase, profile });
  writeFileSync(output, gzipSync(raw), { flag: 'wx' });
  console.log('STARTUP_ALLOCATIONS=' + JSON.stringify({ output, sha256: createHash('sha256').update(raw).digest('hex') }));
};
process.once('beforeExit', () => {
  if (!stopped) throw new Error('Startup allocation profiling never reached worker-ready');
});
