import { test } from 'node:test';
import assert from 'node:assert/strict';

const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const diagnostics = new URL(`../packages/openclaw-core/dist/${prefix}diagnostics.mjs`, import.meta.url);

// One fresh module graph verifies both helper-only demand and the first real parse.
test('install helpers defer validators and preserve persisted-record parsing contracts', async () => {
  const m = await import(diagnostics);
  assert.deepEqual(globalThis.__sourceInstallSchemaInit ?? {}, {});
  assert.deepEqual(m.inspectPluginInstallRecordMap(undefined), {status: 'missing'});
  assert.deepEqual(m.inspectPluginInstallRecordMap(null), {status: 'invalid'});
  const empty = m.parsePluginInstallRecordMap({});
  assert.equal(Object.getPrototypeOf(empty), null);
  assert.equal(m.serializePluginInstallRecordMap(empty), '{}');
  const mapped = m.createPluginInstallRecordMap();
  m.setPluginInstallRecordMapEntry(mapped, '__proto__', {source: 'path'});
  assert.deepEqual(m.getPluginInstallRecordMapEntry(mapped, '__proto__'), {source: 'path'});
  assert.equal(m.getPluginInstallRecordMapEntry({}, 'toString'), undefined);
  assert.equal(m.parseInstalledPluginIndexSqliteRow(undefined), null);
  assert.deepEqual(globalThis.__sourceInstallSchemaInit ?? {}, {});

  const surface = Object.fromEntries([
    'channels', 'providers', 'tools', 'contracts', 'hooks', 'mcpServers',
    'cliCommands', 'cliBackends', 'skills', 'dangerousConfigFlags',
  ].map(key => [key, []]));
  const input = {
    source: 'marketplace', spec: '  package  ', version: '   ',
    clawhubTrustReasons: [' first ', ' ', 'second'], acceptedSurface: surface,
    futureField: {preserved: true},
  };
  assert.deepEqual(m.parsePluginInstallRecord(input), {
    source: 'marketplace', spec: 'package', clawhubTrustReasons: ['first', 'second'],
    acceptedSurface: surface, futureField: {preserved: true},
  });
  assert.equal(input.spec, '  package  ');
  assert.deepEqual(input.clawhubTrustReasons, [' first ', ' ', 'second']);
  for (const invalid of [
    {source: 'unknown'}, {source: 'path', version: 42},
    {source: 'path', acceptedSurface: {...surface, extra: []}},
    {source: 'path', acceptedSurface: {...surface, tools: ['']}},
    {source: 'path', clawpackSize: -1},
  ]) assert.equal(m.parsePluginInstallRecord(invalid), null);
  assert.equal(m.parsePluginInstallRecordMap({valid: {source: 'path'}, invalid: {}}), null);
  const special = m.parsePluginInstallRecordMap(JSON.parse('{"__proto__":{"source":"path"}}'));
  assert.equal(Object.getPrototypeOf(special), null);
  assert.deepEqual(special.__proto__, {source: 'path'});
  assert.equal(m.serializePluginInstallRecordMap({10: {source: 'path'}, 2: {source: 'npm'}}),
    '{"10":{"source":"path"},"2":{"source":"npm"}}');
  assert.deepEqual(globalThis.__sourceInstallSchemaInit, {createPluginInstallRecordSchema: 1});

  const index = {
    version: m.INSTALLED_PLUGIN_INDEX_VERSION,
    migrationVersion: m.INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
    hostContractVersion: 'test-host', compatRegistryVersion: 'test-compat',
    policyHash: 'test-policy', generatedAtMs: 1, diagnostics: [],
    plugins: [{
      pluginId: 'test-plugin', manifestPath: '/test/manifest.json', manifestHash: 'manifest',
      rootDir: '/test', origin: 'global', enabled: true, compat: [],
      startup: {sidecar: false, memory: false, agentHarnesses: []},
      installRecord: {source: 'path', spec: ' local '},
    }],
    installRecords: {'test-plugin': {source: 'path', spec: ' local '}},
  };
  const parsed = m.parseInstalledPluginIndex(index);
  assert.ok(parsed);
  assert.equal(parsed.installRecords['test-plugin'].spec, 'local');
  // Index plugin metadata preserves its schema parse; only the canonical ledger normalizes.
  assert.equal(parsed.plugins[0].installRecord.spec, ' local ');
  assert.equal(m.parseInstalledPluginIndex({...index, version: -1}), null);
  assert.equal(m.parseInstalledPluginIndex({...index, installRecords: {bad: {}}}), null);
  assert.equal(m.parseInstalledPluginIndex({...index, plugins: [{...index.plugins[0], enabled: 'yes'}]}), null);
  assert.deepEqual(m.parseInstalledPluginIndexSqliteRow({revision: 1, index}), parsed);
  assert.deepEqual(globalThis.__sourceInstallSchemaInit, {createPluginInstallRecordSchema: 1, createInstalledPluginIndexSchema: 1});
});
