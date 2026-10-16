import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function configureGatewayEntra({ env, includePrompt = false, run = execFileSync } = {}) {
  for (const name of ['AZURE_ENV_NAME', 'AZURE_RESOURCE_GROUP', 'AZURE_SUBSCRIPTION_ID']) {
    if (!env?.[name]?.trim()) throw new Error(`${name} is required; provision the Azure resources first.`);
  }
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  const az = (...args) => JSON.parse(run('az', [...args, '--output', 'json'], options));
  const applications = [
    { clientId: env.AGENTGATEWAY_ENTRA_CLIENT_ID, suffix: 'agentgateway' },
    { clientId: env.PROMPT_GATEWAY_CLIENT_ID, suffix: 'prompt-gateway' },
  ];
  for (const application of applications) {
    if (application.clientId) {
      application.existing = az('ad', 'app', 'show', '--id', application.clientId);
      if (application.existing.appId !== application.clientId || !application.existing.id) {
        throw new Error(`Entra returned unexpected IDs for ${application.suffix}.`);
      }
    }
    application.uniqueName = application.existing?.uniqueName
      ?? `${env.AZURE_SUBSCRIPTION_ID}-${env.AZURE_ENV_NAME}-${application.suffix}`;
  }
  const [gateway, prompt] = applications;
  const scopes = gateway.existing?.api?.oauth2PermissionScopes?.filter((scope) => scope.value === 'gateway.invoke') ?? [];
  if (scopes.length > 1 || (scopes.length === 1 && !scopes[0].id)) {
    throw new Error('The existing gateway.invoke scope does not have a unique stable ID.');
  }
  for (const application of applications) {
    if (application.existing && !application.existing.uniqueName) {
      run('az', ['rest', '--method', 'PATCH',
        '--url', `https://graph.microsoft.com/v1.0/applications/${application.existing.id}`,
        '--body', JSON.stringify({ uniqueName: application.uniqueName }), '--output', 'none'], options);
    }
  }
  const parameters = {
    environmentName: { value: env.AZURE_ENV_NAME },
    gatewayApplicationUniqueName: { value: gateway.uniqueName },
    promptApplicationUniqueName: { value: prompt.uniqueName },
    includePromptApplication: { value: includePrompt || Boolean(prompt.clientId) },
    existingGatewayApi: { value: gateway.existing?.api ?? {} },
    existingGatewayOptionalClaims: { value: gateway.existing?.optionalClaims ?? {} },
    existingGatewayIdentifierUris: { value: gateway.existing?.identifierUris ?? [] },
    ...(scopes.length ? { gatewayInvokeScopeId: { value: scopes[0].id } } : {}),
  };
  const deployment = az('deployment', 'group', 'create', '--name', 'agentgateway-entra',
    '--resource-group', env.AZURE_RESOURCE_GROUP, '--subscription', env.AZURE_SUBSCRIPTION_ID,
    '--template-file', fileURLToPath(new URL('../infra/entra.bicep', import.meta.url)),
    '--parameters', JSON.stringify(parameters));
  const outputs = deployment.properties?.outputs;
  const clientId = outputs?.gatewayClientId?.value;
  const promptClientId = outputs?.promptClientId?.value;
  const promptPrincipalId = outputs?.promptPrincipalId?.value;
  if (!clientId || (gateway.clientId && clientId !== gateway.clientId)
      || (env.AGENTGATEWAY_ENTRA_PRINCIPAL_ID && outputs?.gatewayPrincipalId?.value !== env.AGENTGATEWAY_ENTRA_PRINCIPAL_ID)
      || (scopes.length && outputs?.invokeScopeId?.value !== scopes[0].id)
      || ((includePrompt || prompt.clientId) && (!promptClientId || !promptPrincipalId))
      || (prompt.clientId && promptClientId !== prompt.clientId)
      || (env.PROMPT_GATEWAY_PRINCIPAL_ID && promptPrincipalId !== env.PROMPT_GATEWAY_PRINCIPAL_ID)) {
    throw new Error('Graph Bicep did not return the expected application and service principal IDs.');
  }
  const mappings = [
    ['AGENTGATEWAY_ENTRA_CLIENT_ID', 'gatewayClientId'],
    ['AGENTGATEWAY_ENTRA_PRINCIPAL_ID', 'gatewayPrincipalId'],
    ['AGENTGATEWAY_INVOKE_SCOPE_ID', 'invokeScopeId'],
    ...((includePrompt || prompt.clientId)
      ? [['PROMPT_GATEWAY_CLIENT_ID', 'promptClientId'], ['PROMPT_GATEWAY_PRINCIPAL_ID', 'promptPrincipalId']] : []),
  ];
  for (const [, output] of mappings) {
    if (!outputs[output]?.value) throw new Error(`Graph Bicep did not return ${output}.`);
  }
  for (const [name, output] of mappings) {
    run('azd', ['env', 'set', name, outputs[output].value], options);
  }
  console.log(`Graph Bicep configured gateway audience ${clientId}${promptClientId ? ' and the prompt OAuth application' : ''}.`);
  return clientId;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== '--include-prompt')) throw new Error('Only --include-prompt is supported.');
    const env = JSON.parse(execFileSync('azd', ['env', 'get-values', '--output', 'json'], { encoding: 'utf8' }));
    configureGatewayEntra({ env, includePrompt: args.includes('--include-prompt') });
  } catch (error) {
    console.error(`Gateway Entra configuration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
