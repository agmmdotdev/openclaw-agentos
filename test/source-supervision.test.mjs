import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentOs } from '../packages/agentos-sdk/dist/native-entry.js';
const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const { createAgentOsToolRuntime } = await import(`../packages/openclaw-core/dist/${prefix}sdk-tool-runtime.mjs`);

async function fixture(t, delaySpawn) {
  const root = await mkdtemp(join(tmpdir(), 'source-supervisor-'));
  const vm = await AgentOs.create({ backend: 'native-node', security: 'trusted-only', workspaceDir: root });
  const sdk = delaySpawn ? { workspaceDir: vm.workspaceDir, capabilities: vm.capabilities,
    filesystem: vm.filesystem, process: { ...vm.process, async spawn(...args) {
      await delaySpawn(); return vm.process.spawn(...args);
    } } } : vm;
  const { supervisor } = createAgentOsToolRuntime(sdk);
  t.after(async () => { try { await supervisor.shutdown(); } finally { await vm.dispose(); await rm(root, { recursive: true, force: true }); } });
  const spawn = (command, options = {}) => supervisor.spawn({ mode: 'child', backendId: 'exec-sandbox',
    sessionId: 'supervisor-test', argv: ['native-sdk-shell', root, command], stdinMode: 'pipe-closed', ...options });
  return { supervisor, spawn, vm };
}

test('supervisor captures bounded output, raw bytes, full results and stdin EOF', { timeout: 5000 }, async t => {
  const { supervisor, spawn, vm } = await fixture(t);
  const raw = [], chunks = [];
  const run = await spawn('cat; printf err >&2; exit 7', { input: 'မြန်မာ 🐈',
    onStdout: chunk => chunks.push(chunk), onStdoutRaw: bytes => raw.push(bytes) });
  const exit = await run.wait();
  assert.equal(exit.stdout, 'မြန်မာ 🐈');
  assert.equal(Buffer.concat(raw).toString(), exit.stdout);
  assert.equal(chunks.join(''), exit.stdout);
  assert.equal(exit.stderr, 'err');
  assert.equal(exit.exitCode, 7);
  assert.equal(exit.exitSignal, null);
  assert.equal(exit.reason, 'exit');
  assert.ok(Number.isFinite(exit.durationMs));
  assert.ok(run.runId && Number.isFinite(run.startedAtMs));
  assert.equal(run.pid, (await vm.process.list())[0].hostPid);
  assert.equal(supervisor.getRecord(run.runId).state, 'exited');
  run.cancel('overall-timeout');
  assert.deepEqual(await run.wait(), exit, 'late cancellation cannot rewrite a completed result');
  assert.equal(run.stdin.writable, false);
  const closed = await spawn('cat');
  assert.equal((await closed.wait()).stdout, '');
  const capped = await spawn("printf '%01000d' 1", { maxCapturedOutputChars: 256 });
  const capture = (await capped.wait()).stdout;
  assert.ok(capture.length <= 256);
  assert.match(capture, /truncated/);
  let streamed = '';
  const streamOnly = await spawn('printf streamed', { captureOutput: false, onStdout: s => { streamed += s; } });
  assert.equal((await streamOnly.wait()).stdout, '');
  assert.equal(streamed, 'streamed');
});

test('no-output deadlines reset on real output and classify the quiet interval', { timeout: 5000 }, async t => {
  const { spawn } = await fixture(t);
  const run = await spawn('for i in 1 2 3 4 5; do printf .; sleep 0.05; done; sleep 10', { noOutputTimeoutMs: 200 });
  const exit = await run.wait();
  assert.equal(exit.stdout, '.....');
  assert.equal(exit.reason, 'no-output-timeout');
  assert.equal(exit.timedOut, true);
  assert.equal(exit.noOutputTimedOut, true);
});

test('scope cancellation, record snapshots and duplicate identity share one owner', { timeout: 5000 }, async t => {
  const { spawn, supervisor } = await fixture(t);
  const a = await spawn('sleep 10', { scopeKey: 'a', runId: 'same' });
  const b = await spawn('sleep 10', { scopeKey: 'b' });
  await assert.rejects(spawn('printf must-not-run', { runId: 'same' }), /already active/);
  const record = supervisor.getRecord(a.runId); record.state = 'corrupted';
  assert.equal(supervisor.getRecord(a.runId).state, 'running');
  supervisor.cancelScope('a'); await supervisor.waitForScope('a');
  assert.equal((await a.wait()).reason, 'manual-cancel');
  assert.equal(supervisor.getRecord(b.runId).state, 'running');
  supervisor.cancel(b.runId); await supervisor.waitForScope('b');
  assert.equal((await b.wait()).reason, 'manual-cancel');
});

