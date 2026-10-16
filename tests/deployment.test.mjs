import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deployPromptAgent } from '../scripts/deploy-prompt-agent.mjs';
import { grantHostedAgentAccess } from '../scripts/grant-hosted-agent-access.mjs';
import { configureGatewayEntra } from '../scripts/configure-gateway-entra.mjs';
import { configurePromptGatewayEntra } from '../scripts/configure-prompt-gateway-entra.mjs';

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

test('Entra postdeploy authorizes the actual agent identity and removes its key-read permission', () => {
  for (const authMode of ['entra', 'entra_delegated']) {
    const commands = [];
    const entraEnv = {
      ...env, AZURE_ENV_NAME: 'test', AGENTGATEWAY_AUTH_MODE: authMode,
      AGENTGATEWAY_CONTAINER_APP_NAME: 'gateway', AGENTGATEWAY_AUTHORIZED_USER_ID: principal,
      PROMPT_GATEWAY_PRINCIPAL_ID: '22222222-2222-2222-2222-222222222222',
    };
    grantHostedAgentAccess({ env: entraEnv, run: (command, args) => {
      commands.push([command, ...args]);
      return commands.length === 1 ? `${principal}\n` : '';
    } });
    assert.ok(commands[1].includes('grantSecretRead=false'));
    const update = commands.find((args) => args.includes('--set-env-vars'));
    assert.equal(update[update.indexOf('--container-name') + 1], 'agentgateway');
    assert.ok(update.includes(`AGENTGATEWAY_ALLOWED_PRINCIPAL_IDS=${JSON.stringify([principal, principal, entraEnv.PROMPT_GATEWAY_PRINCIPAL_ID])}`));
    assert.ok(update.includes(`AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID=${principal}`));
    assert.ok(commands.some((args) => args[0] === 'azd' && args.includes('HOSTED_AGENT_PRINCIPAL_ID')));
    const revoke = commands.at(-1);
    assert.deepEqual(revoke.slice(0, 4), ['az', 'role', 'assignment', 'delete']);
    assert.ok(revoke.includes(principal));
    assert.ok(revoke.some((value) => value.endsWith('/secrets/agentgateway-api-key')));
  }
  assert.throws(() => grantHostedAgentAccess({
    env: { ...env, AGENTGATEWAY_AUTH_MODE: 'invalid' },
  }), /AGENTGATEWAY_AUTH_MODE/);
});

const promptEnv = {
  AZURE_ENV_NAME: 'test', AGENTGATEWAY_ENTRA_CLIENT_ID: principal,
  AZURE_KEY_VAULT_NAME: 'vault', PROMPT_GATEWAY_CLIENT_ID: principal,
  PROMPT_GATEWAY_PRINCIPAL_ID: 'prompt-principal',
};

const promptIdentity = (args) => {
  if (!args.includes('show')) return undefined;
  return JSON.stringify(args.includes('sp')
    ? { appId: principal, id: 'prompt-principal' }
    : { appId: principal, id: 'app-object' });
};

test('prompt OAuth setup stores a new credential over HTTPS, never in arguments or azd state', async () => {
  const calls = [];
  const secret = 'synthetic-prompt-client-secret';
  let store;
  const result = await configurePromptGatewayEntra({
    env: promptEnv, now: new Date('2026-10-16T00:00:00Z'),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://vault.vault.azure.net/secrets/agentgateway-prompt-client-secret?api-version=7.5');
      assert.equal(options.method, 'PUT');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer vault-token');
      store = JSON.parse(options.body);
      return json({});
    },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('show')) return promptIdentity(args);
      if (args.includes('secret') && args.includes('list')) return '[]';
      if (args.includes('POST')) return JSON.stringify({ secretText: secret, keyId: 'password-key' });
      if (args.includes('get-access-token')) return JSON.stringify({ accessToken: 'vault-token' });
      return '';
    },
  });
  assert.deepEqual(result, { clientId: principal, principalId: 'prompt-principal' });
  assert.equal(store.value, secret);
  assert.equal(store.tags.clientId, principal);
  assert.equal(store.attributes.exp, Date.parse('2027-10-16T00:00:00Z') / 1000);
  assert.ok(!calls.some((call) => call.args.some((argument) => argument.includes(secret))));
  assert.ok(!calls.some((call) => call.command === 'azd'));
  assert.ok(!calls.some((call) => call.args.includes('create')));
});

