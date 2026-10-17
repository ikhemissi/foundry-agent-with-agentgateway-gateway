import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function removeLegacyGatewayKey({ env, apply = false, run = execFileSync, fetchImpl = fetch } = {}) {
  for (const name of ['AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_GROUP', 'AZURE_KEY_VAULT_NAME',
    'AGENTGATEWAY_CONTAINER_APP_NAME', 'AGENTGATEWAY_ENDPOINT', 'CONSUMER_FOUNDRY_NAME',
    'CONSUMER_FOUNDRY_PROJECT_ENDPOINT']) {
    if (!env?.[name]?.trim()) throw new Error(`${name} is required for legacy-key cleanup.`);
  }
  const gateway = new URL(env.AGENTGATEWAY_ENDPOINT);
  const project = new URL(env.CONSUMER_FOUNDRY_PROJECT_ENDPOINT);
  if (gateway.protocol !== 'https:' || gateway.pathname !== '/' || gateway.username || gateway.password
      || gateway.search || gateway.hash || project.protocol !== 'https:' || project.username || project.password
      || project.search || project.hash || !/^\/api\/projects\/[^/]+\/?$/.test(project.pathname)) {
    throw new Error('Cleanup requires an HTTPS gateway origin and an HTTPS Foundry project endpoint.');
  }
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  const az = (...args) => JSON.parse(run('az', [...args, '--subscription', env.AZURE_SUBSCRIPTION_ID,
    '--output', 'json'], options));
  const base = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.AZURE_RESOURCE_GROUP}`;
  const projectName = project.pathname.replace(/\/$/, '').split('/').at(-1);
  const connection = az('rest', '--method', 'GET', '--url',
    `https://management.azure.com${base}/providers/Microsoft.CognitiveServices/accounts/${env.CONSUMER_FOUNDRY_NAME}/projects/${projectName}/connections/agentgateway-gateway?api-version=2026-09-01`);
  if (connection.properties?.authType !== 'OAuth2'
      || connection.properties.target !== `${gateway.origin}/entra/v1`) {
    throw new Error('Migrate the prompt ModelGateway connection to OAuth2 before cleanup.');
  }
  const agent = az('rest', '--method', 'GET', '--resource', 'https://ai.azure.com',
    '--url', `${project.href.replace(/\/$/, '')}/agents/ai-tutor-hosted-agent?api-version=v1`);
  const latest = agent.versions?.latest;
  const settings = latest?.definition?.environment_variables;
  if (latest?.status !== 'active' || settings?.AGENTGATEWAY_BASE_URL !== `${gateway.origin}/delegated/v1`
      || (settings.AGENTGATEWAY_AUTH_MODE && settings.AGENTGATEWAY_AUTH_MODE !== 'entra_delegated')
      || settings.AZURE_KEY_VAULT_NAME || settings.AGENTGATEWAY_API_KEY) {
    throw new Error('Deploy the delegated-only hosted agent without gateway-secret settings before cleanup.');
  }
  const revisions = az('containerapp', 'revision', 'list', '--resource-group', env.AZURE_RESOURCE_GROUP,
    '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME);
  const active = revisions.filter((revision) => revision.properties?.active);
  if (!active.length || active.some((revision) => {
    const containers = revision.properties.template?.containers;
    return !containers?.some((container) => container.name === 'agentgateway')
      || containers.some((container) => container.env?.some((entry) =>
        entry.name === 'AGENTGATEWAY_API_KEY' || entry.secretRef === 'agentgateway-api-key'));
  })) {
    throw new Error('All active gateway revisions must stop referencing the shared key before cleanup.');
  }
  const response = await fetchImpl(`${gateway.origin}/v1/chat/completions`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4-nano', messages: [{ role: 'user', content: 'Legacy route removal check' }] }),
  });
  await response.body?.cancel();
  if (response.status !== 404) throw new Error('The shared-key inference endpoint is still present; deploy the identity-only gateway first.');

  const secretScope = `${base}/providers/Microsoft.KeyVault/vaults/${env.AZURE_KEY_VAULT_NAME}/secrets/agentgateway-api-key`;
  const readPlan = () => {
    const roles = az('role', 'assignment', 'list', '--scope', secretScope);
    const secrets = az('keyvault', 'secret', 'list', '--vault-name', env.AZURE_KEY_VAULT_NAME);
    const app = az('containerapp', 'show', '--resource-group', env.AZURE_RESOURCE_GROUP,
      '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME);
    const appSecrets = app.properties?.configuration?.secrets;
    if (!Array.isArray(roles) || !Array.isArray(secrets) || !Array.isArray(appSecrets)) {
      throw new Error('Azure returned incomplete secret or role metadata; cleanup cannot be confirmed.');
    }
    const assignments = roles.filter((assignment) => assignment.scope?.toLowerCase() === secretScope.toLowerCase()
      && assignment.roleDefinitionId?.endsWith('/4633458b-17de-408a-b874-0445c86b69e6'));
    if (assignments.some((assignment) => typeof assignment.id !== 'string' || !assignment.id.trim())) {
      throw new Error('Azure returned a legacy reader without a role assignment ID; cleanup cannot proceed.');
    }
    return {
      roleAssignmentIds: assignments.map((assignment) => assignment.id),
      removeVaultSecret: secrets.some((secret) => secret.name === 'agentgateway-api-key'),
      removeAppSecret: appSecrets.some((secret) => secret.name === 'agentgateway-api-key'),
    };
  };
  const plan = readPlan();
  console.log(`${apply ? 'Applying' : 'Preview only; use --apply after validating both tutors'}: ${JSON.stringify(plan)}`);
  if (apply) {
    if (plan.removeAppSecret) run('az', ['containerapp', 'secret', 'remove', '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME,
      '--resource-group', env.AZURE_RESOURCE_GROUP, '--subscription', env.AZURE_SUBSCRIPTION_ID,
      '--secret-names', 'agentgateway-api-key', '--output', 'none'], options);
    for (const id of plan.roleAssignmentIds) {
      run('az', ['role', 'assignment', 'delete', '--ids', id, '--subscription', env.AZURE_SUBSCRIPTION_ID,
        '--output', 'none'], options);
    }
    if (plan.removeVaultSecret) run('az', ['keyvault', 'secret', 'delete', '--vault-name', env.AZURE_KEY_VAULT_NAME,
      '--name', 'agentgateway-api-key', '--subscription', env.AZURE_SUBSCRIPTION_ID, '--output', 'none'], options);
    const remaining = readPlan();
    if (remaining.roleAssignmentIds.length || remaining.removeVaultSecret || remaining.removeAppSecret) {
      throw new Error('Legacy resources remain after cleanup; inspect Azure state and rerun to confirm removal.');
    }
  }
  return plan;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== '--apply')) throw new Error('Only --apply is supported.');
    const env = JSON.parse(execFileSync('azd', ['env', 'get-values', '--output', 'json'], { encoding: 'utf8' }));
    await removeLegacyGatewayKey({ env, apply: args.includes('--apply') });
  } catch (error) {
    console.error(`Legacy gateway-key cleanup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
