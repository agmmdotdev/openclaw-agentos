import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createHostSqlite } from './host-sqlite.mjs';

// Load only the small, build-generated upstream metadata collector. The host
// keeps the same scoped database handles and SQLite authorizer as before.
export async function createCoreHostSqlite(root, { statementCacheSize = 0 } = {}) {
  const directory = new URL('../artifacts/core/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const url = new URL('schema-collector.mjs', directory);
  const bytes = await readFile(url);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.schemaCollector?.sha256) throw new Error('Unverified schema collector artifact');
  const { collectSqliteTableContract, collectSqliteNamedIndexContract, collectCanonicalStrictTableMetadata } = await import(`${url.href}?sha256=${digest}`);
  return createHostSqlite(root, { statementCacheSize, collectTableContract: collectSqliteTableContract, collectNamedIndexContract: collectSqliteNamedIndexContract, collectCanonicalStrictTables: collectCanonicalStrictTableMetadata });
}