test('prompt credential setup requires provisioned matching application and principal IDs', async () => {
  for (const name of ['PROMPT_GATEWAY_CLIENT_ID', 'PROMPT_GATEWAY_PRINCIPAL_ID']) {
    await assert.rejects(() => configurePromptGatewayEntra({
      env: { ...promptEnv, [name]: '' },
      run: () => assert.fail('Missing Graph Bicep outputs must not execute a command'),
    }), new RegExp(name));
  }
  for (const mismatch of ['app', 'sp']) {
    await assert.rejects(() => configurePromptGatewayEntra({
      env: promptEnv,
      run: (command, args) => {
        assert.ok(args.includes('show'), 'Mismatched identities must not create a credential');
        return args.includes(mismatch) ? JSON.stringify({ id: 'wrong', appId: 'wrong' }) : promptIdentity(args);
      },
    }), /do not match the Graph Bicep outputs/);
  }
});

test('prompt OAuth setup propagates CLI failures and revokes a new password if storage fails', async () => {
  await assert.rejects(() => configurePromptGatewayEntra({
    env: promptEnv, run: () => { throw new Error('CLI unavailable'); },
  }), /CLI unavailable/);
  let revoked;
  await assert.rejects(() => configurePromptGatewayEntra({
    env: promptEnv,
    fetchImpl: async () => json({}, 403),
    run: (command, args) => {
      if (args.includes('show')) return promptIdentity(args);
      if (args.includes('secret') && args.includes('list')) return '[]';
      if (args.some((value) => value.endsWith('/addPassword'))) {
        return JSON.stringify({ secretText: 'synthetic-secret', keyId: 'password-key' });
      }
      if (args.includes('get-access-token')) return JSON.stringify({ accessToken: 'vault-token' });
      if (args.some((value) => value.endsWith('/removePassword'))) {
        revoked = JSON.parse(args[args.indexOf('--body') + 1]).keyId;
      }
      return '';
    },
  }), /Key Vault credential storage failed \(HTTP 403\)/);
  assert.equal(revoked, 'password-key');
});

test('project preprovision validates prompt OAuth inputs without requiring them in legacy mode', async () => {
  const yaml = await readFile(new URL('../azure.yaml', import.meta.url), 'utf8');
  const rootHooks = yaml.split('\nhooks:\n')[1];
  const script = rootHooks.split('    run: |\n')[1].split('\n  postprovision:')[0]
    .replace(/^      /gm, '');
  const env = {
    PROMPT_GATEWAY_CLIENT_ID: principal, PROMPT_GATEWAY_PRINCIPAL_ID: principal,
    AGENTGATEWAY_ENTRA_CLIENT_ID: principal, PROMPT_GATEWAY_CLIENT_SECRET: 'synthetic-secret',
  };
  const execute = (values) => execFileSync('/bin/sh', ['-c', script], { env: values, stdio: 'pipe' });
  execute({});
  execute(env);
  for (const name of ['PROMPT_GATEWAY_PRINCIPAL_ID', 'AGENTGATEWAY_ENTRA_CLIENT_ID', 'PROMPT_GATEWAY_CLIENT_SECRET']) {
    assert.throws(() => execute({ ...env, [name]: '' }), new RegExp(name));
  }
});

test('prompt OAuth setup reuses a valid stored credential and rejects invalid state explicitly', async () => {
  for (const name of ['AZURE_KEY_VAULT_NAME', 'PROMPT_GATEWAY_CLIENT_ID', 'PROMPT_GATEWAY_PRINCIPAL_ID']) {
    await assert.rejects(() => configurePromptGatewayEntra({ env: { ...promptEnv, [name]: '' } }), new RegExp(name));
  }
  for (const invalid of [undefined, 'expired', 'disabled', 'other-client', 'missing-expiry', 'invalid-expiry']) {
    let writes = 0;
    const action = () => configurePromptGatewayEntra({
      env: promptEnv, now: new Date('2026-10-16T00:00:00Z'),
      run: (command, args) => {
        if (args.includes('show')) return promptIdentity(args);
        if (args.includes('secret') && args.includes('list')) return JSON.stringify([{
          tags: { clientId: invalid === 'other-client' ? 'other' : principal },
          attributes: {
            enabled: invalid !== 'disabled',
            expires: invalid === 'missing-expiry' ? undefined : invalid === 'invalid-expiry' ? 'invalid'
              : invalid === 'expired' ? '2025-01-01' : '2027-01-01',
          },
        }]);
        if (args.includes('POST') || args.includes('--file')) writes++;
        return '';
      },
    });
    if (invalid) await assert.rejects(action, /Rotate it explicitly/);
    else await action();
    assert.equal(writes, 0);
  }
});

