// Host-only candidate acceptance. Never provisions delegation or enables kernel features.
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, realpath, stat, statfs, open, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { inspectLinuxCapabilities } from '../../packages/agentos-sdk/dist/preflight.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const launcher = join(root, 'packages/agentos-sdk/dist/linux-launcher-experimental');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => (await readFile(path, 'utf8')).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { version: 1, date: new Date().toISOString(), kind: 'experimental-linux-host-acceptance',
  status: 'blocked', sdkSandboxEnabled: false, sandboxEnforcementVerified: false,
  host: await inspectLinuxCapabilities(), launcherSha256: hash(await readFile(launcher)),
  blockers: [], tests: [], remainingGates: ['SDK integration and full OpenClaw security parity',
    'Manager crash containment and orphan reaping under a host supervisor',
    'Independent policy review and matched protected RAM/CPU benchmarks'] };
const probe = spawnSync(launcher, ['--self-test-seccomp'], { encoding: 'utf8', env: {}, timeout: 5000 });
report.seccompProbe = probe.status === 0 ? JSON.parse(probe.stdout) : { error: probe.stderr, status: probe.status };
if (probe.status !== 0) report.blockers.push('Seccomp self-test failed');
if (report.host.platform !== 'linux' || report.host.architecture !== 'x64') report.blockers.push('Linux x86_64 required');
if (!(report.host.landlock?.landlockAbi >= 6)) report.blockers.push(`Landlock ABI >=6 required; probe=${JSON.stringify(report.host.landlock)}`);
const security = await read('/proc/self/status');
if (security.split('\n').some(line => /^(CapEff|CapPrm|CapInh):/.test(line) && !/\s0+$/.test(line))) {
  report.blockers.push('Use an unprivileged account with empty effective, permitted and inheritable capability sets');
}
let delegation, manifest;
if (!process.env.AGENTOS_TEST_CGROUP) report.blockers.push('AGENTOS_TEST_CGROUP must name an existing delegated cgroup with cpu/memory/pids enabled');
else try {
  delegation = await realpath(process.env.AGENTOS_TEST_CGROUP);
  assert.equal((await statfs(delegation)).type, 0x63677270, 'cgroup2 filesystem required');
  const enabled = (await read(join(delegation, 'cgroup.subtree_control'))).split(/\s+/);
  assert.ok(['cpu', 'memory', 'pids'].every(c => enabled.includes(c)), 'cpu/memory/pids must already be delegated and enabled');
} catch (e) { report.blockers.push(`Delegation unavailable: ${e.message}`); }
if (!process.env.AGENTOS_RUNTIME_MANIFEST) report.blockers.push('AGENTOS_RUNTIME_MANIFEST must name a reviewed file-only runtime manifest');
else try {
  manifest = JSON.parse(await readFile(process.env.AGENTOS_RUNTIME_MANIFEST, 'utf8'));
  assert.equal(manifest.version, 1); assert.ok(isAbsolute(manifest.node));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length < 255);
  for (const f of manifest.files) {
    assert.ok(isAbsolute(f.path) && !/^\/(proc|sys|dev)(\/|$)/.test(f.path));
    assert.equal(await realpath(f.path), f.path, 'manifest paths must be canonical');
    assert.ok((await stat(f.path)).isFile());
    assert.equal(hash(await readFile(f.path)), f.sha256, `runtime hash mismatch: ${f.path}`);
  }
  assert.ok(manifest.files.some(f => f.path === manifest.node));
  report.runtime = manifest;
} catch (e) { report.blockers.push(`Runtime manifest invalid: ${e.message}`); }

