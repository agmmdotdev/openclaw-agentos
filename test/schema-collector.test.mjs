import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreHostSqlite } from '../src/core-host-sqlite.mjs';
import { encode, decode } from '../src/host-sqlite.mjs';
import { collectSqliteTableContract } from '../artifacts/core/schema-collector.mjs';

test('batched upstream schema collector matches direct SQLite and observes DDL/rollback without caching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-schema-test-'));
  const service = await createCoreHostSqlite(root);
  const foreign = await createCoreHostSqlite(join(root, 'foreign'));
  const db = new DatabaseSync(':memory:');
  function call(request, target = service) {
    const response = JSON.parse(target.execute({ payload: JSON.stringify(encode(request)) }));
    if (!response.ok) throw new Error(response.error.message);
    return decode(JSON.parse(response.result));
  }
  try {
    const handle = call({ op: 'open', path: ':memory:' });
    const sql = `CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT COLLATE NOCASE NOT NULL, note TEXT DEFAULT 'a,b', CHECK(length(value)>0)) STRICT;
      CREATE UNIQUE INDEX example_value ON example(value DESC) WHERE value != 'skip';
      CREATE INDEX example_expression ON example(lower(value));
      CREATE TABLE audit(message TEXT);
      CREATE TRIGGER example_log AFTER INSERT ON example BEGIN INSERT INTO audit VALUES(new.value); END;
      CREATE VIRTUAL TABLE searchable USING fts5(content);
      CREATE TABLE composite(a TEXT, b INTEGER, PRIMARY KEY(a,b)) WITHOUT ROWID;
      CREATE TABLE "odd\"\"name" ("col\"\"name" TEXT UNIQUE);`;
    const exec = sql => { db.exec(sql); call({ op: 'exec', handle, sql }); };
    const inspect = name => call({ op: 'openclaw-table-contract', handle, tableName: name });
    exec(sql);
    for (const name of ['example','audit','searchable','composite','odd"name','missing',"x'); DROP TABLE example;--"]) {
      assert.deepEqual(inspect(name), collectSqliteTableContract(db, name));
    }
    assert.ok(inspect('example').definition.columns instanceof Map);
    assert.equal(inspect('example').strict, 1);
    assert.equal(inspect('composite').withoutRowid, 1);
    assert.equal(inspect('example').triggers.length, 1);
    exec('BEGIN; ALTER TABLE example ADD COLUMN added BLOB; DROP INDEX example_value');
    assert.deepEqual(inspect('example'), collectSqliteTableContract(db, 'example'));
    assert.ok(inspect('example').definition.columns.has('added'));
    exec('ROLLBACK');
    assert.deepEqual(inspect('example'), collectSqliteTableContract(db, 'example'));
    assert.equal(inspect('example').definition.columns.has('added'), false);
    assert.throws(() => call({ op: 'openclaw-table-contract', handle, tableName: 'example' }, foreign), /Unknown SQLite handle/);
    assert.throws(() => call({ op: 'openclaw-table-contract', handle, tableName: 1 }), /Invalid table name/);
    call({ op: 'close', handle });
    assert.throws(() => inspect('example'), /Unknown SQLite handle/);
  } finally { db.close(); service.dispose(); foreign.dispose(); rmSync(root, { recursive: true, force: true }); }
});