const entraEnv = { AZURE_ENV_NAME: 'test', AZURE_RESOURCE_GROUP: 'rg-test', AZURE_SUBSCRIPTION_ID: principal };
const entraOutputs = {
  gatewayClientId: { value: principal },
  gatewayPrincipalId: { value: 'gateway-principal' },
  invokeScopeId: { value: 'scope-id' },
  promptClientId: { value: 'prompt-client' },
  promptPrincipalId: { value: 'prompt-principal' },
};

test('Entra deployment adopts existing identities and passes the stable manifest to Graph Bicep', () => {
  const existingScope = { id: 'scope-id', value: 'gateway.invoke', isEnabled: true };
  const api = {
    oauth2PermissionScopes: [existingScope, { id: 'other-scope', value: 'other' }],
    preAuthorizedApplications: [{ appId: 'other-client', delegatedPermissionIds: ['other-scope'] }],
  };
  const calls = [];
  const result = configureGatewayEntra({
    env: {
      ...entraEnv, AGENTGATEWAY_ENTRA_CLIENT_ID: principal,
      PROMPT_GATEWAY_CLIENT_ID: 'prompt-client', PROMPT_GATEWAY_PRINCIPAL_ID: 'prompt-principal',
    },
    run: (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('show')) return JSON.stringify(args.includes('prompt-client')
        ? { appId: 'prompt-client', id: 'prompt-object' }
        : { appId: principal, id: 'gateway-object', api, identifierUris: ['api://existing'],
          optionalClaims: { idToken: [{ name: 'email' }] } });
      if (args.includes('deployment')) return JSON.stringify({ properties: { outputs: entraOutputs } });
      return '';
    },
  });
  assert.equal(result, principal);
  assert.ok(!calls.some((args) => args.includes('ad') && args.includes('create')));
  const patches = calls.filter((args) => args.includes('PATCH'));
  assert.equal(patches.length, 2);
  for (const patch of patches) assert.deepEqual(Object.keys(JSON.parse(patch[patch.indexOf('--body') + 1])), ['uniqueName']);
  const deployment = calls.find((args) => args.includes('deployment'));
  assert.ok(deployment.some((value) => value.endsWith('/infra/entra.bicep')));
  const parameters = JSON.parse(deployment[deployment.indexOf('--parameters') + 1]);
  assert.equal(parameters.gatewayInvokeScopeId.value, existingScope.id);
  assert.deepEqual(parameters.existingGatewayApi.value, api);
  assert.deepEqual(parameters.existingGatewayIdentifierUris.value, ['api://existing']);
  assert.deepEqual(parameters.existingGatewayOptionalClaims.value, { idToken: [{ name: 'email' }] });
  assert.equal(parameters.includePromptApplication.value, true);
  assert.equal(calls.filter((args) => args[0] === 'azd').length, 5);
});

test('Entra deployment is declarative for fresh environments and does not enable prompt OAuth implicitly', () => {
  for (const includePrompt of [false, true]) {
    const calls = [];
    configureGatewayEntra({
      env: entraEnv, includePrompt,
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === 'az') {
          assert.ok(args.includes('deployment'), 'Fresh registrations must be created only by Bicep');
          const parameters = JSON.parse(args[args.indexOf('--parameters') + 1]);
          assert.equal(parameters.includePromptApplication.value, includePrompt);
          assert.equal(parameters.gatewayApplicationUniqueName.value, `${principal}-test-agentgateway`);
          assert.ok(!Object.hasOwn(parameters, 'gatewayInvokeScopeId'));
          return JSON.stringify({ properties: { outputs: {
            ...entraOutputs,
            ...(!includePrompt ? { promptClientId: { value: '' }, promptPrincipalId: { value: '' } } : {}),
          } } });
        }
        return '';
      },
    });
    assert.equal(calls.filter((args) => args[0] === 'azd').length, includePrompt ? 5 : 3);
  }
});

