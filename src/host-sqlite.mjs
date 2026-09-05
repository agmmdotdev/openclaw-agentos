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
  if (Array.isArray(value)) return ['array', value.map(encode)];
  if (value && typeof value === 'object') return ['object', Object.entries(value).map(([k, v]) => [k, encode(v)])];
  return ['scalar', value];
}
export function decode([kind, value]) {
  if (kind === 'undefined') return undefined;
  if (kind === 'bigint') return BigInt(value);
  if (kind === 'bytes') return Buffer.from(value, 'base64');
  if (kind === 'array') return value.map(decode);
  if (kind === 'object') return Object.fromEntries(value.map(([k, v]) => [k, decode(v)]));
  if (kind === 'scalar') return value;
  throw new Error('Invalid SQLite wire value');
}

export function createHostSqlite(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const databases = new Map();
  const stats = { calls: 0, opens: 0, version: undefined, failures: [] };
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
        stats.opens++;
        stats.version = db.prepare('SELECT sqlite_version() AS version').get().version;
        value = handle;
      } else {
        const db = databases.get(request.handle);
        if (!db) throw new Error('Unknown SQLite handle');
        if (request.op === 'close') { db.close(); databases.delete(request.handle); }
        else if (request.op === 'state') value = { isOpen: db.isOpen, isTransaction: db.isTransaction };
        else if (request.op === 'exec') value = db.exec(request.sql);
        else if (request.op === 'statement') {
          if (!['get', 'all', 'run', 'columns'].includes(request.method)) throw new Error('Unsupported SQLite statement operation');
          const statement = db.prepare(request.sql);
          if (request.readBigInts) statement.setReadBigInts(true);
          if (request.allowBareNamedParameters !== undefined) statement.setAllowBareNamedParameters(request.allowBareNamedParameters);
          if (request.allowUnknownNamedParameters !== undefined) statement.setAllowUnknownNamedParameters(request.allowUnknownNamedParameters);
          value = statement[request.method](...(request.args ?? []));
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
    dispose() { for (const db of databases.values()) db.close(); databases.clear(); },
  };
}
