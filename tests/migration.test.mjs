import assert from 'node:assert/strict';
import test from 'node:test';
import { removeLegacyGatewayKey } from '../scripts/remove-legacy-gateway-key.mjs';

const env = {
  AZURE_SUBSCRIPTION_ID: 'subscription', AZURE_RESOURCE_GROUP: 'rg-test', AZURE_KEY_VAULT_NAME: 'vault',
  AGENTGATEWAY_CONTAINER_APP_NAME: 'gateway', AGENTGATEWAY_ENDPOINT: 'https://gateway.example',
  CONSUMER_FOUNDRY_NAME: 'consumer', CONSUMER_FOUNDRY_PROJECT_ENDPOINT: 'https://consumer.example/api/projects/project',
};
const scope = '/subscriptions/subscription/resourceGroups/rg-test/providers/Microsoft.KeyVault/vaults/vault/secrets/agentgateway-api-key';
const role = {
  id: `${scope}/providers/Microsoft.Authorization/roleAssignments/old-reader`, scope,
  roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6',
};

function fixture(overrides = {}) {
  const writes = [];
  const values = {
    connection: { properties: { authType: 'OAuth2', target: 'https://gateway.example/entra/v1' } },
    agent: { versions: { latest: { status: 'active', definition: {
      environment_variables: { AGENTGATEWAY_BASE_URL: 'https://gateway.example/delegated/v1' },
    } } } },
    revisions: [{ properties: { active: true, template: { containers: [{ name: 'agentgateway', env: [] }] } } }],
    roles: [role, { ...role, id: 'unrelated', scope: '/other-scope' }],
    secrets: [{ name: 'agentgateway-api-key' }, { name: 'agentgateway-prompt-client-secret' }],
    app: { properties: { configuration: { secrets: [{ name: 'agentgateway-api-key' }] } } },
    ...overrides,
  };
  const run = (command, args) => {
    assert.equal(command, 'az');
    if (args.includes('delete') || args.includes('remove')) {
      writes.push(args);
      if (!overrides.ignoreWrites) {
        if (args[0] === 'containerapp') values.app.properties.configuration.secrets = [];
        if (args[0] === 'role') values.roles = values.roles.filter((entry) => entry.id !== args[args.indexOf('--ids') + 1]);
        if (args[0] === 'keyvault') values.secrets = values.secrets.filter((entry) => entry.name !== 'agentgateway-api-key');
      }
      return '';
    }
    if (args[0] === 'rest') return JSON.stringify(args.some((arg) => arg.includes('/connections/'))
      ? values.connection : values.agent);
    if (args.includes('revision')) return JSON.stringify(values.revisions);
    if (args.includes('assignment')) return JSON.stringify(values.roles);
    if (args[0] === 'keyvault') return JSON.stringify(values.secrets);
    return JSON.stringify(values.app);
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://gateway.example/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    return new Response('', { status: overrides.status ?? 404 });
  };
  return { run, fetchImpl, writes };
}

test('legacy-key cleanup previews by default and deletes only the obsolete secret and exact-scope readers', async () => {
  for (const apply of [false, true]) {
    const f = fixture();
    const plan = await removeLegacyGatewayKey({ env, apply, ...f });
    assert.deepEqual(plan, { roleAssignmentIds: [role.id], removeVaultSecret: true, removeAppSecret: true });
    assert.equal(f.writes.length, apply ? 3 : 0);
    assert.ok(!JSON.stringify(f.writes).includes('agentgateway-prompt-client-secret'));
    if (apply) {
      assert.ok(f.writes[1].includes(role.id));
      assert.ok(f.writes[2].includes('agentgateway-api-key'));
      assert.ok(!f.writes.some((args) => args.includes('purge')));
    }
  }
});

test('legacy cleanup is idempotent when obsolete resources have already gone', async () => {
  const f = fixture({ roles: [], secrets: [], app: { properties: { configuration: { secrets: [] } } } });
  const plan = await removeLegacyGatewayKey({ env, apply: true, ...f });
  assert.deepEqual(plan, { roleAssignmentIds: [], removeVaultSecret: false, removeAppSecret: false });
  assert.deepEqual(f.writes, []);
});

test('legacy cleanup refuses remaining API-key and app-only dependencies before deleting anything', async () => {
  for (const invalid of [
    { connection: { properties: { authType: 'ApiKey' } } },
    { agent: { versions: { latest: { status: 'active', definition: {
      environment_variables: { AGENTGATEWAY_BASE_URL: 'https://gateway.example/entra/v1' },
    } } } } },
    { revisions: [] },
    { revisions: [{ properties: { active: true } }] },
    { revisions: [{ properties: { active: true, template: {
      containers: [{ name: 'agentgateway', env: [{ name: 'AGENTGATEWAY_API_KEY', secretRef: 'agentgateway-api-key' }] }],
    } } }] },
    { status: 401 },
    { status: 200 },
  ]) {
    const f = fixture(invalid);
    await assert.rejects(removeLegacyGatewayKey({ env, apply: true, ...f }), /before cleanup|still present/);
    assert.deepEqual(f.writes, []);
  }
});

test('legacy cleanup validates configuration and propagates command failures', async () => {
  for (const name of Object.keys(env)) {
    await assert.rejects(removeLegacyGatewayKey({ env: { ...env, [name]: '' } }), new RegExp(name));
  }
  const f = fixture();
  await assert.rejects(removeLegacyGatewayKey({ env: { ...env, AGENTGATEWAY_ENDPOINT: 'http://gateway.example' }, ...f }), /HTTPS/);
  await assert.rejects(removeLegacyGatewayKey({
    env, apply: true, run: () => { throw new Error('Azure denied the operation'); },
  }), /Azure denied/);
});

test('legacy cleanup rejects incomplete metadata before deleting anything', async () => {
  for (const invalid of [
    { roles: {} }, { secrets: {} }, { app: {} },
    { roles: [{ ...role, id: undefined }] },
  ]) {
    const f = fixture(invalid);
    await assert.rejects(removeLegacyGatewayKey({ env, apply: true, ...f }), /metadata|assignment ID/);
    assert.deepEqual(f.writes, []);
  }
});

test('legacy cleanup verifies that deletions persisted', async () => {
  const f = fixture({ ignoreWrites: true });
  await assert.rejects(removeLegacyGatewayKey({ env, apply: true, ...f }), /remain after cleanup/);
  assert.equal(f.writes.length, 3);
});
