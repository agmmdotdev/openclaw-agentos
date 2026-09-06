import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLinuxExperiment } from '../dist/linux-experimental-entry.js';
const source = fileURLToPath(new URL('../native/supervisor.c', import.meta.url));
const production = fileURLToPath(new URL('../dist/linux-supervisor-experimental', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentos-supervisor-test-'));
  const binary = join(directory, 'test-supervisor');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = spawnSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-DAGENTOS_SUPERVISOR_TEST', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  function run(script) {
    const child = spawn(binary, [directory, '--', process.execPath, '-e', script], { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', status = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
    child.stdio[3].on('data', b => { status += b; });
    child.stdio[4].on('error', e => { assert.ok(['ECONNRESET', 'EPIPE'].includes(e.code)); });
    const timer = setTimeout(() => child.stdio[4].end('K'), 5000);
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, errors, status }); }); });
    child.stdin.end();
    return { child, done };
  }
  return { run, directory, binary };
}
test('production supervisor rejects ordinary directories before running a payload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentos-supervisor-denied-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'marker');
  const p = spawnSync(production, [directory, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { env: {}, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  assert.equal(p.status, 125); await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
test('supervisor loop preserves stdout and root exit and reaps adopted children (test process-group controls)', async t => {
  const { run } = await fixture(t);
  const { done } = run(`
    const {spawn}=require('child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    child.on('spawn',()=>{console.log('root-ok');child.unref();process.exitCode=7});
  `);
  const result = await done;
  assert.equal(result.code, 7, result.errors); assert.match(result.output, /root-ok/);
  const cleanup = result.status.trim().split('\n').map(JSON.parse).find(x => x.event === 'cleanup-complete');
  assert.equal(cleanup.reaped, 2); assert.equal(cleanup.populated, 0);
});
test('supervisor loop detects explicit cancellation and manager pipe EOF (test process-group controls)', async t => {
  const { run } = await fixture(t);
  for (const input of ['K', undefined]) {
    const { child, done } = run('setInterval(()=>{},1000)');
    child.stdio[4].end(input);
    const result = await done;
    assert.equal(result.code, 137, result.errors); assert.match(result.status, /cleanup-complete/);
  }
});
test('supervisor survives an actual manager SIGKILL and reaps its job (test process-group controls)', async t => {
  const { directory, binary } = await fixture(t);
  // The outer test owns output/status pipes, so it can observe the orphaned
  // supervisor after the synthetic manager dies. Only the manager owns fd 4's peer.
  const managerScript = `
    const {spawn}=require('child_process');
    const p=spawn(${JSON.stringify(binary)},[${JSON.stringify(directory)},'--',process.execPath,'-e',
      'console.log("job-live");setInterval(()=>{},1000)'],{env:{},stdio:['pipe',1,2,3,'pipe']});
    p.stdin.end();p.stdio[4].on('error',()=>{});setInterval(()=>{},1000);
  `;
  const manager = spawn(process.execPath, ['-e', managerScript], { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let output = '', status = '';
  const ready = new Promise((resolve, reject) => {
    manager.once('error', reject);
    manager.stdout.on('data', b => { output += b; if (output.includes('job-live')) resolve(); });
  });
  manager.stdio[3].on('data', b => { status += b; }); manager.stderr.resume();
  const done = new Promise(resolve => manager.once('close', resolve));
  const timer = setTimeout(() => manager.kill('SIGKILL'), 5000);
  await ready; manager.kill('SIGKILL'); await done; clearTimeout(timer);
  assert.match(status, /cleanup-complete/); assert.match(status, /manager-cancel-or-disconnect/);
});
test('experimental SDK rejects absent acknowledgement and unavailable enforcement before opening a workspace', async () => {
  await assert.rejects(createLinuxExperiment({ workspaceDir: '/not-created' }), { code: 'EXPERIMENTAL_ACKNOWLEDGEMENT_REQUIRED' });
  // Use invalid cgroup/manifest even on a capable host: it must never become a
  // trusted-only success when any prerequisite is missing.
  await assert.rejects(createLinuxExperiment({ acknowledgement: 'unverified-test-only', workspaceDir: '/not-created', cgroupDir: '/not-cgroup', runtimeManifest: '/missing' }));
});
