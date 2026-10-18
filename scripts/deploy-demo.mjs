import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureDemoIdentity } from './configure-demo-entra.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hostingParameters(env, environment) {
  for (const key of ['AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'AZURE_PRINCIPAL_ID',
    'DEMO_SPA_CLIENT_ID', 'DEMO_BLUEPRINT_CLIENT_ID', 'HOSTED_AGENT_PRINCIPAL_ID', 'AGENTGATEWAY_ENTRA_CLIENT_ID']) {
    if (!uuid.test(env[key] ?? '')) throw new Error(`${key} must be a UUID; complete the demo Entra setup first.`);
  }
  const prefix = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.AZURE_RESOURCE_GROUP}/providers/Microsoft.App/managedEnvironments/`;
  if (!environment.id?.toLowerCase().startsWith(prefix.toLowerCase()) || !environment.name
    || environment.id.split('/').at(-1) !== environment.name || !environment.location) {
    throw new Error('The gateway environment must belong to the selected azd resource group and subscription.');
  }
  for (const key of ['AZURE_ENV_NAME', 'AZURE_RESOURCE_GROUP', 'CONSUMER_FOUNDRY_PROJECT_ENDPOINT', 'AGENTGATEWAY_ENDPOINT']) {
    if (!env[key]?.trim()) throw new Error(`${key} is required.`);
  }
  return {
    environmentName: env.AZURE_ENV_NAME, location: environment.location, managedEnvironmentName: environment.name,
    tenantId: env.AZURE_TENANT_ID, spaClientId: env.DEMO_SPA_CLIENT_ID,
    blueprintClientId: env.DEMO_BLUEPRINT_CLIENT_ID, hostedAgentId: env.HOSTED_AGENT_PRINCIPAL_ID,
    authorizedUserId: env.AZURE_PRINCIPAL_ID, gatewayClientId: env.AGENTGATEWAY_ENTRA_CLIENT_ID,
    foundryEndpoint: env.CONSUMER_FOUNDRY_PROJECT_ENDPOINT, gatewayEndpoint: env.AGENTGATEWAY_ENDPOINT,
    userScope: env.DEMO_USER_SCOPE ?? 'access_agent_as_user',
    resourceTags: environment.tags ?? {},
  };
}

export async function deployDemo({ apply = false, run = execFileSync, configure = configureDemoIdentity, fetchImpl = fetch } = {}) {
  const json = (args) => JSON.parse(run('az', [...args, '--output', 'json'], options));
  const env = JSON.parse(run('azd', ['env', 'get-values', '--output', 'json'], options));
  const account = json(['account', 'show', '--subscription', env.AZURE_SUBSCRIPTION_ID, '--query', '{tenantId:tenantId}']);
  if (account.tenantId !== env.AZURE_TENANT_ID) throw new Error('The selected subscription belongs to a different tenant.');
  if (!env.AGENTGATEWAY_CONTAINER_APP_NAME) throw new Error('Deploy the existing gateway before hosting the demo.');
  const gateway = json(['containerapp', 'show', '--name', env.AGENTGATEWAY_CONTAINER_APP_NAME,
    '--resource-group', env.AZURE_RESOURCE_GROUP, '--subscription', env.AZURE_SUBSCRIPTION_ID,
    '--query', '{environment:properties.managedEnvironmentId}']);
  if (typeof gateway.environment !== 'string') throw new Error('Gateway environment metadata is missing.');
  const environment = json(['resource', 'show', '--ids', gateway.environment, '--query', '{id:id,name:name,location:location,tags:tags}']);
  const parameters = hostingParameters(env, environment);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', environment: environment.id,
    credential: 'dedicated user-assigned managed identity federated to the existing blueprint',
    resources: ['dedicated managed identity', 'Basic container registry with AcrPull', 'separate Next.js Container App'],
    blueprintClientId: env.DEMO_BLUEPRINT_CLIENT_ID, localRedirect: 'preserved', sourceContext: 'apps/demo (allowlisted Docker context)' }));
  if (!apply) return parameters;
  const deploy = (extra) => {
    const values = Object.fromEntries(Object.entries({ ...parameters, ...extra }).map(([key, value]) => [key, { value }]));
    const result = json(['deployment', 'group', 'create', '--name', 'copilotkit-demo-hosting',
      '--subscription', env.AZURE_SUBSCRIPTION_ID, '--resource-group', env.AZURE_RESOURCE_GROUP,
      '--template-file', `${root}infra/demo-hosting.bicep`, '--parameters', JSON.stringify(values)]);
    const outputs = result.properties?.outputs;
    if (!outputs) throw new Error('The hosting deployment did not return outputs.');
    return Object.fromEntries(Object.entries(outputs).map(([key, entry]) => [key, entry.value]));
  };
  const bootstrap = deploy({ deployApp: false });
  if (!uuid.test(bootstrap.managedIdentityPrincipalId ?? '') || !uuid.test(bootstrap.managedIdentityClientId ?? '')) {
    throw new Error('The hosting deployment did not return valid managed identity identifiers.');
  }
  configure({
    env: { ...env, DEMO_AUTH_MODE: 'managed-identity', DEMO_ORIGIN: bootstrap.origin,
      DEMO_MANAGED_IDENTITY_PRINCIPAL_ID: bootstrap.managedIdentityPrincipalId },
    apply: true, persistOrigin: false, run,
  });
  const tag = `demo:${Date.now()}`;
  run('az', ['acr', 'build', '--registry', bootstrap.registryName, '--subscription', env.AZURE_SUBSCRIPTION_ID,
    '--image', tag, '--file', 'Dockerfile', '--platform', 'linux/amd64', '.'],
  { ...options, cwd: `${root}apps/demo`, stdio: 'inherit' });
  const digest = run('az', ['acr', 'repository', 'show', '--name', bootstrap.registryName,
    '--subscription', env.AZURE_SUBSCRIPTION_ID, '--image', tag, '--query', 'digest', '--output', 'tsv'], options).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('ACR did not return an immutable image digest.');
  const result = deploy({ deployApp: true, image: `${bootstrap.registryServer}/demo@${digest}` });
  const response = await fetchImpl(`${result.origin}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`The hosted demo readiness check failed (HTTP ${response.status}).`);
  const publicConfig = await response.json();
  if (publicConfig.origin !== result.origin || publicConfig.clientId !== env.DEMO_SPA_CLIENT_ID) {
    throw new Error('The hosted demo returned unexpected public configuration.');
  }
  for (const [key, value] of Object.entries({
    DEMO_HOSTED_ENDPOINT: result.origin, DEMO_CONTAINER_APP_NAME: result.appName,
    DEMO_MANAGED_IDENTITY_CLIENT_ID: result.managedIdentityClientId,
    DEMO_MANAGED_IDENTITY_PRINCIPAL_ID: result.managedIdentityPrincipalId,
  })) run('azd', ['env', 'set', key, value, '--environment', env.AZURE_ENV_NAME], options);
  console.log(JSON.stringify({ deployed: result.appName, origin: result.origin, imageDigest: digest,
    credentialMode: 'managed-identity', next: 'Sign in at the hosted origin and select Run live checks.' }));
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== '--apply')) {
    console.error('Use no arguments for read-only preview or --apply to build and deploy.');
    process.exitCode = 1;
  } else {
    deployDemo({ apply: args.includes('--apply') }).catch((error) => {
      console.error(`Demo hosting failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
