import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const template = JSON.parse(execFileSync('az', [
  'bicep', 'build', '--file', fileURLToPath(new URL('infra/main.bicep', root)), '--stdout',
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
const deployment = (name) => {
  const result = template.resources.find((resource) =>
    resource.type === 'Microsoft.Resources/deployments' && resource.name === name);
  assert.ok(result, `Missing module: ${name}`);
  return result;
};
const moduleTemplate = (name) => deployment(name).properties.template;
const resources = (name, type) => moduleTemplate(name).resources.filter((resource) => resource.type === type);
const single = (name, type) => {
  const found = resources(name, type);
  assert.equal(found.length, 1, `${name}: expected one ${type}`);
  return found[0];
};
const app = single('gateway-container-apps', 'Microsoft.App/containerApps');
const gateway = app.properties.template.containers.find((container) => container.name === 'agentgateway');
const collector = app.properties.template.containers.find((container) => container.name === 'otel-collector');

test('deployment requires OAuth identities and keeps the prompt credential secure', () => {
  for (const forbidden of ['gatewayApiKey', 'agentgateway-api-key', 'apiKeySecretUri', 'hostedGatewayAuthMode']) {
    assert.ok(!JSON.stringify(template).includes(forbidden), forbidden);
  }
  for (const name of ['gatewayEntraClientId', 'promptGatewayClientId', 'promptGatewayPrincipalId', 'promptGatewayClientSecret']) {
    assert.ok(!Object.hasOwn(template.parameters[name], 'defaultValue'), name);
    assert.ok(template.parameters[name].minLength > 0);
  }
  assert.equal(template.parameters.promptGatewayClientSecret.type.toLowerCase(), 'securestring');
  assert.equal(moduleTemplate('consumer-model-connection').parameters.promptGatewayClientSecret.type.toLowerCase(), 'securestring');
  assert.equal(deployment('consumer-model-connection').properties.parameters.promptGatewayClientSecret.value,
    "[parameters('promptGatewayClientSecret')]");
  assert.ok(!JSON.stringify(template.outputs).includes("parameters('promptGatewayClientSecret')"));
});

test('only the source account receives the pinned model deployment', () => {
  const model = single('source-foundry', 'Microsoft.CognitiveServices/accounts/deployments');
  assert.deepEqual(model.properties.model, { format: 'OpenAI', name: '[variables(\'modelName\')]', version: '2026-03-17' });
  assert.equal(moduleTemplate('source-foundry').variables.modelName, 'gpt-5.4-nano');
  assert.equal(model.sku.name, 'GlobalStandard');
  assert.equal(model.sku.capacity, "[parameters('modelCapacity')]");
  assert.equal(model.properties.versionUpgradeOption, 'NoAutoUpgrade');
  assert.equal(template.parameters.modelCapacity.defaultValue, 10);
  assert.equal(template.parameters.modelCapacity.minValue, 1);
  assert.equal(resources('consumer-foundry', 'Microsoft.CognitiveServices/accounts/deployments').length, 0);
  for (const name of ['source-foundry', 'consumer-foundry']) {
    const account = single(name, 'Microsoft.CognitiveServices/accounts');
    const project = single(name, 'Microsoft.CognitiveServices/accounts/projects');
    assert.equal(account.kind, 'AIServices');
    assert.equal(account.properties.disableLocalAuth, true);
    assert.equal(account.properties.allowProjectManagement, true);
    assert.equal(project.identity.type, 'SystemAssigned');
  }
});

test('gateway identity can infer only against the source account', () => {
  const role = resources('source-foundry', 'Microsoft.Authorization/roleAssignments')
    .find((resource) => resource.properties.principalId === "[parameters('gatewayPrincipalId')]");
  assert.ok(role);
  assert.match(role.properties.roleDefinitionId, /5e0bd9bd-7b93-4f28-af87-19fc36ad61bd/);
  assert.equal(role.properties.principalType, 'ServicePrincipal');
  assert.match(role.scope, /Microsoft.CognitiveServices\/accounts/);
  assert.equal(resources('consumer-foundry', 'Microsoft.Authorization/roleAssignments')
    .filter((resource) => resource.properties.principalId === "[parameters('gatewayPrincipalId')]").length, 0);
});

test('vault retains prompt credential storage without gateway or hosted secret-read permissions', () => {
  const vault = single('gateway-key-vault', 'Microsoft.KeyVault/vaults');
  assert.equal(vault.properties.enableRbacAuthorization, true);
  assert.equal(vault.properties.enablePurgeProtection, true);
  assert.equal(vault.properties.enableSoftDelete, true);
  assert.equal(resources('gateway-key-vault', 'Microsoft.KeyVault/vaults/secrets').length, 0);
  const roles = resources('gateway-key-vault', 'Microsoft.Authorization/roleAssignments');
  assert.equal(roles.length, 1);
  assert.match(roles[0].properties.roleDefinitionId, /b86a8fe4-44ce-4948-aee5-eccb2c155cd7/);
  assert.equal(roles[0].properties.principalType, 'User');
});

test('inference is the sole external ingress and uses the tested pinned image', async () => {
  assert.deepEqual(app.properties.configuration.ingress, {
    external: true, allowInsecure: false, targetPort: 4000, transport: 'http',
  });
  assert.equal(app.identity.type, 'UserAssigned');
  assert.equal(gateway.image, "[parameters('gatewayImage')]");
  const gatewayTest = await readFile(new URL('tests/gateway.test.mjs', root), 'utf8');
  assert.ok(gatewayTest.includes(template.parameters.gatewayImage.defaultValue));
  assert.deepEqual(gateway.args, ['-f', '/etc/agentgateway/config.yaml']);
  assert.ok(!gateway.env.some((entry) => entry.secretRef));
  assert.equal(gateway.env.find((entry) => entry.name === 'SOURCE_AZURE_OPENAI_RESOURCE_NAME').value, "[parameters('sourceAccountName')]");
  assert.deepEqual(app.properties.template.scale, { minReplicas: 1, maxReplicas: 1 });
});

test('health probes do not invoke a model or expose the admin listener', () => {
  for (const type of ['Startup', 'Readiness']) {
    const probe = gateway.probes.find((entry) => entry.type === type);
    assert.equal(probe.httpGet.path, '/healthz/ready');
    assert.equal(probe.httpGet.port, 15021);
  }
  const live = gateway.probes.find((entry) => entry.type === 'Liveness');
  assert.deepEqual(live.tcpSocket, { port: 4000 });
  assert.ok(!Object.hasOwn(live, 'httpGet'));
  assert.ok(!gateway.probes.some((probe) => probe.httpGet?.port === 15000));
});

test('both containers mount checked-in configuration with mandatory Entra routes', async () => {
  for (const [secretName, file, container] of [
    ['gateway-config', 'agentgateway/config.yaml', gateway],
    ['otel-config', 'monitoring/otel-collector.yaml', collector],
  ]) {
    const secret = app.properties.configuration.secrets.find((entry) => entry.name === secretName);
    const variable = /^\[variables\('([^']+)'\)\]$/.exec(secret.value);
    const content = variable ? moduleTemplate('gateway-container-apps').variables[variable[1]] : secret.value;
    const source = await readFile(new URL(file, root), 'utf8');
    if (secretName === 'gateway-config') {
      assert.equal(moduleTemplate('gateway-container-apps').variables.baseGatewayConfig, source);
      const overlay = await readFile(new URL('agentgateway/entra.yaml', root), 'utf8');
      assert.equal(moduleTemplate('gateway-container-apps').variables.entraGatewayConfig, overlay);
      assert.ok(content.includes("variables('baseGatewayConfig')"));
      assert.ok(content.includes("variables('entraGatewayConfig')"));
      assert.ok(!content.includes('if('));
      assert.ok(!Object.hasOwn(moduleTemplate('gateway-container-apps').parameters.gatewayEntraClientId, 'defaultValue'));
    } else {
      assert.equal(content, source);
    }
    const mount = container.volumeMounts.find((entry) => entry.volumeName === secretName);
    assert.ok(mount);
    const volume = app.properties.template.volumes.find((entry) => entry.name === mount.volumeName);
    assert.equal(volume.storageType, 'Secret');
    assert.deepEqual(volume.secrets, [{ secretRef: secretName, path: 'config.yaml' }]);
  }
});

test('Entra ingress is tenant- and audience-bound with an explicit identity allowlist', async () => {
  const config = await readFile(new URL('agentgateway/entra.yaml', root), 'utf8');
  assert.ok(config.includes('mode: strict'));
  assert.ok(config.includes('audiences: ["$AGENTGATEWAY_ENTRA_CLIENT_ID"]'));
  assert.ok(config.includes('jwt.oid == "$AGENTGATEWAY_AUTHORIZED_USER_ID"'));
  assert.ok(config.includes('jwt.idtyp == "app"'));
  assert.ok(config.includes('"gateway.invoke" in jwt.scp.split(" ")'));
  assert.ok(!config.includes('passthrough:'));
  assert.equal(gateway.env.find((entry) => entry.name === 'AZURE_TENANT_ID').value, '[tenant().tenantId]');
  assert.equal(gateway.env.find((entry) => entry.name === 'AGENTGATEWAY_ENTRA_CLIENT_ID').value, "[parameters('gatewayEntraClientId')]");
  assert.equal(gateway.env.find((entry) => entry.name === 'AGENTGATEWAY_AUTHORIZED_USER_ID').value, "[parameters('authorizedUserId')]");
});

test('hosted delegation has a separate actor-bound route while prompt OAuth remains app-only', async () => {
  const config = await readFile(new URL('agentgateway/entra.yaml', root), 'utf8');
  const delegated = config.split('  - name: entra-inference')[0];
  assert.ok(delegated.includes('/delegated/v1/chat/completions'));
  assert.ok(delegated.includes('jwt.azp == "$AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID"'));
  assert.ok(delegated.includes('jwt.oid == "$AGENTGATEWAY_AUTHORIZED_USER_ID"'));
  assert.ok(delegated.includes('"gateway.invoke" in jwt.scp.split(" ")'));
  assert.ok(!delegated.includes('jwt.idtyp == "app"'));
  assert.equal(gateway.env.find((entry) => entry.name === 'AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID').value,
    "[parameters('delegatedAgentClientId')]");
  assert.equal(deployment('gateway-container-apps').properties.parameters.delegatedAgentClientId.value,
    "[parameters('hostedAgentPrincipalId')]");
  assert.ok(!template.outputs.AGENTGATEWAY_AUTH_MODE);
  assert.match(template.outputs.AGENTGATEWAY_HOSTED_BASE_URL.value, /\/delegated\/v1/);
  const prompt = config.split('  - name: entra-inference')[1];
  assert.ok(prompt.includes('jwt.oid == "$PROMPT_GATEWAY_PRINCIPAL_ID"'));
  assert.ok(prompt.includes('jwt.azp == "$PROMPT_GATEWAY_CLIENT_ID"'));
  assert.ok(prompt.includes('!has(jwt.scp)'));
});

test('prompt OAuth connection uses Entra client credentials without an API key or user-delegation claim', () => {
  const connection = resources('consumer-model-connection', 'Microsoft.CognitiveServices/accounts/projects/connections')
    .find((resource) => resource.properties.authType === 'OAuth2');
  assert.ok(!Object.hasOwn(connection, 'condition'));
  assert.equal(resources('consumer-model-connection', 'Microsoft.CognitiveServices/accounts/projects/connections').length, 1);
  assert.equal(connection.properties.category, 'ModelGateway');
  assert.match(connection.properties.target, /\/entra\/v1/);
  assert.deepEqual(connection.properties.credentials, {
    clientId: "[parameters('promptGatewayClientId')]",
    clientSecret: "[parameters('promptGatewayClientSecret')]",
  });
  assert.match(connection.properties.tokenUrl, /login\.microsoftonline\.com/);
  assert.match(connection.properties.tokenUrl, /oauth2\/v2\.0\/token/);
  assert.deepEqual(connection.properties.scopes, ["[format('api://{0}/.default', parameters('gatewayEntraClientId'))]"]);
  assert.equal(connection.properties.metadata, "[variables('modelMetadata')]");
  assert.ok(!JSON.stringify(connection).includes('gatewayApiKey'));
  assert.equal(deployment('gateway-container-apps').properties.parameters.promptGatewayPrincipalId.value,
    "[parameters('promptGatewayPrincipalId')]");
  const metadata = moduleTemplate('consumer-model-connection').variables.modelMetadata;
  assert.equal(metadata.deploymentInPath, 'false');
  assert.match(metadata.models, /gpt-5.4-nano/);
});

test('monitoring requires Entra ingestion and sends diagnostics to the shared workspace', () => {
  const insights = single('shared-monitoring', 'Microsoft.Insights/components');
  const workspace = single('shared-monitoring', 'Microsoft.OperationalInsights/workspaces');
  assert.equal(insights.properties.DisableLocalAuth, true);
  assert.equal(workspace.properties.retentionInDays, 30);
  assert.match(insights.properties.WorkspaceResourceId, /Microsoft.OperationalInsights\/workspaces/);
  const role = resources('shared-monitoring', 'Microsoft.Authorization/roleAssignments')
    .find((resource) => resource.properties.principalId === "[parameters('gatewayPrincipalId')]");
  assert.match(role.properties.roleDefinitionId, /3913510d-42f4-4e42-8a64-420c390055eb/);
  for (const name of ['source-foundry', 'consumer-foundry', 'gateway-key-vault', 'gateway-container-apps']) {
    const diagnostics = resources(name, 'Microsoft.Insights/diagnosticSettings');
    assert.ok(diagnostics.length > 0);
    for (const resource of diagnostics) assert.equal(resource.properties.workspaceId, "[parameters('workspaceId')]");
  }
  const environment = single('gateway-container-apps', 'Microsoft.App/managedEnvironments');
  assert.equal(environment.properties.appLogsConfiguration.destination, 'azure-monitor');
  assert.equal(collector.env.find((entry) => entry.name === 'AZURE_CLIENT_ID').value, "[parameters('gatewayClientId')]");
});

test('both projects use their own identity to publish traces and read shared Application Insights', () => {
  for (const name of ['source-foundry', 'consumer-foundry']) {
    const project = single(name, 'Microsoft.CognitiveServices/accounts/projects');
    const connection = single(name, 'Microsoft.CognitiveServices/accounts/projects/connections');
    const projectId = name === 'source-foundry' ? 'source-project' : 'consumer-project';
    assert.ok(project.name.includes(`'${projectId}'`));
    assert.match(deployment(name).properties.parameters.appInsightsName.value,
      /^\[reference\(extensionResourceId\(.+'Microsoft.Resources\/deployments', 'shared-monitoring'\), '[^']+'\)\.outputs\.appInsightsName\.value\]$/);
    assert.equal(connection.apiVersion, '2026-09-01');
    assert.ok(connection.name.includes(`'${projectId}'`));
    assert.ok(connection.name.includes("parameters('appInsightsName')"));
    assert.equal(connection.properties.category, 'AppInsights');
    assert.equal(connection.properties.authType, 'ProjectManagedIdentity');
    assert.equal(connection.properties.isSharedToAll, false);
    assert.equal(connection.properties.target,
      "[resourceId('Microsoft.Insights/components', parameters('appInsightsName'))]");
    assert.deepEqual(connection.properties.metadata, {
      ApiType: 'Azure',
      ResourceId: connection.properties.target,
      ApplicationInsightsConnectionString:
        "[reference(resourceId('Microsoft.Insights/components', parameters('appInsightsName')), '2020-02-02').ConnectionString]",
    });
    assert.ok(!Object.hasOwn(connection.properties, 'credentials'));
    const publishers = resources(name, 'Microsoft.Authorization/roleAssignments')
      .filter((role) => role.properties.roleDefinitionId.includes('3913510d-42f4-4e42-8a64-420c390055eb'));
    assert.equal(publishers.length, 1);
    const publisher = publishers[0];
    assert.equal(publisher.scope, connection.properties.target);
    assert.equal(publisher.properties.principalType, 'ServicePrincipal');
    assert.equal(publisher.properties.principalId,
      `[reference(resourceId('Microsoft.CognitiveServices/accounts/projects', format('foundry-${name === 'source-foundry' ? 'source' : 'consumer'}-{0}', parameters('suffix')), '${projectId}'), '2025-06-01', 'full').identity.principalId]`);
    const readers = resources(name, 'Microsoft.Authorization/roleAssignments')
      .filter((role) => role.properties.roleDefinitionId.includes('43d0d8ad-25c7-4714-9337-8ba259a9fe05'));
    assert.equal(readers.length, 1);
    const reader = readers[0];
    assert.equal(reader.scope, connection.properties.target);
    assert.equal(reader.properties.principalType, 'ServicePrincipal');
    assert.equal(reader.properties.principalId, publisher.properties.principalId);
    assert.ok(connection.dependsOn.some((dependency) =>
      dependency.includes('Microsoft.Authorization/roleAssignments') && dependency.includes("'Monitoring Reader'")));
    assert.ok(connection.dependsOn.some((dependency) =>
      dependency.includes('Microsoft.Authorization/roleAssignments') && dependency.includes('Monitoring Metrics Publisher')));
    assert.ok(deployment(name).dependsOn.some((dependency) => dependency.includes("'shared-monitoring'")));
  }
});

test('deployment ordering waits for identity, monitoring and source model resources', () => {
  const dependencies = deployment('gateway-container-apps').dependsOn.join('\n');
  for (const name of ['gateway-identity', 'shared-monitoring', 'source-foundry']) {
    assert.ok(dependencies.includes(`'${name}'`));
  }
  const connectionDependencies = deployment('consumer-model-connection').dependsOn.join('\n');
  for (const name of ['consumer-foundry', 'gateway-container-apps', 'source-foundry']) {
    assert.ok(connectionDependencies.includes(`'${name}'`));
  }
});

test('azd parameters use process-supplied secrets and explicit demo tags', async () => {
  const parameters = JSON.parse(await readFile(new URL('infra/main.parameters.json', root), 'utf8')).parameters;
  assert.ok(!parameters.gatewayApiKey);
  assert.equal(parameters.promptGatewayClientSecret.value, '${PROMPT_GATEWAY_CLIENT_SECRET}');
  assert.equal(parameters.principalId.value, '${AZURE_PRINCIPAL_ID}');
  assert.deepEqual(parameters.tags.value, { CostControl: 'Ignore', SecurityControl: 'Ignore' });
  assert.deepEqual(template.parameters.location.allowedValues, ['eastus', 'uksouth', 'swedencentral']);
  for (const name of ['AGENTGATEWAY_ENDPOINT', 'AZURE_KEY_VAULT_NAME', 'CONSUMER_MODEL_REFERENCE', 'APPLICATIONINSIGHTS_CONNECTION_STRING']) {
    assert.ok(template.outputs[name], `Missing output ${name}`);
  }
  assert.deepEqual(template.outputs.FOUNDRY_PROJECT_ENDPOINT, template.outputs.AZURE_AI_PROJECT_ENDPOINT);
});

test('bootstrap creates the same vault and monitoring resources without requiring an inference credential', () => {
  const bootstrap = JSON.parse(execFileSync('az', [
    'bicep', 'build', '--file', fileURLToPath(new URL('infra/bootstrap.bicep', root)), '--stdout',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(bootstrap.variables, template.variables);
  const group = bootstrap.resources.find((resource) => resource.type === 'Microsoft.Resources/resourceGroups');
  assert.deepEqual(group, template.resources.find((resource) => resource.type === group.type));
  for (const name of ['gateway-identity', 'shared-monitoring', 'gateway-key-vault', 'resource-group-access']) {
    const module = bootstrap.resources.find((resource) => resource.name === name);
    assert.ok(module);
    assert.deepEqual(module.properties.template, moduleTemplate(name));
    assert.deepEqual(module.properties.parameters, deployment(name).properties.parameters);
  }
  assert.ok(!JSON.stringify(bootstrap).includes('gatewayApiKey'));
});