function counters(s) { return Object.fromEntries(s.split('\n').map(line => { const [k, v] = line.split(' '); return [k, Number(v)]; })); }
async function runCases() {
  const base = await mkdtemp(join(tmpdir(), 'agentos-linux-host-'));
  const outside = join(base, 'outside-secret'), canary = join(base, 'runtime-canary');
  await writeFile(outside, 'outside-secret'); await writeFile(canary, 'readonly-runtime');
  const inherited = await open(outside, 'r');
  // A harmless signal target owned only by this test; never signal arbitrary host PIDs.
  const victim = spawn(manifest.node, ['-e', "process.on('SIGUSR2',()=>console.log('signal-delivered'));console.log('ready');setInterval(()=>{},1000)"],
    { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let victimOutput = ''; victim.stdout.on('data', b => { victimOutput += b; });
  const victimDone = new Promise(resolve => { victim.once('error', resolve); victim.once('exit', resolve); });
  const started = Date.now();
  try {
    while (!victimOutput.includes('ready')) { assert.ok(Date.now() - started < 5000, 'signal target failed to start'); await pause(20); }
    async function run(name, source, check, { timeout = 8000, reason, pids = '64' } = {}) {
      const workspace = join(base, name), cg = join(delegation, `agentos-test-${randomUUID()}`);
      await mkdir(workspace, { mode: 0o700 }); await mkdir(cg);
      let child, timer, safetyTimer, cleanupError;
      let cause = null, total = 0, stdout = '', stderr = '', status = '';
      let killQueue = Promise.resolve();
      const kill = why => { cause ??= why; killQueue = killQueue.then(async () => {
        try { await writeFile(join(cg, 'cgroup.kill'), '1'); }
        catch (e) { cleanupError = e.message; child?.kill('SIGKILL'); }
      }); return killQueue; };
      try {
        for (const [file, value] of Object.entries({ 'memory.max': '268435456', 'memory.swap.max': '0',
          'memory.oom.group': '1', 'pids.max': pids, 'cpu.max': '20000 100000' })) await writeFile(join(cg, file), value);
        // Verify cgroup.kill is usable before any payload can start.
        await writeFile(join(cg, 'cgroup.kill'), '1');
        await writeFile(join(workspace, 'case.cjs'), `const __testCgroup=${JSON.stringify(cg)};\n${source}`);
        const args = ['--workspace', workspace, '--cgroup', cg, '--memory', '268435456', '--pids', pids,
          '--cpu', '20000 100000', ...[...manifest.files.map(f => f.path), canary].flatMap(f => ['--runtime-file', f]),
          '--', manifest.node, join(workspace, 'case.cjs')];
        child = spawn(launcher, args, { env: { AGENTOS_TEST_SECRET: 'synthetic-env-canary' },
          stdio: ['pipe', 'pipe', 'pipe', 'pipe', inherited.fd] });
        const chunks = (key, b) => {
          total += b.length;
          if (total > 65536) { void kill('output-limit'); return; }
          if (key === 'stdout') stdout += b; else if (key === 'stderr') stderr += b; else status += b;
        };
        child.stdout.on('data', b => chunks('stdout', b)); child.stderr.on('data', b => chunks('stderr', b));
        child.stdio[3].on('data', b => chunks('status', b)); child.stdin.end();
        timer = setTimeout(() => { void kill(reason ?? 'timeout'); }, timeout);
        const result = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => { void kill('root-exit'); });
          child.once('close', (code, signal) => resolve({ code, signal }));
          safetyTimer = setTimeout(() => {
            void kill('cleanup-timeout');
            for (const stream of child.stdio) stream?.destroy?.();
            reject(new Error('Launcher/pipes did not close after cgroup kill'));
          }, timeout + 5000);
        });
        clearTimeout(timer); clearTimeout(safetyTimer);
        await kill(cause ?? 'cleanup');
        const emptyDeadline = Date.now() + 3000;
        while (counters(await read(join(cg, 'cgroup.events'))).populated) {
          assert.ok(Date.now() < emptyDeadline, 'cgroup still populated after kill'); await pause(20);
        }
        assert.ok(!cleanupError, cleanupError);
        const data = { ...result, cause, stdout, stderr, status,
          memory: counters(await read(join(cg, 'memory.events'))), pids: counters(await read(join(cg, 'pids.events'))),
          cpu: counters(await read(join(cg, 'cpu.stat'))), populatedAfterCleanup: 0 };
        assert.ok(status.includes('restricted-before-exec'), `No restriction readiness: ${status} ${stderr}`);
        await check(data);
        assert.equal(await read(outside), 'outside-secret'); assert.equal(await read(canary), 'readonly-runtime');
        assert.ok(!victimOutput.includes('signal-delivered'));
        report.tests.push({ name, status: 'pass', ...data });
      } catch (e) { report.tests.push({ name, status: 'fail', error: e.message, stdout, stderr, launcherStatus: status }); throw e; }
      finally {
        clearTimeout(timer); clearTimeout(safetyTimer); await kill('finally');
        try { await rmdir(cg); } catch (e) { report.tests.push({ name: `${name}-cleanup`, status: 'fail', error: e.message }); }
      }
    }
    const value = JSON.stringify;
    await run('filesystem-process-environment', `
      const fs=require('fs'), assert=require('assert/strict');
      const deny=fn=>assert.throws(fn,e=>['EACCES','EPERM'].includes(e.code));
      fs.writeFileSync('own','hello 🐈');assert.equal(fs.readFileSync('own','utf8'),'hello 🐈');
      deny(()=>fs.readFileSync(${value(outside)}));deny(()=>fs.writeFileSync(${value(outside)},'bad'));
      fs.symlinkSync(${value(outside)},'escape');deny(()=>fs.readFileSync('escape'));
      deny(()=>fs.writeFileSync(${value(canary)},'bad'));
      deny(()=>fs.writeFileSync(__testCgroup+'/cgroup.procs','0'));
      deny(()=>fs.writeFileSync(__testCgroup+'/memory.max','max'));
      deny(()=>fs.readFileSync('/proc/'+${victim.pid}+'/environ'));
      deny(()=>process.kill(${victim.pid},'SIGUSR2'));
      assert.equal(process.env.AGENTOS_TEST_SECRET,undefined);
      assert.equal(process.env.PATH,'/nonexistent');
      for(let fd=3;fd<32;fd++) {try {const b=Buffer.alloc(14);const n=fs.readSync(fd,b,0,b.length,0);assert.notEqual(b.subarray(0,n).toString(),'outside-secret');} catch(e){if(e.code==='ERR_ASSERTION')throw e;}}
      console.log('filesystem-process-environment-ok');
    `, d => { assert.equal(d.code, 0, d.stderr); assert.ok(d.stdout.includes('filesystem-process-environment-ok')); });
    await run('network', `
      const net=require('net'),dgram=require('dgram'),assert=require('assert/strict');
      const tcp=opts=>new Promise((resolve,reject)=>{const s=net.connect(opts);s.on('connect',()=>{s.destroy();reject(Error('network allowed'))});s.on('error',e=>{try{assert.equal(e.code,'EPERM');resolve()}catch(x){reject(x)}})});
      const udp=type=>new Promise((resolve,reject)=>{const s=dgram.createSocket(type);const error=e=>{try{s.close()}catch{};try{assert.equal(e.code,'EPERM');resolve()}catch(x){reject(x)}};s.on('error',error);s.send('x',9,type==='udp4'?'127.0.0.1':'::1',e=>{if(e)error(e);else{s.close();reject(Error('UDP allowed'))}})});
      (async()=>{await tcp({host:'127.0.0.1',port:9});await tcp({host:'::1',port:9});await tcp({path:'socket'});await tcp({path:'\\0agentos-test'});await udp('udp4');await udp('udp6');console.log('network-ok')})().catch(e=>{console.error(e);process.exitCode=1});
    `, d => { assert.equal(d.code, 0, d.stderr); assert.ok(d.stdout.includes('network-ok')); });
    await run('detached-descendant', `
      const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
      c.on('error',e=>{console.error(e);process.exitCode=1});c.on('spawn',()=>{console.log('detached '+c.pid);c.unref()});
    `, d => { assert.equal(d.code, 0, d.stderr); assert.ok(d.stdout.includes('detached ')); assert.equal(d.cause, 'root-exit'); });
    await run('cpu-throttle', "const start=Date.now();while(Date.now()-start<2500){};console.log('cpu-ok')",
      d => { assert.equal(d.code, 0, d.stderr); assert.ok(d.cpu.nr_throttled > 0); });
    await run('memory-limit', "const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(16*1024*1024,1));setInterval(()=>{},1000)",
      d => { assert.ok(d.memory.oom_kill > 0, 'No cgroup OOM kill recorded'); assert.equal(d.signal, 'SIGKILL'); });
    await run('pids-limit', `
      const {spawn}=require('child_process');let pending=64, denied=0;
      for(let i=0;i<64;i++){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      c.on('error',e=>{if(e.code==='EAGAIN')denied++;else console.error(e);if(!--pending)finish()});
      c.on('spawn',()=>{c.unref();if(!--pending)finish()});}
      function finish(){console.log('denied '+denied);process.exit(denied?0:1)}
    `, d => { assert.equal(d.code, 0, d.stderr); assert.ok(d.pids.max > 0); }, { pids: '32' });
    await run('wall-timeout', 'while(true){}', d => { assert.equal(d.cause, 'timeout'); assert.equal(d.signal, 'SIGKILL'); }, { timeout: 1500 });
    await run('cancellation', 'setInterval(()=>{},1000)', d => { assert.equal(d.cause, 'cancel'); assert.equal(d.signal, 'SIGKILL'); }, { timeout: 1500, reason: 'cancel' });
    await run('output-limit', "while(true)require('fs').writeSync(1,Buffer.alloc(16384,65))",
      d => { assert.equal(d.cause, 'output-limit'); assert.equal(d.signal, 'SIGKILL'); });
  } finally { victim.kill('SIGKILL'); await victimDone; await inherited.close(); await rm(base, { recursive: true, force: true }); }
}
if (!report.blockers.length) {
  try { await runCases(); report.status = report.tests.some(t => t.status === 'fail') ? 'failed' : 'candidate-tests-passed'; }
  catch (e) { report.status = 'failed'; report.error = e.message; }
}
const destination = process.env.AGENTOS_HOST_REPORT ?? join(root, 'artifacts/results/linux-host-acceptance.json');
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, tests: report.tests.length, blockers: report.blockers, report: destination }, null, 2));
process.exitCode = report.status === 'blocked' ? 77 : report.status === 'failed' ? 1 : 0;
