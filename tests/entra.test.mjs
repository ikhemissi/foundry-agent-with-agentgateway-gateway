import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const template = JSON.parse(execFileSync('az', [
  'bicep', 'build', '--file', fileURLToPath(new URL('../infra/entra.bicep', import.meta.url)), '--stdout',
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
const { gatewayApplication, gatewayPrincipal, promptApplication, promptPrincipal, gatewayApiConfiguration } = template.resources;
const apiTemplate = gatewayApiConfiguration.properties.template;

test('directory infrastructure uses pinned stable Graph types independently of Azure provisioning', async () => {
  const config = JSON.parse(await readFile(new URL('../infra/bicepconfig.json', import.meta.url), 'utf8'));
  assert.equal(config.extensions.microsoftGraphV1, 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0');
  assert.deepEqual(template.imports.microsoftGraphV1, { provider: 'MicrosoftGraph', version: '1.0.0' });
  assert.deepEqual(apiTemplate.imports.microsoftGraphV1, template.imports.microsoftGraphV1);
  assert.equal(gatewayApplication.type, 'Microsoft.Graph/applications@v1.0');
  assert.equal(promptApplication.type, gatewayApplication.type);
  assert.equal(gatewayPrincipal.type, 'Microsoft.Graph/servicePrincipals@v1.0');
  assert.equal(promptPrincipal.type, gatewayPrincipal.type);
  assert.equal(Object.keys(template.resources).length, 5);
  assert.equal(template.$schema, 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#');
});

test('application adoption keys are stable and both service principals reference their existing applications', () => {
  assert.equal(gatewayApplication.properties.uniqueName, "[parameters('gatewayApplicationUniqueName')]");
  assert.equal(promptApplication.properties.uniqueName, "[parameters('promptApplicationUniqueName')]");
  assert.match(template.parameters.gatewayApplicationUniqueName.defaultValue, /subscription\(\).subscriptionId/);
  assert.match(template.parameters.gatewayApplicationUniqueName.defaultValue, /parameters\('environmentName'\)/);
  assert.equal(gatewayPrincipal.properties.appId, "[reference('gatewayApplication').appId]");
  assert.equal(promptPrincipal.properties.appId, "[reference('promptApplication').appId]");
  assert.deepEqual(gatewayPrincipal.dependsOn, ['gatewayApplication']);
  assert.deepEqual(promptPrincipal.dependsOn, ['promptApplication']);
  assert.ok(!template.parameters.includePromptApplication);
  for (const resource of [promptApplication, promptPrincipal]) {
    assert.ok(!Object.hasOwn(resource, 'condition'));
  }
});

test('gateway API configuration preserves prior settings and enables the stable invocation scope and app claim', () => {
  const api = template.variables.gatewayApi;
  for (const value of ["parameters('existingGatewayApi')", "'requestedAccessTokenVersion', 2",
    "'gateway.invoke'", "parameters('gatewayInvokeScopeId')", "'isEnabled', true()"]) {
    assert.ok(api.includes(value), value);
  }
  assert.match(template.parameters.gatewayInvokeScopeId.defaultValue, /guid\(/);
  assert.equal(gatewayApplication.properties.api, "[variables('gatewayApi')]");
  for (const value of ["parameters('existingGatewayOptionalClaims')", "'accessToken'", "'idtyp'"]) {
    assert.ok(gatewayApplication.properties.optionalClaims.includes(value), value);
  }
  assert.equal(gatewayApplication.properties.signInAudience, 'AzureADMyOrg');
});

test('API URI and CLI preauthorization wait for the generated client ID and enabled scope', () => {
  assert.deepEqual(gatewayApiConfiguration.dependsOn, ['gatewayApplication']);
  assert.equal(gatewayApiConfiguration.properties.parameters.applicationClientId.value, "[reference('gatewayApplication').appId]");
  assert.equal(gatewayApiConfiguration.properties.parameters.api.value, "[variables('gatewayApi')]");
  const api = apiTemplate.resources.application.properties;
  assert.equal(api.uniqueName, "[parameters('applicationUniqueName')]");
  assert.ok(api.identifierUris.includes("union(parameters('identifierUris')"));
  assert.ok(api.identifierUris.includes("format('api://{0}', parameters('applicationClientId'))"));
  assert.equal(apiTemplate.variables.cliClientId, '04b07795-8ddb-461a-bbee-02f9e1bf7b46');
  assert.ok(api.api.includes("'preAuthorizedApplications'"));
  assert.ok(api.api.includes("'delegatedPermissionIds'"));
  assert.ok(api.api.includes("variables('existingCli')[0].delegatedPermissionIds"));
  assert.ok(api.api.includes("parameters('invokeScopeId')"));
});

test('Graph templates never manage passwords and output only identity identifiers', () => {
  const content = JSON.stringify(template);
  for (const forbidden of ['passwordCredentials', 'clientSecret', 'addPassword', 'Microsoft.KeyVault']) {
    assert.ok(!content.includes(forbidden), forbidden);
  }
  assert.deepEqual(Object.keys(template.outputs), [
    'gatewayClientId', 'gatewayPrincipalId', 'invokeScopeId', 'promptClientId', 'promptPrincipalId',
  ]);
  for (const output of Object.values(template.outputs)) assert.equal(output.type, 'string');
});
