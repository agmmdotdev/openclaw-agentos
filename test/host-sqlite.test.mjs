import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSqlite, encode, decode } from '../src/host-sqlite.mjs';

for (const statementCacheSize of [0, 2]) test(`statement reuse preserves semantics (cache=${statementCacheSize})`, () => {
  const root = mkdtempSync(join(tmpdir(), 'core-sqlite-cache-'));
  const service = createHostSqlite(root, { statementCacheSize });
  const call = request => {
    const response = JSON.parse(service.execute({ payload: JSON.stringify(encode(request)) }));
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return decode(JSON.parse(response.result));
  };
  try {
    const handle = call({ op: 'open', path: '/state/db.sqlite' });
    const exec = sql => call({ op: 'exec', handle, sql });
    const query = (sql, args = [], options = {}) => call({ op: 'statement', handle, sql, method: 'get', args, ...options });
    assert.deepEqual(query('SELECT ? AS n', [7n], { readBigInts: true }), { n: 7n });
    assert.deepEqual(query('SELECT ? AS n', [8n]), { n: 8 });
    assert.deepEqual(query('SELECT ? AS n'), { n: null });
    assert.deepEqual(query('SELECT $n AS n', [{ n: 3, extra: 9 }], { allowUnknownNamedParameters: true }), { n: 3 });
    assert.throws(() => query('SELECT $n AS n', [{ n: 3, extra: 9 }]), /Unknown named parameter/);
    assert.deepEqual(query('SELECT $n AS n', [{ $n: 4 }], { allowBareNamedParameters: false }), { n: 4 });
    assert.deepEqual(query('SELECT $n AS n', [{ n: 5 }]), { n: 5 });
    assert.throws(() => query('SELECT $n AS n', [{ n: 3 }], { allowBareNamedParameters: null }), /boolean/);
    exec('CREATE TABLE items(n INTEGER UNIQUE); INSERT INTO items VALUES(1)');
    assert.deepEqual(query('SELECT * FROM items'), { n: 1 });
    exec('BEGIN; ALTER TABLE items ADD COLUMN value TEXT');
    assert.deepEqual(query('SELECT * FROM items'), { n: 1, value: null });
    exec('ROLLBACK');
    assert.deepEqual(query('SELECT * FROM items'), { n: 1 });
    // Schema changes through another connection must trigger SQLite reprepare.
    const second = call({ op: 'open', path: '/state/db.sqlite' });
    const dataVersion = query('PRAGMA data_version').data_version;
    call({ op: 'exec', handle: second, sql: 'ALTER TABLE items ADD COLUMN extra TEXT' });
    assert.notEqual(query('PRAGMA data_version').data_version, dataVersion);
    assert.equal(query('PRAGMA user_version').user_version, 0);
    call({ op: 'exec', handle: second, sql: 'PRAGMA user_version=7' });
    assert.equal(query('PRAGMA user_version').user_version, 7);
    assert.deepEqual(query('SELECT * FROM items'), { n: 1, extra: null });
    const columns = call({ op: 'statement', handle, sql: 'SELECT * FROM items', method: 'columns' });
    assert.deepEqual(columns.map(column => column.name), ['n', 'extra']);
    const insert = n => query('INSERT INTO items(n) VALUES(?)', [n], { method: 'run' });
    insert(2);
    assert.throws(() => insert(2), /UNIQUE/);
    insert(3);
    assert.equal(query('SELECT count(*) AS n FROM items').n, 3);
    // Each handle must retain its own data and authorization.
    const isolated = call({ op: 'open', path: ':memory:' });
    assert.throws(() => call({ op: 'statement', handle: isolated, sql: 'SELECT * FROM items', method: 'get' }), /no such table/);
    assert.throws(() => exec("ATTACH '/tmp/escape.sqlite' AS outside"), /authoriz/);
    // LRU capacity is observable through actual prepare counts.
    exec('SELECT 1');
    const before = service.stats.prepares;
    for (const n of [10, 11, 10, 12, 11]) query(`SELECT ${n}`);
    assert.equal(service.stats.prepares - before, statementCacheSize ? 4 : 5);
    const beforeLarge = service.stats.prepares;
    for (let i = 0; i < 2; i++) query('SELECT length(?) AS n', ['x'.repeat(33000)]);
    assert.equal(service.stats.prepares - beforeLarge, 2);
    call({ op: 'close', handle });
    assert.throws(() => query('SELECT 11'), /Unknown SQLite handle/);
    assert.equal(service.stats.statementCacheHits > 0, statementCacheSize > 0);
  } finally { service.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('SQLite adapter preserves transactions, typed values, persistence and isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-sqlite-test-'));
  let service = createHostSqlite(join(root, 'tenant-a'));
  const call = request => {
    const response = JSON.parse(service.execute({ payload: JSON.stringify(encode(request)) }));
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return decode(JSON.parse(response.result));
  };
  try {
    const handle = call({ op: 'open', path: '/state/test.sqlite' });
    call({ op: 'exec', handle, sql: 'CREATE TABLE items(id INTEGER, data BLOB); BEGIN IMMEDIATE' });
    assert.equal(call({ op: 'state', handle }).isTransaction, true);
    call({ op: 'statement', handle, sql: 'INSERT INTO items VALUES(?,?)', method: 'run', args: [9223372036854775807n, Buffer.from([0, 128, 255])] });
    call({ op: 'exec', handle, sql: 'COMMIT' });
    assert.equal(call({ op: 'state', handle }).isTransaction, false);
    const row = call({ op: 'statement', handle, sql: 'SELECT * FROM items', method: 'get', readBigInts: true });
    assert.deepEqual(row, { id: 9223372036854775807n, data: Buffer.from([0, 128, 255]) });
    assert.equal(call({ op: 'statement', handle, sql: 'SELECT * FROM items WHERE 0', method: 'get' }), undefined);
    call({ op: 'exec', handle, sql: 'BEGIN; DELETE FROM items; ROLLBACK' });
    assert.equal(call({ op: 'statement', handle, sql: 'SELECT count(*) AS n FROM items', method: 'get' }).n, 1);
    const escaped = join(root, 'escaped.sqlite');
    assert.throws(() => call({ op: 'exec', handle, sql: `ATTACH '${escaped}' AS outside` }), /authoriz/);
    assert.throws(() => call({ op: 'exec', handle, sql: `VACUUM INTO '${escaped}'` }), /authoriz/);
    assert.equal(existsSync(escaped), false);
    call({ op: 'close', handle });
    assert.throws(() => call({ op: 'exec', handle, sql: 'SELECT 1' }), /Unknown SQLite handle/);
    service.dispose();
    service = createHostSqlite(join(root, 'tenant-a'));
    const reopened = call({ op: 'open', path: '/state/test.sqlite' });
    assert.equal(call({ op: 'statement', handle: reopened, sql: 'SELECT count(*) AS n FROM items', method: 'get' }).n, 1);
    service.dispose();
    service = createHostSqlite(join(root, 'tenant-b'));
    assert.throws(() => call({ op: 'exec', handle: reopened, sql: 'SELECT 1' }), /Unknown SQLite handle/);
    const other = call({ op: 'open', path: '/state/test.sqlite' });
    assert.throws(() => call({ op: 'statement', handle: other, sql: 'SELECT * FROM items', method: 'get' }), /no such table/);
  } finally { service.dispose(); rmSync(root, { recursive: true, force: true }); }
});
