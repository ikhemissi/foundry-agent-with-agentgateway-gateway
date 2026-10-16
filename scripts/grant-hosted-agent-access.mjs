import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function grantHostedAgentAccess({ env = process.env, run = execFileSync } = {}) {
  const authMode = env.AGENTGATEWAY_AUTH_MODE || 'api_key';
  if (!['api_key', 'entra', 'entra_delegated'].includes(authMode)) throw new Error('Invalid AGENTGATEWAY_AUTH_MODE.');
  const entra = authMode !== 'api_key';
  for (const name of ['AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'CONSUMER_FOUNDRY_PROJECT_ENDPOINT',
    'AZURE_KEY_VAULT_NAME', 'APPLICATIONINSIGHTS_NAME', ...(entra
      ? ['AZURE_ENV_NAME', 'AGENTGATEWAY_CONTAINER_APP_NAME', 'AGENTGATEWAY_AUTHORIZED_USER_ID'] : [])]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required for hosted-agent access.`);
  }
  const endpoint = new URL(env.CONSUMER_FOUNDRY_PROJECT_ENDPOINT);
  if (endpoint.protocol !== 'https:' || !/^\/api\/projects\/[^/]+\/?$/.test(endpoint.pathname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('CONSUMER_FOUNDRY_PROJECT_ENDPOINT must be an HTTPS Foundry project endpoint.');
  }
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  const principal = run('az', [
    'rest', '--method', 'get', '--subscription', env.AZURE_SUBSCRIPTION_ID,
    '--resource', 'https://ai.azure.com',
    '--url', `${endpoint.href.replace(/\/$/, '')}/agents/ai-tutor-hosted-agent?api-version=v1`,
    '--query', 'versions.latest.instance_identity.principal_id', '--output', 'tsv',
  ], options).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principal)) {
    throw new Error('Foundry did not return a valid hosted-agent principal ID.');
  }
  run('az', [
    'deployment', 'group', 'create', '--subscription', env.AZURE_SUBSCRIPTION_ID,
    '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', 'hosted-agent-access',
    '--template-file', fileURLToPath(new URL('../infra/modules/hosted-agent.bicep', import.meta.url)),
    '--parameters', `agentPrincipalId=${principal}`, `keyVaultName=${env.AZURE_KEY_VAULT_NAME}`,
    `appInsightsName=${env.APPLICATIONINSIGHTS_NAME}`, `grantSecretRead=${!entra}`, '--output', 'none',
  ], options);
  if (entra) {
    const allowed = JSON.stringify([
      env.AGENTGATEWAY_AUTHORIZED_USER_ID, principal,
      ...(env.PROMPT_GATEWAY_PRINCIPAL_ID ? [env.PROMPT_GATEWAY_PRINCIPAL_ID] : []),
    ]);
    const current = run('az', [
      'containerapp', 'show', '--subscription', env.AZURE_SUBSCRIPTION_ID,
      '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME,
      '--query', "properties.template.containers[?name=='agentgateway'].env[] | [?name=='AGENTGATEWAY_ALLOWED_PRINCIPAL_IDS'].value | [0]",
      '--output', 'tsv',
    ], options).trim();
    const delegatedActor = run('az', [
      'containerapp', 'show', '--subscription', env.AZURE_SUBSCRIPTION_ID,
      '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME,
      '--query', "properties.template.containers[?name=='agentgateway'].env[] | [?name=='AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID'].value | [0]",
      '--output', 'tsv',
    ], options).trim();
    if (current !== allowed || delegatedActor !== principal) {
      run('az', [
        'containerapp', 'update', '--subscription', env.AZURE_SUBSCRIPTION_ID,
        '--resource-group', env.AZURE_RESOURCE_GROUP, '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME,
        '--container-name', 'agentgateway',
        '--set-env-vars', `AGENTGATEWAY_ALLOWED_PRINCIPAL_IDS=${allowed}`,
        `AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID=${principal}`, '--output', 'none',
      ], options);
    }
    run('azd', ['env', 'set', 'HOSTED_AGENT_PRINCIPAL_ID', principal, '--environment', env.AZURE_ENV_NAME], options);
    run('az', [
      'role', 'assignment', 'delete', '--subscription', env.AZURE_SUBSCRIPTION_ID,
      '--assignee', principal, '--role', '4633458b-17de-408a-b874-0445c86b69e6',
      '--scope', `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.KeyVault/vaults/${env.AZURE_KEY_VAULT_NAME}/secrets/agentgateway-api-key`,
    ], options);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    grantHostedAgentAccess();
  } catch (error) {
    console.error(`Hosted agent access failed: ${error.message}`);
    process.exitCode = 1;
  }
}
