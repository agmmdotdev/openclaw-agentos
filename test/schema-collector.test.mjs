import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreHostSqlite } from '../src/core-host-sqlite.mjs';
import { encode, decode } from '../src/host-sqlite.mjs';
import { collectSqliteTableContract, collectSqliteNamedIndexContract, collectCanonicalStrictTableMetadata } from '../artifacts/core/schema-collector.mjs';

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
    const inspectIndex = name => call({ op: 'openclaw-named-index-contract', handle, indexName: name });
    const compareIndexes = () => {
      for (const name of ['example_value', 'example_expression', 'sqlite_autoindex_composite_1', 'missing', "x'); DROP TABLE example;--"]) {
        assert.deepEqual(inspectIndex(name), collectSqliteNamedIndexContract(db, name));
      }
    };
    exec(sql);
    compareIndexes();
    assert.equal(inspectIndex('example_value').partial, 1);
    assert.equal(inspectIndex('example_value').unique, 1);
    assert.ok(inspectIndex('example_expression').terms.some(term => term.kind === 'expression'));
    for (const name of ['example','audit','searchable','composite','odd"name','missing',"x'); DROP TABLE example;--"]) {
      assert.deepEqual(inspect(name), collectSqliteTableContract(db, name));
    }
    assert.ok(inspect('example').definition.columns instanceof Map);
    assert.equal(inspect('example').strict, 1);
    assert.equal(inspect('composite').withoutRowid, 1);
    assert.equal(inspect('example').triggers.length, 1);
    exec('BEGIN; ALTER TABLE example ADD COLUMN added BLOB; DROP INDEX example_value');
    compareIndexes();
    assert.equal(inspectIndex('example_value'), undefined);
    exec('CREATE INDEX example_value ON example(note)');
    compareIndexes();
    assert.equal(inspectIndex('example_value').unique, 0);
    assert.deepEqual(inspect('example'), collectSqliteTableContract(db, 'example'));
    assert.ok(inspect('example').definition.columns.has('added'));
    exec('ROLLBACK');
    compareIndexes();
    assert.equal(inspectIndex('example_value').unique, 1);
    assert.deepEqual(inspect('example'), collectSqliteTableContract(db, 'example'));
    assert.equal(inspect('example').definition.columns.has('added'), false);
    assert.throws(() => call({ op: 'openclaw-table-contract', handle, tableName: 'example' }, foreign), /Unknown SQLite handle/);
    assert.throws(() => call({ op: 'openclaw-table-contract', handle, tableName: 1 }), /Invalid table name/);
    assert.throws(() => call({ op: 'openclaw-named-index-contract', handle, indexName: 'example_value' }, foreign), /Unknown SQLite handle/);
    assert.throws(() => call({ op: 'openclaw-named-index-contract', handle, indexName: 1 }), /Invalid index name/);
    call({ op: 'close', handle });
    assert.throws(() => inspect('example'), /Unknown SQLite handle/);
    assert.throws(() => inspectIndex('example_value'), /Unknown SQLite handle/);
  } finally { db.close(); service.dispose(); foreign.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('canonical metadata scan preserves rowid safety, strict checks and transaction state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-canonical-test-'));
  const service = await createCoreHostSqlite(root);
  const db = new DatabaseSync(':memory:');
  const call = request => {
    const result = JSON.parse(service.execute({ payload: JSON.stringify(encode(request)) }));
    if (!result.ok) throw new Error(result.error.message);
    return decode(JSON.parse(result.result));
  };
  try {
    const handle = call({ op: 'open', path: ':memory:' });
    const exec = sql => { db.exec(sql); call({ op: 'exec', handle, sql }); };
    const inspect = () => call({ op: 'openclaw-canonical-strict-tables', handle });
    exec(`CREATE TABLE "é"(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT) STRICT;
      CREATE TABLE composite(a TEXT,b INTEGER,PRIMARY KEY(a,b)) STRICT, WITHOUT ROWID;
      CREATE TABLE aliases(_rowid_ TEXT,rowid TEXT) STRICT;
      CREATE TABLE descending(id INTEGER PRIMARY KEY DESC,value TEXT) STRICT;
      CREATE TABLE generated(value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value*2)) STRICT;`);
    assert.deepEqual(inspect(), collectCanonicalStrictTableMetadata(db));
    const byName = Object.fromEntries(inspect().map(table => [table.name, table]));
    assert.equal(byName['é'].rowidStorage, 'integer-primary-key');
    assert.equal(byName['é'].usesAutoincrement, true);
    assert.equal(byName.composite.rowidStorage, 'without-rowid');
    assert.equal(byName.aliases.rowidAlias, 'oid');
    assert.equal(byName.descending.rowidStorage, 'implicit');
    exec('BEGIN; ALTER TABLE aliases ADD COLUMN extra BLOB');
    assert.deepEqual(inspect(), collectCanonicalStrictTableMetadata(db));
    assert.equal(call({ op: 'state', handle }).isTransaction, true);
    exec('ROLLBACK');
    assert.deepEqual(inspect(), collectCanonicalStrictTableMetadata(db));
    exec('CREATE TABLE unsafe(_rowid_ TEXT,rowid TEXT,oid TEXT) STRICT');
    assert.throws(inspect, /shadows every rowid alias/);
    exec('DROP TABLE unsafe; CREATE TABLE legacy(value TEXT)');
    assert.throws(inspect, /non-STRICT tables: legacy/);
    assert.throws(() => call({ op: 'openclaw-canonical-strict-tables', handle: 'foreign' }), /Unknown SQLite handle/);
  } finally { db.close(); service.dispose(); rmSync(root, { recursive: true, force: true }); }
});
