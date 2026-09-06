import { DatabaseSync, constants } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Explicit typed transport preserves SQL blobs, 64-bit integers and undefined.
export function encode(value) {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (value instanceof Map) return ['map', [...value].map(([key, item]) => [encode(key), encode(item)])];
  if (Array.isArray(value)) return ['array', value.map(encode)];
  if (value && typeof value === 'object') return ['object', Object.entries(value).map(([k, v]) => [k, encode(v)])];
  return ['scalar', value];
}
export function decode([kind, value]) {
  if (kind === 'undefined') return undefined;
  if (kind === 'bigint') return BigInt(value);
  if (kind === 'bytes') return Buffer.from(value, 'base64');
  if (kind === 'map') return new Map(value.map(([key, item]) => [decode(key), decode(item)]));
  if (kind === 'array') return value.map(decode);
  if (kind === 'object') return Object.fromEntries(value.map(([k, v]) => [k, decode(v)]));
  if (kind === 'scalar') return value;
  throw new Error('Invalid SQLite wire value');
}

export function createHostSqlite(root, { collectTableContract, collectNamedIndexContract, collectCanonicalStrictTables, statementCacheSize = 0 } = {}) {
  if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 0 || statementCacheSize > 128) throw new Error('Invalid SQLite statement cache size');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const databases = new Map();
  const statementCaches = new Map();
  const stats = { calls: 0, opens: 0, prepares: 0, statementCacheHits: 0, version: undefined, failures: [] };
  function execute({ payload }) {
    stats.calls++;
    try {
      const request = decode(JSON.parse(payload));
      let value;
      if (request.op === 'open') {
        if (databases.size >= 64) throw new Error('SQLite handle limit reached');
        if (typeof request.path !== 'string' || request.path.length > 4096) throw new Error('Invalid guest database path');
        if (request.path !== ':memory:' && !request.path.startsWith('/')) throw new Error('Database path must be absolute');
        const path = request.path === ':memory:' ? ':memory:' : join(root, createHash('sha256').update(request.path).digest('hex') + '.sqlite');
        const db = new DatabaseSync(path, { readOnly: request.options?.readOnly === true, allowExtension: false, enableForeignKeyConstraints: request.options?.enableForeignKeyConstraints !== false });
        db.setAuthorizer((action, first) => {
          if (action === constants.SQLITE_ATTACH) return constants.SQLITE_DENY;
          if (action === constants.SQLITE_PRAGMA && ['temp_store_directory', 'data_store_directory'].includes(first?.toLowerCase())) return constants.SQLITE_DENY;
          return constants.SQLITE_OK;
        });
        const handle = randomUUID();
        databases.set(handle, db);
        statementCaches.set(handle, new Map());
        stats.opens++;
        stats.version = db.prepare('SELECT sqlite_version() AS version').get().version;
        value = handle;
      } else {
        const db = databases.get(request.handle);
        if (!db) throw new Error('Unknown SQLite handle');
        const cache = statementCaches.get(request.handle);
        if (request.op === 'close') { db.close(); databases.delete(request.handle); statementCaches.delete(request.handle); }
        else if (request.op === 'state') value = { isOpen: db.isOpen, isTransaction: db.isTransaction };
        else if (request.op === 'exec') { cache.clear(); value = db.exec(request.sql); }
        else if (request.op === 'openclaw-canonical-strict-tables') {
          if (!collectCanonicalStrictTables) throw new Error('Canonical table collector is not configured');
          value = collectCanonicalStrictTables(db);
        }
        else if (request.op === 'openclaw-table-contract') {
          if (!collectTableContract) throw new Error('Schema collector is not configured');
          if (typeof request.tableName !== 'string' || request.tableName.length > 4096) throw new Error('Invalid table name');
          value = collectTableContract(db, request.tableName);
        } else if (request.op === 'openclaw-named-index-contract') {
          if (!collectNamedIndexContract) throw new Error('Named index collector is not configured');
          if (typeof request.indexName !== 'string' || request.indexName.length > 4096) throw new Error('Invalid index name');
          value = collectNamedIndexContract(db, request.indexName);
        } else if (request.op === 'statement') {
          if (!['get', 'all', 'run', 'columns'].includes(request.method)) throw new Error('Unsupported SQLite statement operation');
          // Keep only bounded DML/query statements, never query results. Bound
          // payload size too, since SQLite can retain the most recent bindings.
          // PRAGMA/DDL may have prepare-time effects: execute those afresh and
          // invalidate cached statements. columns() needs fresh schema metadata.
          const reusable = statementCacheSize > 0 && payload.length <= 32768 && request.method !== 'columns'
            && typeof request.sql === 'string' && request.sql.length <= 16384
            && (/^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(request.sql)
              || /^\s*PRAGMA\s+(data_version|user_version)\s*;?\s*$/i.test(request.sql));
          if (!reusable) cache.clear();
          let statement = reusable ? cache.get(request.sql) : undefined;
          if (statement) { stats.statementCacheHits++; cache.delete(request.sql); }
          else { statement = db.prepare(request.sql); stats.prepares++; }
          try {
            // Different guest StatementSync objects can share SQL. Restore all
            // options on every call so one object's settings cannot leak.
            statement.setReadBigInts(Boolean(request.readBigInts));
            statement.setAllowBareNamedParameters(request.allowBareNamedParameters === undefined ? true : request.allowBareNamedParameters);
            statement.setAllowUnknownNamedParameters(request.allowUnknownNamedParameters === undefined ? false : request.allowUnknownNamedParameters);
            value = statement[request.method](...(request.args ?? []));
            if (reusable) {
              cache.set(request.sql, statement);
              if (cache.size > statementCacheSize) cache.delete(cache.keys().next().value);
            }
          } catch (error) { cache.delete(request.sql); throw error; }
        } else throw new Error('Unsupported SQLite operation');
      }
      const result = JSON.stringify(encode(value));
      if (Buffer.byteLength(result) > 8 * 1024 * 1024) throw new Error('SQLite result exceeds transport limit');
      return JSON.stringify({ ok: true, result });
    } catch (error) { stats.failures.push({ message: error.message, code: error.code }); return JSON.stringify({ ok: false, error: { message: error.message, code: error.code ?? 'ERR_SQLITE_ADAPTER' } }); }
  }
  return {
    stats,
    collection: { name: 'core-sqlite', description: 'Scoped SQLite operations for OpenClaw core', bindings: {
      call: { description: 'Execute a scoped database operation', inputSchema: z.object({ payload: z.string().max(2 * 1024 * 1024) }), execute },
    } },
    execute,
    dispose() { for (const db of databases.values()) db.close(); databases.clear(); statementCaches.clear(); },
  };
}
