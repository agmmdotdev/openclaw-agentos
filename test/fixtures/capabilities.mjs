import fs from './compat/fs.mjs';
import { hash, randomInt, X509Certificate } from './compat/crypto.mjs';
import { TextDecoder } from './compat/text-decoder.mjs';
import { AsyncLocalStorage } from './compat/async-hooks.mjs';
import { DatabaseSync } from './compat/sqlite.mjs';
import { monitorEventLoopDelay } from './compat/perf-hooks.mjs';
import { spawn, execFileSync } from './compat/child-process.mjs';
let count = 0;
const failures = [];
const check = (value, description) => { if (!value) failures.push(description); count++; };
check(hash('sha256', 'abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA256 vector');
check(hash('sha256', 'abc', 'buffer').length === 32, 'hash buffer output');
for (let i = 0; i < 100; i++) { const value = randomInt(-5, 7); check(value >= -5 && value < 7 && Number.isInteger(value), 'randomInt bounds'); }
check(await new Promise((resolve, reject) => randomInt(2, 3, (err, value) => err ? reject(err) : resolve(value))) === 2, 'callback randomInt');
check(new TextDecoder('latin1').decode(Uint8Array.from([0x41, 0x80, 0x91, 0xff])) === 'A€‘ÿ', 'WHATWG Windows-1252 decoding');
check(new TextDecoder().decode(new TextEncoder().encode('မြန်မာ')) === 'မြန်မာ', 'native UTF-8 delegation');
check(fs.statSync('/not-present', { throwIfNoEntry: false }) === undefined, 'optional stat');
let missing = false;
try { fs.statSync('/not-present'); } catch (error) { missing = error.code === 'ENOENT'; }
check(missing, 'ordinary stat still rejects missing paths');
const a = new AsyncLocalStorage(), b = new AsyncLocalStorage();
const captured = a.run('a', () => b.run('b', () => AsyncLocalStorage.bind(function (value) { return [a.getStore(), b.getStore(), this.id, value]; })));
check(JSON.stringify(a.run('other', () => captured.call({ id: 7 }, 8))) === '["a","b",7,8]', 'static bind captures multiple contexts, this and arguments');
check(a.getStore() === undefined && b.getStore() === undefined, 'bound contexts restore caller');
const parallel = await Promise.all(['first', 'second'].map(label => a.run(label, async () => { await new Promise(resolve => setTimeout(resolve, label === 'first' ? 20 : 5)); return a.getStore(); })));
check(JSON.stringify(parallel) === '["first","second"]', 'async local contexts remain isolated across await');
check(a.getStore() === undefined, 'async contexts restore caller after await');
for (const code of [0, 7]) {
  const child = spawn('node', ['-e', `setTimeout(() => process.exit(${code}), 5)`]);
  let removedCalls = 0, retainedCalls = 0;
  const symbol = Symbol('child-event');
  child.on('fixture', () => removedCalls++);
  child.once('fixture', () => removedCalls++);
  child.on(symbol, () => retainedCalls++);
  check(child.removeAllListeners('fixture') === child, 'removeAllListeners returns child');
  child.emit('fixture'); child.emit(symbol);
  check(removedCalls === 0 && retainedCalls === 1, 'event-scoped removal clears persistent and once listeners only');
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  check(exit.code === code && exit.signal === null && child.exitCode === code, 'real child exit code survives cleanup boundary');
  child.removeAllListeners(); child.emit(symbol);
  check(retainedCalls === 1, 'removeAllListeners clears symbol events');
}
// Preserve shell startup, NUL boundaries, embedded newlines and process failures.
const shellEnv = execFileSync('/bin/sh', ['-l', '-c', "printf '\\0'; env -0"], {
  encoding: 'buffer', timeout: 2500, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CORE_ENV_FIXTURE: 'line one\nline two=three' },
});
check(Buffer.isBuffer(shellEnv) && shellEnv[0] === 0, 'login probe retains NUL sentinel');
check(shellEnv.toString().split('\0').includes('CORE_ENV_FIXTURE=line one\nline two=three'), 'login probe preserves multiline environment values');
check(shellEnv.toString().split('\0').some(entry => entry.startsWith('PATH=') && entry.length > 5), 'login probe returns real shell PATH');
let shellFailure;
try { execFileSync('/bin/sh', ['-c', 'exit 7'], { encoding: 'utf8' }); } catch (error) { shellFailure = error.status; }
check(shellFailure === 7, 'non-probe execFileSync keeps genuine exit status');
const db = new DatabaseSync('/state/capabilities.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS vals(n INTEGER, b BLOB); DELETE FROM vals; BEGIN IMMEDIATE');
check(db.isTransaction, 'real transaction state');
db.prepare('INSERT INTO vals VALUES(?,?)').run(9223372036854775807n, Buffer.from([0, 128, 255]));
db.exec('COMMIT');
const select = db.prepare('SELECT * FROM vals'); select.setReadBigInts(true);
const row = select.get();
check(row.n === 9223372036854775807n && Buffer.from(row.b).toString('hex') === '0080ff', 'SQLite typed roundtrip');
check(db.prepare('SELECT * FROM vals WHERE 0').get() === undefined, 'SQLite missing row');
let denied = false;
try { db.exec("ATTACH '/tmp/should-not-exist.sqlite' AS x"); } catch (error) { denied = /authoriz/.test(error.message); }
check(denied, 'SQLite arbitrary host attach denied');
db.close();
for (const operation of [() => new X509Certificate('invalid'), () => monitorEventLoopDelay()]) {
  let unsupported = false;
  try { operation(); } catch (error) { unsupported = error.code === 'ERR_AGENTOS_UNSUPPORTED_CAPABILITY'; }
  check(unsupported, 'unsupported operation fails explicitly');
}
console.log('CAPABILITIES_RESULT=' + JSON.stringify({ assertions: count, failures, parallel, sqlite: 'host-backed', unsupported: ['X509Certificate', 'monitorEventLoopDelay'] }));

if (failures.length) process.exitCode = 1;