test('Entra redeployment keeps immutable adoption keys and refuses changed identity outputs', () => {
  for (const changed of [false, true]) {
    const calls = [];
    const action = () => configureGatewayEntra({
      env: { ...entraEnv, AGENTGATEWAY_ENTRA_CLIENT_ID: principal },
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args.includes('show')) return JSON.stringify({ appId: principal, id: 'object', uniqueName: 'existing-key' });
        if (args.includes('deployment')) {
          const parameters = JSON.parse(args[args.indexOf('--parameters') + 1]);
          assert.equal(parameters.gatewayApplicationUniqueName.value, 'existing-key');
          return JSON.stringify({ properties: { outputs: {
            ...entraOutputs, gatewayClientId: { value: changed ? 'wrong' : principal },
          } } });
        }
        return '';
      },
    });
    if (changed) assert.throws(action, /expected application/);
    else action();
    assert.ok(!calls.some((args) => args.includes('PATCH')));
    if (changed) assert.ok(!calls.some((args) => args[0] === 'azd'));
  }
  for (const name of Object.keys(entraEnv)) {
    assert.throws(() => configureGatewayEntra({ env: { ...entraEnv, [name]: '' } }), new RegExp(name));
  }
  assert.throws(() => configureGatewayEntra({
    env: entraEnv, run: () => { throw new Error('Deployment failed'); },
  }), /Deployment failed/);
});

test('Entra deployment validates every required output before persisting environment values', () => {
  for (const name of Object.keys(entraOutputs)) {
    const outputs = { ...entraOutputs };
    delete outputs[name];
    assert.throws(() => configureGatewayEntra({
      env: entraEnv, includePrompt: true,
      run: (command) => {
        assert.equal(command, 'az', 'Incomplete deployment outputs must not be persisted in azd');
        return JSON.stringify({ properties: { outputs } });
      },
    }), /Graph Bicep did not return/);
  }
});

test('Entra adoption rejects changed application IDs and ambiguous scope IDs before any write', () => {
  for (const invalid of ['application', 'scope']) {
    assert.throws(() => configureGatewayEntra({
      env: { ...entraEnv, AGENTGATEWAY_ENTRA_CLIENT_ID: principal },
      run: (command, args) => {
        assert.ok(args.includes('show'), 'Invalid adoption input must not change Graph or azd');
        return JSON.stringify({
          appId: invalid === 'application' ? 'other' : principal, id: 'object',
          api: { oauth2PermissionScopes: [
            { id: 'first', value: 'gateway.invoke' }, { id: 'second', value: 'gateway.invoke' },
          ] },
        });
      },
    }), invalid === 'application' ? /unexpected IDs/ : /unique stable ID/);
  }
});

test('hosted access Bicep grants only secret read and telemetry publishing', () => {
  const template = JSON.parse(execFileSync('az', [
    'bicep', 'build', '--file',
    fileURLToPath(new URL('../infra/modules/hosted-agent.bicep', import.meta.url)), '--stdout',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(template.resources.length, 2);
  const [secret, telemetry] = template.resources;
  assert.equal(template.parameters.grantSecretRead.defaultValue, true);
  assert.equal(secret.condition, "[parameters('grantSecretRead')]");
  assert.match(secret.scope, /Microsoft.KeyVault\/vaults\/secrets/);
  assert.match(secret.scope, /agentgateway-api-key/);
  assert.match(secret.properties.roleDefinitionId, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.match(telemetry.properties.roleDefinitionId, /3913510d-42f4-4e42-8a64-420c390055eb/);
  for (const resource of template.resources) {
    assert.equal(resource.type, 'Microsoft.Authorization/roleAssignments');
    assert.equal(resource.properties.principalId, "[parameters('agentPrincipalId')]");
  }
});
