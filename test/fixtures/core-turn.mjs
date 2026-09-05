// Appended inside a lexical function scope to the verified upstream worker.
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERTION: ${message}`); };
const phase = coreProbePhase;
fs.mkdirSync('/workspace', { recursive: true });
fs.mkdirSync('/state', { recursive: true });
const prior = fs.existsSync('/state/transcript.json') ? JSON.parse(fs.readFileSync('/state/transcript.json', 'utf8')) : [];
const transcript = [];
const events = [];
const order = [];
const observedResults = [];
const turnStarted = performance.now();
let calls = 0;
const plan = phase === 'resume' ? [
  { name: 'read', arguments: { path: '/workspace/note.txt' } },
  { name: 'exec', arguments: { command: 'cat /workspace/shell.txt', workdir: '/workspace' } },
] : [
  { name: 'write', arguments: { path: '/workspace/note.txt', content: 'hello agentos\n' } },
  { name: 'read', arguments: { path: '/workspace/note.txt' } },
  { name: 'edit', arguments: { path: '/workspace/note.txt', oldText: 'hello agentos', newText: 'hello openclaw' } },
  { name: 'exec', arguments: { command: "printf 'shell-ok\\n' > /workspace/shell.txt", workdir: '/workspace' } },
  { name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** Add File: /workspace/patched.txt\n+patch-ok\n*** End Patch' } },
];
const inference = { stream(request) {
  if (calls > 0) {
    const result = request.context.messages.findLast(m => m.role === 'toolResult');
    assert(result && !result.isError, `tool ${plan[calls - 1].name}: ${JSON.stringify(result)}`);
    assert(result.toolName === plan[calls - 1].name, 'tool result must return to the inference context');
    if (result.toolName === 'exec') {
      assert(result.details?.status === 'completed' && result.details.exitCode === 0, `foreground exec exit status: ${JSON.stringify(result)}`);
    }
    observedResults.push(result);
  }
  if (phase === 'resume' && calls === 0) {
    assert(prior.length > 2, 'restored transcript exists');
    assert(request.context.messages.some(m => m.role === 'assistant' && m.content.some(p => p.text === 'Tools completed.')), 'previous assistant response appears in resumed inference');
  }
  const tool = plan[calls++];
  const stopReason = tool ? 'toolUse' : 'stop';
  const message = {
    role: 'assistant', content: tool ? [{ type: 'toolCall', id: `call-${phase}-${calls}`, ...tool }] : [{ type: 'text', text: phase === 'resume' ? 'Resume completed.' : 'Tools completed.' }],
    api: 'openai-completions', provider: 'openai', model: 'gpt-4.1',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
  return { async *[Symbol.asyncIterator]() {
    yield { type: 'start', partial: { ...message, content: [] } };
    if (!tool) {
      yield { type: 'text_start', contentIndex: 0, partial: { ...message, content: [{ type: 'text', text: '' }] } };
      yield { type: 'text_delta', contentIndex: 0, delta: message.content[0].text, partial: message };
      yield { type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message };
    }
    yield { type: 'done', reason: stopReason, message };
  }, result: async () => message };
} };
try {
  const runId = `run-${phase}`;
  await runOpenClawCoreTurn({
    agentId: 'core-test', operationalRunInstance: { instanceId: `instance-${phase}`, runId },
    agentRuntimeIdentityToken: 'test-only', cwd: '/workspace', workerContainmentRoot: '/workspace', stateDir: '/state',
    sessionId: 'session-1', sessionKey: 'agent:core-test:main', runId, prompt: phase === 'resume' ? 'Continue from the previous turn.' : 'Exercise the workspace tools.',
    modelRef: { provider: 'openai', model: 'gpt-4.1' }, inference, initialMessages: prior,
    transcript: { async commit(messages) { transcript.push(...messages); order.push('commit'); fs.writeFileSync('/state/transcript.json', JSON.stringify([...prior, ...transcript])); } },
    live: { enqueuePreview(event) { events.push(event); return true; }, async emitTerminal(event) { events.push(event); order.push('terminal'); } },
    allowedToolNames: ['read', 'write', 'edit', 'apply_patch', 'exec', 'process'],
  });
  assert(calls === plan.length + 1, 'all tool cycles and final inference completed');
  assert(order.at(-1) === 'terminal', 'terminal event follows transcript settlement');
  assert(events.at(-1).payload.stopReason === 'stop', 'successful terminal event');
  assert(fs.readFileSync('/workspace/note.txt', 'utf8') === 'hello openclaw\n', 'write/edit persisted');
  assert(fs.readFileSync('/workspace/shell.txt', 'utf8') === 'shell-ok\n', 'exec wrote into guest filesystem');
  assert(fs.readFileSync('/workspace/patched.txt', 'utf8').trim() === 'patch-ok', 'apply_patch wrote into guest filesystem');
  console.log('CORE_RESULT=' + JSON.stringify({ phase, durationMs: Math.round(performance.now() - turnStarted), calls, tools: observedResults.map(r => r.toolName), transcriptMessages: transcript.length, priorMessages: prior.length, events: events.map(e => ({ kind: e.kind, phase: e.payload.phase })), order }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
