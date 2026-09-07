import { test } from 'node:test';
import assert from 'node:assert/strict';

const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const diagnostics = new URL(`../packages/openclaw-core/dist/${prefix}diagnostics.mjs`, import.meta.url);

test('DM policy and SecretRef consumers preserve validation without loading the broad config schema', async () => {
  const m = await import(diagnostics);
  const checkDeferred = () => assert.deepEqual(globalThis.__sourceCoreInit ?? {}, {});
  checkDeferred();
  for (const [policy, allowFrom, expected] of [
    ['open', undefined, 'open_requires_wildcard'],
    ['open', [' * '], null],
    ['allowlist', [' '], 'allowlist_requires_entries'],
    ['allowlist', [42], null],
    ['disabled', [], null], ['pairing', [], null],
  ]) assert.equal(m.evaluateDmPolicyAllowFromDependency({policy, allowFrom}), expected);

  for (const [source, id] of [['env', 'TEST_KEY'], ['store', 'TEST_KEY'], ['file', '/service/token'], ['exec', 'service/token']]) {
    const ref = {source, provider: 'default', id};
    assert.deepEqual(m.SecretRefSchema.parse(ref), ref);
    assert.equal(m.SecretRefSchema.safeParse({...ref, extra: true}).success, false);
    assert.equal(m.SecretRefSchema.safeParse({...ref, provider: 'INVALID!'}).success, false);
  }
  for (const ref of [
    {source: 'unknown', provider: 'default', id: 'TEST_KEY'},
    {source: 'env', provider: 'default', id: 'lowercase'},
    {source: 'file', provider: 'default', id: 'relative'},
  ]) assert.equal(m.SecretRefSchema.safeParse(ref).success, false);
  const schema = m.SecretRefSchema.toJSONSchema({io: 'input', target: 'draft-07', unrepresentable: 'any'});
  assert.equal(schema.oneOf.length, 4);
  assert.ok(schema.oneOf.every(variant => variant.additionalProperties === false));
  const custom = {type: 'object', properties: {token: {type: 'string'}}};
  assert.equal(m.widenOfficialExternalChannelSecretSchema({channelId: 'test-custom-channel', schema: custom}), custom);
  const qqbot = {
    type: 'object',
    properties: {
      clientSecret: {type: 'string'},
      accounts: {
        type: 'object',
        additionalProperties: {type: 'object', properties: {clientSecret: {type: 'string'}}},
      },
    },
    allOf: [{description: 'Existing plugin clause'}],
  };
  const original = structuredClone(qqbot);
  const widened = m.widenOfficialExternalChannelSecretSchema({channelId: 'qqbot', schema: qqbot});
  const channelSecret = widened.properties.clientSecret;
  const accountSecret = widened.properties.accounts.additionalProperties.properties.clientSecret;
  assert.deepEqual(channelSecret.anyOf, [{type: 'string'}, schema]);
  assert.deepEqual(accountSecret.anyOf, [{type: 'string'}, schema]);
  assert.deepEqual(widened.allOf[0], original.allOf[0]);
  assert.ok(widened.allOf.length > original.allOf.length);
  assert.deepEqual(qqbot, original);
  const pristine = structuredClone(widened);
  channelSecret.anyOf[1].oneOf[0].properties.id.pattern = 'changed-by-caller';
  assert.deepEqual(accountSecret.anyOf[1], schema);
  accountSecret.anyOf[0].type = 'number';
  widened.allOf[1].description = 'changed-by-caller';
  assert.deepEqual(qqbot, original);
  assert.deepEqual(
    m.widenOfficialExternalChannelSecretSchema({channelId: 'qqbot', schema: qqbot}),
    pristine,
  );
  checkDeferred();
});
