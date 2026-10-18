import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { deployDemo, hostingParameters } from '../scripts/deploy-demo.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const env = {
  AZURE_SUBSCRIPTION_ID: id(1), AZURE_TENANT_ID: id(2), AZURE_PRINCIPAL_ID: id(3),
  DEMO_SPA_CLIENT_ID: id(4), DEMO_BLUEPRINT_CLIENT_ID: id(5), HOSTED_AGENT_PRINCIPAL_ID: id(6),
  AGENTGATEWAY_ENTRA_CLIENT_ID: id(7), AZURE_ENV_NAME: 'test', AZURE_RESOURCE_GROUP: 'rg-test',
  AGENTGATEWAY_CONTAINER_APP_NAME: 'gateway',
  CONSUMER_FOUNDRY_PROJECT_ENDPOINT: 'https://consumer.services.ai.azure.com/api/projects/test',
  AGENTGATEWAY_ENDPOINT: 'https://gateway.test.azurecontainerapps.io',
};
const environment = { id: `/subscriptions/${id(1)}/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/existing`,
  name: 'existing', location: 'uksouth', tags: { CostControl: 'Ignore' } };
const outputs = { appName: 'demo', origin: 'https://demo.test.azurecontainerapps.io',
  managedIdentityClientId: id(8), managedIdentityPrincipalId: id(9),
  registryName: 'registry', registryServer: 'registry.azurecr.io' };
function fixture() {
  const commands = [];
  const run = (command, args, options) => {
    commands.push({ command, args, options });
    if (command === 'azd') return args.includes('get-values') ? JSON.stringify(env) : '';
    if (args[0] === 'account') return JSON.stringify({ tenantId: id(2) });
    if (args[0] === 'containerapp') return JSON.stringify({ environment: environment.id });
    if (args[0] === 'resource') return JSON.stringify(environment);
    if (args[0] === 'deployment') return JSON.stringify({ properties: {
      outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { value }])) } });
    if (args[1] === 'build') return '';
    if (args[1] === 'repository') return `sha256:${'a'.repeat(64)}`;
    throw new Error(`Unexpected command ${command} ${args}`);
  };
  return { commands, run };
}
test('hosting preview is read-only and targets the existing azd environment', async () => {
  const state = fixture();
  const result = await deployDemo({ run: state.run, configure() { throw new Error('Preview cannot write Entra'); } });
  assert.equal(result.managedEnvironmentName, 'existing');
  assert.ok(state.commands.every(({ args }) => !args.includes('create') && !args.includes('build') && !args.includes('set')));
  assert.deepEqual(result.resourceTags, environment.tags);
  assert.throws(() => hostingParameters(env, { ...environment, id: environment.id.replace('rg-test', 'another') }), /selected azd/);
});
test('hosting apply federates dedicated identity, uses restricted build context and pins the image digest', async () => {
  const state = fixture();
  let configured = false;
  await deployDemo({ apply: true, run: state.run, configure(input) {
    configured = true;
    assert.equal(input.env.DEMO_MANAGED_IDENTITY_PRINCIPAL_ID, id(9));
    assert.equal(input.env.DEMO_ORIGIN, outputs.origin);
    assert.equal(input.persistOrigin, false);
    assert.equal(input.certificate, undefined);
  }, fetchImpl: async () => Response.json({ origin: outputs.origin, clientId: id(4) }) });
  assert.equal(configured, true);
  const build = state.commands.find(({ args }) => args[1] === 'build');
  assert.ok(build.options.cwd.endsWith('/apps/demo'));
  assert.equal(build.args.at(-1), '.');
  const deployments = state.commands.filter(({ args }) => args[0] === 'deployment');
  assert.equal(deployments.length, 2);
  const parameters = JSON.parse(deployments[1].args[deployments[1].args.indexOf('--parameters') + 1]);
  assert.equal(parameters.deployApp.value, true);
  assert.equal(parameters.image.value, `registry.azurecr.io/demo@sha256:${'a'.repeat(64)}`);
  assert.equal(state.commands.some(({ args }) => args.includes('DEMO_ORIGIN')), false);
});
test('hosting fails explicitly when the deployed configuration is not ready', async () => {
  await assert.rejects(deployDemo({ apply: true, run: fixture().run, configure() {},
    fetchImpl: async () => new Response('', { status: 503 }) }), /readiness check failed/);
});
test('container packaging and hosting never ship private keys or enable registry passwords', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const dockerignore = read('apps/demo/.dockerignore');
  assert.equal(dockerignore.split('\n')[0], '*');
  assert.doesNotMatch(dockerignore, /^!(?:\.env|\.certificates)/m);
  assert.match(read('apps/demo/Dockerfile'), /USER node/);
  const bicep = read('infra/demo-hosting.bicep');
  assert.match(bicep, /adminUserEnabled: false/);
  assert.match(bicep, /'managed-identity'/);
  assert.match(bicep, /minReplicas: 0/);
  assert.match(bicep, /maxReplicas: 1/);
  assert.doesNotMatch(bicep, /DEMO_PRIVATE_KEY_PATH|DEMO_CERTIFICATE_PATH|passwordSecretRef/);
});
