import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deployPromptAgent } from '../scripts/deploy-prompt-agent.mjs';
import { grantHostedAgentAccess } from '../scripts/grant-hosted-agent-access.mjs';

const agent = JSON.parse(await readFile(new URL('../agents/ai-tutor-prompt-agent/agent.json', import.meta.url)));
const endpoint = 'https://consumer.services.ai.azure.com/api/projects/consumer-project';
const desired = {
  description: agent.description,
  definition: { kind: agent.kind, model: agent.model, instructions: agent.instructions },
};
const version = { ...desired, version: '2' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('unchanged prompt definitions reuse the existing version', async () => {
  let calls = 0;
  const result = await deployPromptAgent({
    endpoint, agent, token: 'test-token',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, `${endpoint}/agents/${agent.name}?api-version=v1`);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.redirect, 'error');
      return json({ versions: { latest: version } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.changed, false);
  assert.equal(result.version, '2');
});

test('new and changed prompt definitions create and verify the exact model reference', async () => {
  for (const current of [null, { ...version, definition: { ...version.definition, instructions: 'Old' } }]) {
    const requests = [];
    const result = await deployPromptAgent({
      endpoint: `${endpoint}/`, agent, token: 'test-token',
      fetchImpl: async (url, options) => {
        requests.push({ url, ...options });
        if (requests.length === 1) return current ? json({ versions: { latest: current } }) : json({}, 404);
        if (options.method === 'POST') return json(version);
        return json({ versions: { latest: version } });
      },
    });
    assert.equal(result.changed, true);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].url, `${endpoint}/agents/${agent.name}/versions?api-version=v1`);
    assert.deepEqual(JSON.parse(requests[1].body), desired);
  }
});

test('prompt deployment rejects invalid input before making HTTP requests', async () => {
  const fetchImpl = () => assert.fail('Invalid input made a request');
  for (const overrides of [
    { endpoint: '' }, { endpoint: 'http://consumer/api/projects/test' },
    { endpoint: `${endpoint}?secret=bad` }, { endpoint: 'https://user:password@consumer/api/projects/test' },
    { token: '' }, { agent: { ...agent, kind: 'hosted' } },
    { agent: { ...agent, name: '../other' } }, { agent: { ...agent, instructions: ' ' } },
    { agent: { ...agent, model: 'gpt-5.4-nano' } }, { agent: { ...agent, model: 'a/b/c' } },
  ]) {
    await assert.rejects(deployPromptAgent({ endpoint, agent, token: 'test-token', fetchImpl, ...overrides }));
  }
});

test('HTTP errors, non-persistence and mismatching persisted definitions fail deployment', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(deployPromptAgent({
      endpoint, agent, token: 'test-token', fetchImpl: async () => json({ error: 'denied' }, status),
    }), new RegExp(String(status)));
  }
  for (const persisted of [null, { ...version, version: '1' }, { ...version, definition: { ...version.definition, model: 'wrong/model' } }]) {
    let count = 0;
    await assert.rejects(deployPromptAgent({
      endpoint, agent, token: 'test-token',
      fetchImpl: async () => {
        count++;
        if (count === 1) return json({}, 404);
        if (count === 2) return json(version);
        return json({ versions: { latest: persisted } });
      },
    }), /did not persist/);
  }
});

const env = {
  AZURE_SUBSCRIPTION_ID: 'subscription', AZURE_RESOURCE_GROUP: 'rg-test',
  CONSUMER_FOUNDRY_PROJECT_ENDPOINT: endpoint, AZURE_KEY_VAULT_NAME: 'vault',
  APPLICATIONINSIGHTS_NAME: 'insights',
};
const principal = '11111111-1111-1111-1111-111111111111';

test('hosted postdeploy grants access to the returned agent identity without reading any secret', () => {
  const commands = [];
  grantHostedAgentAccess({ env, run: (command, args) => {
    assert.equal(command, 'az');
    commands.push(args);
    return commands.length === 1 ? `${principal}\n` : '';
  } });
  assert.equal(commands.length, 2);
  assert.ok(commands[0].includes('versions.latest.instance_identity.principal_id'));
  assert.ok(commands[1].includes(`agentPrincipalId=${principal}`));
  assert.ok(commands[1].includes('keyVaultName=vault'));
  assert.ok(commands[1].includes('appInsightsName=insights'));
  assert.ok(!commands.flat().includes('get-secret'));
});

test('hosted access hook fails on missing configuration, invalid identity and CLI errors', () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => grantHostedAgentAccess({ env: { ...env, [name]: '' } }), new RegExp(name));
  }
  for (const identity of ['', 'null', 'not-a-guid']) {
    let calls = 0;
    assert.throws(() => grantHostedAgentAccess({ env, run: () => {
      calls++;
      assert.equal(calls, 1);
      return identity;
    } }), /principal ID/);
  }
  assert.throws(() => grantHostedAgentAccess({ env, run: () => { throw new Error('CLI failure'); } }), /CLI failure/);
});

test('hosted access Bicep grants only secret read and telemetry publishing', () => {
  const template = JSON.parse(execFileSync('az', [
    'bicep', 'build', '--file',
    fileURLToPath(new URL('../infra/modules/hosted-agent.bicep', import.meta.url)), '--stdout',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(template.resources.length, 2);
  const [secret, telemetry] = template.resources;
  assert.match(secret.scope, /Microsoft.KeyVault\/vaults\/secrets/);
  assert.match(secret.scope, /agentgateway-api-key/);
  assert.match(secret.properties.roleDefinitionId, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.match(telemetry.properties.roleDefinitionId, /3913510d-42f4-4e42-8a64-420c390055eb/);
  for (const resource of template.resources) {
    assert.equal(resource.type, 'Microsoft.Authorization/roleAssignments');
    assert.equal(resource.properties.principalId, "[parameters('agentPrincipalId')]");
  }
});
