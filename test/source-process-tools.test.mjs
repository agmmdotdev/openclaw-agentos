import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentOs } from '../packages/agentos-sdk/dist/native-entry.js';

const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

test('real core process tools continue SDK commands, isolate scopes, cancel, and report deadlines', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-process-tools-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = join(root, 'state');
  let vm, runtime;
  t.after(async () => {
    try { await runtime?.supervisor.shutdown(); } finally {
      await vm?.dispose();
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(join(root, 'workspace'));
  await mkdir(join(root, 'state'));
  vm = await AgentOs.create({ backend: 'native-node', security: 'trusted-only', workspaceDir: join(root, 'workspace') });
  const { createAgentOsToolRuntime } = await import(`../packages/openclaw-core/dist/${prefix}sdk-tool-runtime.mjs`);
  const { createCoreCodingTools, withProcessSupervisor, getProcessSupervisor, acknowledgeInternalToolResult } = await import(`../packages/openclaw-core/dist/${prefix}diagnostics.mjs`);
  runtime = createAgentOsToolRuntime(vm);

  await withProcessSupervisor(runtime.supervisor, async () => {
    const makeTools = scopeKey => createCoreCodingTools({
      codingRoot: vm.workspaceDir, containmentRoot: vm.workspaceDir,
      includeBaseCodingTools: false, includeShellTools: true,
      workspaceOnly: true, readOnly: false, applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true, sandbox: runtime.sandbox,
      execDefaults: { security: 'full', ask: 'off', allowBackground: true, scopeKey, notifyOnExit: false, commandHighlighting: false },
      processDefaults: { scopeKey },
    });
    const ownTools = makeTools('process-tools-owner');
    const otherTools = makeTools('process-tools-other');
    let calls = 0;
    const call = async (name, args, tools = ownTools) => {
      const result = await tools.find(tool => tool.name === name).execute(`process-proof-${++calls}`, args);
      acknowledgeInternalToolResult(result);
      return result;
    };
    const finish = async sessionId => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await call('process', { action: 'poll', sessionId, timeout: 1000 });
        if (result.details.status !== 'running') return result;
      }
      assert.fail(`Process ${sessionId} did not settle`);
    };

    let creatorScope;
    const started = await withProcessSupervisor(runtime.supervisor, async () => {
      creatorScope = getProcessSupervisor();
      return call('exec', { command: "cat; printf '\\nfinished\\n'", background: true });
    });
    assert.throws(() => creatorScope.getRecord('stale'), /runtime is closed/);

    assert.equal(started.details.status, 'running', text(started));
    const sessionId = started.details.sessionId;
    assert.ok(runtime.supervisor.getRecord(sessionId), 'exec must register its actual supervisor cancellation handle');
    const listing = await call('process', { action: 'list' });
    assert.ok(listing.details.sessions.some(session => session.sessionId === sessionId && session.stdinWritable));
    assert.deepEqual((await call('process', { action: 'list' }, otherTools)).details.sessions, []);
    for (const action of ['poll', 'write', 'kill']) {
      const denied = await call('process', { action, sessionId, data: 'wrong scope' }, otherTools);
      assert.equal(denied.details.status, 'failed', text(denied));
      assert.match(text(denied), /No (?:active )?session found/);
    }
    const input = 'မြန်မာ 🐈';
    assert.equal((await call('process', { action: 'write', sessionId, data: input })).details.status, 'running');
    assert.equal((await call('process', { action: 'send-keys', sessionId, literal: ' keys\n' })).details.status, 'running');
    assert.equal((await call('process', { action: 'write', sessionId, data: '', eof: true })).details.status, 'running');
    const completed = await finish(sessionId);
    assert.equal(completed.details.status, 'completed', text(completed));
    assert.equal(completed.details.exitCode, 0);
    assert.equal(completed.details.exitReason, 'exit');
    assert.equal(completed.details.aggregated, `${input} keys\n\nfinished\n`);
    assert.match(text(await call('process', { action: 'log', sessionId })), /finished/);
    assert.equal((await call('process', { action: 'clear', sessionId })).details.status, 'completed');

    const sleeping = await call('exec', { command: 'sleep 10', background: true });
    assert.equal(sleeping.details.status, 'running', text(sleeping));
    const killed = await call('process', { action: 'kill', sessionId: sleeping.details.sessionId });
    assert.equal(killed.details.status, 'completed', text(killed));
    assert.match(text(killed), /Termination requested/);
    const cancelled = await finish(sleeping.details.sessionId);
    assert.equal(cancelled.details.status, 'failed');
    assert.equal(cancelled.details.exitReason, 'manual-cancel');
    assert.equal(cancelled.details.timedOut, false);
    await call('process', { action: 'clear', sessionId: sleeping.details.sessionId });

    const timedOut = await call('exec', { command: 'sleep 10', timeoutSeconds: 1 });
    assert.equal(timedOut.details.status, 'failed', text(timedOut));
    assert.equal(timedOut.details.exitReason, 'overall-timeout');
    assert.equal(timedOut.details.timedOut, true);
    assert.match(text(timedOut), /tim(?:e|ed) ?out|timeout/i);
    assert.deepEqual((await call('process', { action: 'list' })).details.sessions, []);
    t.diagnostic(`${calls} actual OpenClaw exec/process tool calls through the native SDK`);
  });
});
