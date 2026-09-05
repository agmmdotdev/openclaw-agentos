const assert = (condition, message) => { if (!condition) throw new Error(`ASSERTION: ${message}`); };
const completed = [];
const failures = [];
function answer(content, stopReason = 'stop') {
  const message = { role: 'assistant', content, api: 'openai-completions', provider: 'openai', model: 'gpt-4.1', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
  return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; yield { type: 'done', reason: stopReason, message }; }, result: async () => message };
}
const textAnswer = () => answer([{ type: 'text', text: 'Done.' }]);
async function scenario(name, overrides, verify) {
  const transcript = [], terminal = [];
  let error;
  try {
    await runOpenClawCoreTurn({
      agentId: 'failure-test', operationalRunInstance: { instanceId: name, runId: name }, agentRuntimeIdentityToken: 'test-only',
      cwd: '/workspace', workerContainmentRoot: '/workspace', stateDir: '/state', sessionId: name, sessionKey: `agent:failure-test:${name}`, runId: name,
      prompt: 'Exercise a controlled failure.', modelRef: { provider: 'openai', model: 'gpt-4.1' }, allowedToolNames: ['read', 'write', 'edit', 'exec', 'process', 'apply_patch'],
      inference: { stream: textAnswer }, transcript: { async commit(messages) { transcript.push(...messages); } },
      live: { enqueuePreview() { return true; }, async emitTerminal(event) { terminal.push(event); } },
      ...overrides,
    });
  } catch (caught) { error = caught; }
  try { verify({ error, transcript, terminal }); completed.push(name); }
  catch (error) { failures.push({ name, message: error.message }); }
}
const controller = new AbortController(); controller.abort(new Error('fixture-aborted'));
await scenario('pre-aborted', { signal: controller.signal, inference: { stream() { throw new Error('INFERENCE_MUST_NOT_RUN'); } } }, ({ error, terminal }) => {
  assert(error?.message === 'fixture-aborted', 'pre-aborted turn rejects with abort reason');
  assert(terminal.at(-1)?.payload.aborted === true, 'abort terminal flag');
});
await scenario('inference-error', { inference: { stream() { throw new Error('fixture-inference-error'); } } }, ({ error, terminal }) => {
  assert(error?.message.includes('fixture-inference-error'), 'inference errors propagate');
  assert(terminal.at(-1)?.payload.stopReason === 'error', 'inference failure terminal');
});
await scenario('transcript-error', { transcript: { async commit() { throw new Error('fixture-commit-error'); } } }, ({ error, terminal }) => {
  assert(error?.message.includes('fixture-commit-error'), 'transcript errors propagate');
  assert(terminal.length === 0, 'no success terminal before failed transcript commit');
});
let readonlyCalls = 0;
await scenario('read-only', { permissionMode: 'read-only', inference: { stream(request) {
  assert(!request.context.tools.some(t => ['write', 'edit', 'apply_patch'].includes(t.name)), 'read-only omits mutating file tools');
  if (readonlyCalls++ === 0) return answer([{ type: 'toolCall', id: 'forbidden-write', name: 'write', arguments: { path: '/workspace/forbidden.txt', content: 'should not exist' } }], 'toolUse');
  const result = request.context.messages.findLast(m => m.role === 'toolResult');
  assert(result?.isError === true, 'unauthorized tool call returns an error');
  return textAnswer();
} } }, ({ error }) => {
  assert(!error, `read-only turn: ${error?.message}`);
  assert(!fs.existsSync('/workspace/forbidden.txt'), 'read-only cannot mutate workspace');
});
let missingCalls = 0;
await scenario('missing-file', { inference: { stream(request) {
  if (missingCalls++ === 0) return answer([{ type: 'toolCall', id: 'missing-read', name: 'read', arguments: { path: '/workspace/missing.txt' } }], 'toolUse');
  const result = request.context.messages.findLast(m => m.role === 'toolResult');
  assert(result?.content.some(p => /ENOENT|no such file|not found/i.test(p.text ?? '')), 'filesystem failure returns to inference');
  return textAnswer();
} } }, ({ error, transcript }) => {
  assert(!error, `tool failure recovery: ${error?.message}`);
  assert(transcript.some(m => m.role === 'assistant' && m.stopReason === 'stop'), 'agent continues after tool failure');
});
for (const exitCode of [0, 7, 127]) {
  let backgroundCalls = 0, backgroundSession, observedOutput = '';
  const marker = `background-${exitCode}-ok`;
  await scenario(`background-process-${exitCode}`, { inference: { stream(request) {
    if (backgroundCalls++ === 0) return answer([{ type: 'toolCall', id: 'bg-start', name: 'exec', arguments: { command: `node -e "setTimeout(() => { console.log('${marker}'); process.exit(${exitCode}); }, 50)"`, background: true, workdir: '/workspace' } }], 'toolUse');
    const result = request.context.messages.findLast(m => m.role === 'toolResult');
    observedOutput += result?.content?.map(p => p.text ?? '').join('') ?? '';
    if (backgroundCalls === 2) {
      backgroundSession = result?.details?.sessionId;
      assert(typeof backgroundSession === 'string', `background exec returns a session: ${JSON.stringify(result)}`);
    } else if (['completed', 'failed'].includes(result?.details?.status)) {
      assert(result.details.status === (exitCode === 127 ? 'failed' : 'completed'), `background status: ${JSON.stringify(result)}`);
      assert(result.details.exitCode === exitCode, `background exit code is preserved: ${JSON.stringify(result)}`);
      assert(observedOutput.includes(marker), 'background stdout returned through process tool');
      return textAnswer();
    }
    assert(backgroundCalls < 8, `background process must settle: ${JSON.stringify(result)}`);
    return answer([{ type: 'toolCall', id: `bg-poll-${backgroundCalls}`, name: 'process', arguments: { action: 'poll', sessionId: backgroundSession, timeout: 1000 } }], 'toolUse');
  } } }, ({ error }) => { assert(!error, `background process: ${error?.message}`); });
}
console.log('FAILURE_CASES_RESULT=' + JSON.stringify({ completed, failures }));

if (failures.length) process.exitCode = 1;
