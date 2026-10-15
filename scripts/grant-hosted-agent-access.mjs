import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function grantHostedAgentAccess({ env = process.env, run = execFileSync } = {}) {
  for (const name of ['AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'CONSUMER_FOUNDRY_PROJECT_ENDPOINT',
    'AZURE_KEY_VAULT_NAME', 'APPLICATIONINSIGHTS_NAME']) {
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
    `appInsightsName=${env.APPLICATIONINSIGHTS_NAME}`, '--output', 'none',
  ], options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    grantHostedAgentAccess();
  } catch (error) {
    console.error(`Hosted agent access failed: ${error.message}`);
    process.exitCode = 1;
  }
}
