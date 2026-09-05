import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSqlite, encode, decode } from '../src/host-sqlite.mjs';

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
