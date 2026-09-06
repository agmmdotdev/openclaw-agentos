// Actual SDK -> supervisor -> launcher -> Node acceptance, never a mock backend.
import { createLinuxExperiment } from '../../packages/agentos-sdk/dist/linux-experimental-entry.js';
import { inspectLinuxCapabilities } from '../../packages/agentos-sdk/dist/preflight.js';
import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const pause = ms => new Promise(ok => setTimeout(ok, ms));
const root = fileURLToPath(new URL('../../', import.meta.url));
const report = { date: new Date().toISOString(), kind: 'experimental-linux-sdk-host', status: 'blocked',
  sandboxEnforcementVerified: false, host: await inspectLinuxCapabilities(), blockers: [], tests: [] };
if (!(report.host.landlock?.landlockAbi >= 6)) report.blockers.push('Usable Landlock ABI >=6 is required');
if (!process.env.AGENTOS_TEST_CGROUP) report.blockers.push('AGENTOS_TEST_CGROUP delegation is required');
if (!process.env.AGENTOS_RUNTIME_MANIFEST) report.blockers.push('AGENTOS_RUNTIME_MANIFEST is required');
async function execute() {
  const workspace = await mkdtemp(join(tmpdir(), 'agentos-sdk-host-'));
  const options = { acknowledgement: 'unverified-test-only', workspaceDir: workspace,
    cgroupDir: process.env.AGENTOS_TEST_CGROUP, runtimeManifest: process.env.AGENTOS_RUNTIME_MANIFEST };
  let vm;
  try {
    vm = await createLinuxExperiment(options);
    const check = async (name, fn) => {
      try { await fn(); report.tests.push({ name, status: 'pass' }); }
      catch (e) { report.tests.push({ name, status: 'fail', error: e.message }); throw e; }
    };
    await check('filesystem and native Node cwd/streams', async () => {
      await vm.filesystem.mkdir('nested'); await vm.filesystem.writeFile('nested/file', 'hello 🐈');
      const result = await vm.javascript.execute("import fs from 'node:fs';console.log(fs.readFileSync('file','utf8'));console.error('stderr');process.exitCode=7",
        { cwd: 'nested', output: { capture: 'all' }, timeoutMs: 8000 });
      assert.equal(result.exitCode, 7, JSON.stringify(result)); assert.equal(result.stdout.trim(), 'hello 🐈'); assert.equal(result.stderr.trim(), 'stderr');
      await vm.filesystem.move('nested/file', 'moved'); await vm.filesystem.remove('nested');
    });
    await check('shell runtime closure', async () => {
      const result = await vm.process.exec('cat moved; exit 7', { output: { capture: 'all' }, timeoutMs: 8000 });
      assert.equal(result.exitCode, 7, JSON.stringify(result)); assert.equal(result.stdout, 'hello 🐈');
    });
    await check('stdin EOF', async () => {
      const result = await vm.javascript.execute("process.stdin.pipe(process.stdout)", { stdin: 'stdin 🐈', output: { capture: 'all' }, timeoutMs: 8000 });
      assert.equal(result.outcome, 'succeeded', JSON.stringify(result)); assert.equal(result.stdout, 'stdin 🐈');
    });
    await check('timeout, cancellation, detached child and empty cgroup cleanup', async () => {
      const timeout = await vm.javascript.execute('while(true){}', { timeoutMs: 1500 });
      assert.equal(timeout.outcome, 'timed_out', JSON.stringify(timeout));
      const child = await vm.javascript.spawn("import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});c.on('spawn',()=>console.log('spawned'));setInterval(()=>{},1000)");
      const done = vm.process.wait(child.pid); await vm.process.kill(child.pid); await done;
      await assert.rejects(readFile(join(child.cgroup, 'cgroup.events')), { code: 'ENOENT' });
    });
    await check('manager SIGKILL with detached descendant', async () => {
      const entry = fileURLToPath(new URL('../../packages/agentos-sdk/dist/linux-experimental-entry.js', import.meta.url));
      const jobSource = `
        const fs=require('fs'),{spawn}=require('child_process');
        const c=spawn(process.execPath,['-e',"require('fs').writeFileSync('grandchild-pid',String(process.pid));setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'});
        fs.writeFileSync('root-pid',String(process.pid));setInterval(()=>{},1000);
      `;
      const managerSource = `
        import {createLinuxExperiment} from ${JSON.stringify(pathToFileURL(entry).href)};
        const vm=await createLinuxExperiment(${JSON.stringify(options)});
        const p=await vm.process.spawn(process.execPath,['-e',${JSON.stringify(jobSource)}]);
        console.log(JSON.stringify(p));setInterval(()=>{},1000);
      `;
      const manager = spawn(process.execPath, ['--input-type=module', '-e', managerSource], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '', descriptor;
      manager.stdout.on('data', b => { output += b; }); manager.stderr.on('data', b => { errors += b; });
      const exited = new Promise(ok => manager.once('exit', ok));
      const deadline = Date.now() + 10000;
      try {
        while (!output.includes('\n')) { assert.ok(Date.now() < deadline, `Manager did not start: ${errors}`); await pause(20); }
        descriptor = JSON.parse(output.split('\n')[0]);
        let grandchild;
        while (!grandchild) {
          try { grandchild = Number(await readFile(join(workspace, 'grandchild-pid'), 'utf8')); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
          assert.ok(Date.now() < deadline, 'Detached grandchild did not initialize'); await pause(20);
        }
        manager.kill('SIGKILL'); await exited;
        const stopDeadline = Date.now() + 5000;
        for (;;) {
          const events = await readFile(join(descriptor.cgroup, 'cgroup.events'), 'utf8');
          let live = false;
          for (const pid of [descriptor.hostPid, grandchild]) { try { process.kill(pid, 0); live = true; } catch (e) { if (e.code !== 'ESRCH') throw e; } }
          if (events.includes('populated 0') && !live) break;
          assert.ok(Date.now() < stopDeadline, 'Descendants survived manager crash or were not reaped'); await pause(20);
        }
        // The deceased manager cannot remove its empty directory. Remove only
        // the exact fixture job it reported, never sweep other empty jobs.
        await rmdir(descriptor.cgroup);
      } finally {
        manager.kill('SIGKILL'); await exited;
        if (descriptor) await writeFile(join(descriptor.cgroup, 'cgroup.kill'), '1').catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
    });
    report.status = 'candidate-tests-passed';
  } finally { await vm?.dispose(); await rm(workspace, { recursive: true, force: true }); }
}
if (!report.blockers.length) {
  try { await execute(); } catch (e) { report.status = 'failed'; report.error = e.message; }
}
const destination = process.env.AGENTOS_SDK_HOST_REPORT ?? join(root, 'artifacts/results/linux-sdk-host-acceptance.json');
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, tests: report.tests.length, blockers: report.blockers, report: destination }, null, 2));
process.exitCode = report.status === 'blocked' ? 77 : report.status === 'failed' ? 1 : 0;