test('cancelled replacement fences preserve later runs during delayed SDK admission', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let starts = 0;
  const { spawn, supervisor } = await fixture(t, async () => { if (++starts === 1) { entered.resolve(); await gate.promise; } });
  const first = spawn('sleep 10', { runId: 'first', scopeKey: 'scope' });
  await entered.promise;
  const replacement = spawn('printf must-not-run', { runId: 'replacement', scopeKey: 'scope', replaceExistingScope: true });
  const later = spawn('sleep 10', { runId: 'later', scopeKey: 'scope' });
  supervisor.cancel('replacement'); gate.resolve();
  const [a, b, c] = await Promise.all([first, replacement, later]);
  assert.equal((await b.wait()).reason, 'manual-cancel');
  assert.equal(starts, 2);
  assert.equal(supervisor.getRecord(a.runId).state, 'running');
  assert.equal(supervisor.getRecord(c.runId).state, 'running');
  supervisor.cancelScope('scope'); await supervisor.waitForScope('scope');
});

test('shutdown waits for admitted SDK startup and rejects new work', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const { spawn, supervisor } = await fixture(t, async () => { entered.resolve(); await gate.promise; });
  const pending = spawn('sleep 10', { runId: 'pending' });
  await entered.promise;
  const shutdown = supervisor.shutdown();
  await assert.rejects(spawn('printf must-not-run'), /shut down/);
  gate.resolve(); const run = await pending;
  await shutdown;
  assert.equal((await run.wait()).reason, 'manual-cancel');
  assert.equal(supervisor.getRecord('pending').state, 'exited');
  await supervisor.shutdown();
});

test('output detachment stops delivery while capture and process completion continue', { timeout: 5000 }, async t => {
  const { spawn } = await fixture(t);
  const ready = Promise.withResolvers();
  let delivered = '', raw = '';
  const run = await spawn('printf ready; read line; printf after', { stdinMode: 'pipe-open',
    onStdout: chunk => { delivered += chunk; if (delivered.includes('ready')) ready.resolve(); },
    onStdoutRaw: bytes => { raw += bytes.toString(); } });
  await ready.promise; run.detachOutput();
  await new Promise((resolve, reject) => run.stdin.write('go\n', error => error ? reject(error) : resolve()));
  assert.equal((await run.wait()).stdout, 'readyafter');
  assert.equal(delivered, 'ready');
  assert.equal(raw, 'ready');
});

test('graceful cancellation escalates when the SDK command ignores SIGTERM', { timeout: 10000 }, async t => {
  const { spawn } = await fixture(t);
  const ready = Promise.withResolvers();
  const run = await spawn("trap '' TERM; printf ready; while :; do sleep 1; done", {
    onStdout: chunk => { if (chunk.includes('ready')) ready.resolve(); },
  });
  await ready.promise; run.cancel();
  const exit = await run.wait();
  assert.equal(exit.reason, 'manual-cancel');
  assert.equal(exit.exitSignal, 'SIGKILL');
});

test('SDK output failures stay failures and rejected modes never launch a child', { timeout: 5000 }, async t => {
  const { spawn, vm, supervisor } = await fixture(t);
  const before = (await vm.process.list()).length;
  for (const options of [{ stdinMode: 'inherit' }, { exactEnv: true }, { secretInput: { fd: 3 } }]) {
    await assert.rejects(spawn('printf must-not-run', options), /Unsupported SDK process options/);
  }
  assert.equal((await vm.process.list()).length, before);
  const run = await spawn("head -c 1100000 /dev/zero", { captureOutput: false });
  await assert.rejects(run.wait(), { code: 'OUTPUT_LIMIT' });
  assert.equal(supervisor.getRecord(run.runId).terminationReason, 'spawn-error');
});

test('throwing output callbacks and rejected initial stdin settle with their actual errors', { timeout: 5000 }, async t => {
  const { spawn, supervisor } = await fixture(t);
  for (const channel of ['onStdout', 'onStdoutRaw', 'onStderr']) {
    const error = new Error(`${channel} exploded`);
    const run = await spawn('printf early; printf error >&2', { [channel]: () => { throw error; } });
    await assert.rejects(run.wait(), actual => actual === error);
    assert.equal(supervisor.getRecord(run.runId).terminationReason, 'spawn-error');
  }
  const input = await spawn('cat', { input: 'x'.repeat(1048577) });
  await assert.rejects(input.wait(), { code: 'STDIN_LIMIT' });
  assert.equal(supervisor.getRecord(input.runId).terminationReason, 'spawn-error');
});

test('interactive stdin errors do not kill a command that intentionally closes input', { timeout: 5000 }, async t => {
  const { spawn } = await fixture(t);
  const ready = Promise.withResolvers();
  const run = await spawn('exec 0<&-; printf ready; sleep 0.1; printf survived', {
    stdinMode: 'pipe-open', onStdout: chunk => { if (chunk.includes('ready')) ready.resolve(); },
  });
  await ready.promise;
  await assert.rejects(new Promise((resolve, reject) => run.stdin.write('late', error => error ? reject(error) : resolve())),
    error => ['EPIPE', 'STDIN_CLOSED'].includes(error.code));
  const exit = await run.wait();
  assert.equal(exit.reason, 'exit');
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.stdout, 'readysurvived');
});
