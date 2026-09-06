// Repeatable single-agent coding workload, with synthetic delayed inference.
// Appended to the same verified core and fixture on guest/native/hybrid paths.
async function runRepresentativeBenchmarks() {
  const workspace = '/workspace', state = '/state';
  const bridge = globalThis.__benchmarkWorkspaceBridge;
  const disk = {
    async mkdir(filePath) { if (bridge) await bridge.mkdirp({ filePath }); else fs.mkdirSync(filePath, { recursive: true }); },
    async write(filePath, data) { if (bridge) await bridge.writeFile({ filePath, data }); else fs.writeFileSync(filePath, data); },
    async read(filePath) { return bridge ? (await bridge.readFile({ filePath })).toString('utf8') : fs.readFileSync(filePath, 'utf8'); },
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sourceFiles = 48, sourceBytes = 16384, catalogBytes = 1048576;
  const responseDelayMs = 60, betweenTurnsMs = 100;
  mark('workload-stage:start');
  for (const name of ['src', 'data', 'reports', 'scripts']) await disk.mkdir(workspace + '/' + name);
  for (let i = 0; i < sourceFiles; i++) {
    const name = String(i).padStart(4, '0');
    await disk.write(workspace + '/src/module-' + name + '.txt', ('TASK module-' + name + '\n').padEnd(sourceBytes, 'source documentation and implementation notes\n'));
  }
  let catalog = '';
  for (let i = 0; i < catalogBytes / 128; i++) catalog += ('record-' + String(i).padStart(5, '0') + ' status=active ').padEnd(127, '.') + '\n';
  await disk.write(workspace + '/data/catalog.txt', catalog);
  catalog = '';
  const configTail = ('\n# Application configuration\n').padEnd(4096, '# configuration context\n');
  await disk.write(workspace + '/config.txt', 'version=0' + configTail);
  const searchScript = "const fs=require('node:fs');for(const name of fs.readdirSync('src').sort()){const lines=fs.readFileSync('src/'+name,'utf8').split('\\n');for(let i=0;i<lines.length;i++)if(lines[i].includes('TASK'))console.log(name+':'+(i+1)+':'+lines[i]);}\n";
  const checkScript = "const fs=require('node:fs');const turn=Number(process.argv[2]);if(!fs.readFileSync('config.txt','utf8').startsWith('version='+(turn+1)+'\\n'))throw Error('version mismatch');const report=fs.readFileSync('reports/turn-'+turn+'.md','utf8');if(report.length!==8192||!report.startsWith('Turn '+turn+' '))throw Error('report mismatch');const data=fs.readFileSync('data/catalog.txt');if(data.length!==1048576)throw Error('catalog size mismatch');process.stdout.write(data.subarray(0,16384));console.log('CHECK-PASSED');\n";
  await disk.write(workspace + '/scripts/search.cjs', searchScript);
  await disk.write(workspace + '/scripts/check.cjs', checkScript);
  mark('workload-stage:end', { sourceFiles, sourceBytes, catalogBytes, totalSeedBytes: sourceFiles * sourceBytes + catalogBytes + 9 + configTail.length + searchScript.length + checkScript.length });

  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = content => ({ role: 'assistant', content, api: 'openai-completions', provider: 'openai', model: 'gpt-4.1', usage, stopReason: 'stop', timestamp: Date.now() });
  let history = [];
  for (let i = 0; i < 12; i++) {
    history.push({ role: 'user', content: [{ type: 'text', text: ('Earlier requirement ' + i + ': retain compatibility and document the changes.\n').padEnd(4096, 'Project context and acceptance criteria. ') }], timestamp: Date.now() });
    history.push(assistant([{ type: 'text', text: ('Earlier discussion ' + i + ': implementation details and validation results.\n').padEnd(4096, 'Prior analysis and decisions. ') }]));
  }
  const initialHistoryBytes = Buffer.byteLength(JSON.stringify(history));
  const warmTurns = Number(process.env.BENCH_WARM_TURNS ?? 5);
  let previewEvents = 0, largestContextBytes = 0;
  const toolCounts = { read: 0, exec: 0, edit: 0, write: 0 };
  mark('representative:config', { sourceFiles, sourceBytes, catalogBytes, initialHistoryBytes, initialMessages: history.length, responseDelayMs, betweenTurnsMs, warmTurns });
  for (let turn = 0; turn <= warmTurns; turn++) {
    const label = turn === 0 ? 'cold-turn' : `warm-turn-${turn}`;
    mark(label + ':start');
    const started = performance.now(), transcript = [], terminals = [];
    const reportText = ('Turn ' + turn + ' implementation report\n').padEnd(8192, 'Verified application changes, tests, and compatibility.\n');
    const plan = [
      { name: 'read', arguments: { path: workspace + '/config.txt' } },
      { name: 'exec', arguments: { command: 'node scripts/search.cjs', workdir: workspace } },
      { name: 'edit', arguments: { path: workspace + '/config.txt', edits: [{ oldText: 'version=' + turn, newText: 'version=' + (turn + 1) }] } },
      { name: 'write', arguments: { path: workspace + '/reports/turn-' + turn + '.md', content: reportText } },
      { name: 'exec', arguments: { command: 'node scripts/check.cjs ' + turn, workdir: workspace } },
    ];
    let calls = 0, deltas = 0;
    await runOpenClawCoreTurn({
      agentId: 'representative', operationalRunInstance: { instanceId: 'representative-' + turn, runId: 'representative-' + turn },
      agentRuntimeIdentityToken: 'test-only', cwd: workspace, workerContainmentRoot: workspace, stateDir: state,
      sessionId: 'representative', sessionKey: 'agent:representative:main', runId: 'representative-' + turn,
      prompt: 'Review the application configuration, search the source tree, increment the version, write a report, inspect catalog records, and explain the result.',
      initialMessages: history, modelRef: { provider: 'openai', model: 'gpt-4.1' }, allowedToolNames: ['read', 'exec', 'edit', 'write'],
      inference: { stream(request) {
        largestContextBytes = Math.max(largestContextBytes, Buffer.byteLength(JSON.stringify(request.context.messages)));
        if (calls > 0) {
          const result = request.context.messages.findLast(m => m.role === 'toolResult');
          const previous = plan[calls - 1];
          check(result && !result.isError && result.toolName === previous.name, 'representative tool failed: ' + JSON.stringify(result));
          const text = result.content.map(c => c.text ?? '').join('\n');
          if (previous.name === 'exec') check(result.details?.status === 'completed' && result.details.exitCode === 0, 'representative exec did not complete: ' + JSON.stringify(result));
          if (calls === 1) check(text.includes('version=' + turn), 'config read mismatch');
          if (calls === 2) check(text.includes('module-0000') && text.includes('module-0047'), 'source search incomplete');
          if (calls === 5) check(text.includes('record-00000') && text.includes('record-00127') && text.includes('CHECK-PASSED'), 'catalog output incomplete');
          toolCounts[previous.name]++;
        }
        const tool = plan[calls++];
        const finalText = ('Completed version ' + (turn + 1) + '. Reviewed the sources, updated configuration, saved the report, and checked catalog entries.\n').padEnd(2048, 'Validation passed for this change. ');
        const message = assistant(tool ? [{ type: 'toolCall', id: `representative-${turn}-${calls}`, name: tool.name, arguments: tool.arguments }] : [{ type: 'text', text: '' }]);
        message.stopReason = tool ? 'toolUse' : 'stop';
        return { async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: message };
          await pause(responseDelayMs);
          if (!tool) {
            yield { type: 'text_start', contentIndex: 0, partial: message };
            for (let i = 0; i < finalText.length; i += 512) {
              const delta = finalText.slice(i, i + 512);
              message.content[0].text += delta; deltas++;
              yield { type: 'text_delta', contentIndex: 0, delta, partial: message };
              await pause(15);
            }
            yield { type: 'text_end', contentIndex: 0, content: finalText, partial: message };
          }
          yield { type: 'done', reason: message.stopReason, message };
        }, result: async () => message };
      } },
      transcript: { async commit(messages) {
        transcript.push(...messages);
        for (const message of messages) fs.appendFileSync(state + '/events.jsonl', JSON.stringify(message) + '\n');
      } },
      live: { enqueuePreview() { previewEvents++; return true; }, async emitTerminal(event) { terminals.push(event); } },
    });
    check(calls === 6 && transcript.length === 12 && deltas === 4 && terminals.at(-1)?.payload.stopReason === 'stop', 'incomplete representative turn');
    check(await disk.read(workspace + '/config.txt') === 'version=' + (turn + 1) + configTail, 'edit did not persist');
    check(await disk.read(workspace + '/reports/turn-' + turn + '.md') === reportText, 'report did not persist');
    history.push(...transcript);
    fs.writeFileSync(state + '/transcript.json', JSON.stringify(history));
    history = JSON.parse(fs.readFileSync(state + '/transcript.json', 'utf8'));
    mark(label + ':end', { durationMs: performance.now() - started, calls, transcriptMessages: history.length, transcriptBytes: Buffer.byteLength(JSON.stringify(history)), toolCalls: plan.length, streamedDeltas: deltas });
    if (turn < warmTurns) await pause(betweenTurnsMs);
  }
  check(history.length === 24 + (warmTurns + 1) * 12, 'history continuity failed');
  check(previewEvents > 0, 'no live preview events');
  mark('representative:complete', { turns: warmTurns + 1, toolCounts, transcriptMessages: history.length, transcriptBytes: Buffer.byteLength(JSON.stringify(history)), largestContextBytes, previewEvents });
}
