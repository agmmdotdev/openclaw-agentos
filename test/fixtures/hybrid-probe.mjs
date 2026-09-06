// Run outside timed trials. Exercise real OpenClaw file and shell tools.
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const tools = createCoreCodingTools({ codingRoot: process.env.BENCH_ROOT + '/workspace', includeBaseCodingTools: true, includeShellTools: true,
  execDefaults: { security: 'full', ask: 'off', allowBackground: true, scopeKey: 'hybrid-probe', sessionKey: 'agent:benchmark:main', commandHighlighting: false },
  processDefaults: { scopeKey: 'hybrid-probe' }, imageSanitization: {} });
async function call(name, params) {
  const tool = tools.find(t => t.name === name);
  assert(tool, `missing ${name}`);
  const result = await tool.execute(`probe-${name}`, params);
  assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return result;
}
await call('write', { path: '/workspace/check.txt', content: 'before\n' });
await call('edit', { path: '/workspace/check.txt', edits: [{ oldText: 'before', newText: 'after' }] });
assert((await call('read', { path: '/workspace/check.txt' })).content.some(c => c.text?.includes('after')), 'edit/read mismatch');
assert(!fs.existsSync(process.env.BENCH_ROOT + '/workspace/check.txt'), 'tool wrote to host');
let denied = false;
try { await hybrid.sandbox.fsBridge.readFile({ filePath: '/etc/passwd' }); } catch { denied = true; }
assert(denied, 'outside workspace accepted');
const result = await call('exec', { command: 'cat /workspace/check.txt; exit 7', workdir: '/workspace' });
assert(result.details.exitCode === 7 && result.content.some(c => c.text?.includes('after')), 'shell exit/output mismatch');
const timeout = await call('exec', { command: 'sleep 5', workdir: '/workspace', timeoutSeconds: 1 });
assert(timeout.details.timedOut === true, `timeout lost: ${JSON.stringify(timeout)}`);
console.log('HYBRID_PROBE=passed: write/edit/read, guest-only file, denied outside path, shell output/exit, timeout');
