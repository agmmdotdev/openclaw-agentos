import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentOs } from '../packages/agentos-sdk/dist/native-entry.js';
const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

for (const filesystemBackend of ['node', 'linux-openat2']) {
  test(`real core filesystem tools add, edit, move and delete through ${filesystemBackend}`, { timeout: 15000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'source-filesystem-tools-'));
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = join(root, 'state');
    await mkdir(join(root, 'workspace')); await mkdir(join(root, 'state'));
    let vm, runtime;
    t.after(async () => {
      try { await runtime?.supervisor.shutdown(); } finally {
        await vm?.dispose();
        if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
        else process.env.OPENCLAW_STATE_DIR = previous;
        await rm(root, { recursive: true, force: true });
      }
    });
    vm = await AgentOs.create({ backend: 'native-node', security: 'trusted-only', workspaceDir: join(root, 'workspace'), filesystemBackend });
    const { createAgentOsToolRuntime } = await import(`../packages/openclaw-core/dist/${prefix}sdk-tool-runtime.mjs`);
    const { createCoreCodingTools, acknowledgeInternalToolResult } = await import(`../packages/openclaw-core/dist/${prefix}diagnostics.mjs`);
    runtime = createAgentOsToolRuntime(vm);
    const tools = createCoreCodingTools({
      codingRoot: vm.workspaceDir, containmentRoot: vm.workspaceDir,
      includeBaseCodingTools: true, includeShellTools: true,
      workspaceOnly: true, readOnly: false, applyPatchEnabled: true,
      applyPatchWorkspaceOnly: true, sandbox: runtime.sandbox,
      execDefaults: { security: 'full', ask: 'off', commandHighlighting: false },
    });
    let calls = 0;
    const call = async (name, args) => {
      calls++;
      const result = await tools.find(tool => tool.name === name).execute(`filesystem-proof-${calls}`, args);
      acknowledgeInternalToolResult(result);
      assert.ok(!result.isError, text(result));
      return result;
    };
    await call('write', { path: 'nested/input.txt', content: 'မြန်မာ 🐈\nold\n' });
    assert.equal(await readFile(join(vm.workspaceDir, 'nested/input.txt'), 'utf8'), 'မြန်မာ 🐈\nold\n');
    assert.match(text(await call('read', { path: 'nested/input.txt' })), /မြန်မာ 🐈/);
    await call('edit', { path: 'nested/input.txt', edits: [{ oldText: 'old', newText: 'edited' }] });
    assert.equal(await readFile(join(vm.workspaceDir, 'nested/input.txt'), 'utf8'), 'မြန်မာ 🐈\nedited\n');
    await call('apply_patch', { input: '*** Begin Patch\n*** Add File: patch/new.txt\n+created\n*** End Patch' });
    assert.equal(await readFile(join(vm.workspaceDir, 'patch/new.txt'), 'utf8'), 'created\n');
    await assert.rejects(call('apply_patch', { input: '*** Begin Patch\n*** Add File: patch/new.txt\n+overwrite\n*** End Patch' }), /already exists/);
    assert.equal(await readFile(join(vm.workspaceDir, 'patch/new.txt'), 'utf8'), 'created\n');
    await call('apply_patch', { input: '*** Begin Patch\n*** Update File: patch/new.txt\n*** Move to: moved/final.txt\n@@\n-created\n+moved\n*** End Patch' });
    await assert.rejects(stat(join(vm.workspaceDir, 'patch/new.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(vm.workspaceDir, 'moved/final.txt'), 'utf8'), 'moved\n');
    await call('apply_patch', { input: '*** Begin Patch\n*** Delete File: moved/final.txt\n*** End Patch' });
    await assert.rejects(stat(join(vm.workspaceDir, 'moved/final.txt')), { code: 'ENOENT' });
    await assert.rejects(call('write', { path: '../outside.txt', content: 'escape' }));
    await assert.rejects(stat(join(root, 'outside.txt')), { code: 'ENOENT' });
    t.diagnostic(`${calls} actual OpenClaw filesystem tool calls through ${filesystemBackend}`);
  });
}
