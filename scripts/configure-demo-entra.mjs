import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const graph = 'https://graph.microsoft.com/v1.0';
const foundryAppId = '18a66f5f-dbdf-4c17-9dd7-1634712a9cbe';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };

function one(values, label) {
  if (!Array.isArray(values) || values.length !== 1) throw new Error(`Expected exactly one ${label}.`);
  return values[0];
}

export function createGraphClient(run = execFileSync) {
  return (method, path, body) => {
    const result = run('az', ['rest', '--method', method, '--url', `${graph}${path}`,
      ...(body ? ['--body', JSON.stringify(body)] : []), '--output', 'json'], options);
    return result.trim() ? JSON.parse(result) : undefined;
  };
}

export function planDemoIdentity({ env, certificate, request }) {
  for (const name of ['AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_PRINCIPAL_ID',
    'HOSTED_AGENT_PRINCIPAL_ID', 'AGENTGATEWAY_ENTRA_CLIENT_ID']) {
    if (!uuid.test(env?.[name] ?? '')) throw new Error(`${name} must be a UUID.`);
  }
  for (const name of ['AZURE_ENV_NAME', 'AZURE_RESOURCE_GROUP', 'CONSUMER_FOUNDRY_PROJECT_ENDPOINT']) {
    if (!env?.[name]?.trim()) throw new Error(`${name} is required.`);
  }
  const origin = env.DEMO_ORIGIN ?? 'http://localhost:3000';
  const parsedOrigin = new URL(origin);
  if (origin !== parsedOrigin.origin || (parsedOrigin.protocol !== 'https:'
    && !(parsedOrigin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname)))) {
    throw new Error('DEMO_ORIGIN must be HTTPS or a loopback HTTP origin.');
  }
  const managedIdentity = env.DEMO_MANAGED_IDENTITY_PRINCIPAL_ID;
  if (managedIdentity && !uuid.test(managedIdentity)) throw new Error('The managed identity principal ID must be a UUID.');
  const now = Date.now();
  if (!managedIdentity && (!certificate || now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)
    || certificate.publicKey.asymmetricKeyType !== 'rsa'
    || certificate.publicKey.asymmetricKeyDetails.modulusLength < 2048)) {
    throw new Error('An unexpired RSA certificate with at least 2048 bits is required.');
  }
  const child = request('GET', `/servicePrincipals/${env.HOSTED_AGENT_PRINCIPAL_ID}/microsoft.graph.agentIdentity`);
  if (child.id !== env.HOSTED_AGENT_PRINCIPAL_ID || !uuid.test(child.agentIdentityBlueprintId ?? '')) {
    throw new Error('The hosted principal is not an Agent ID with a parent blueprint.');
  }
  if (env.DEMO_BLUEPRINT_CLIENT_ID && child.agentIdentityBlueprintId !== env.DEMO_BLUEPRINT_CLIENT_ID) {
    throw new Error('DEMO_BLUEPRINT_CLIENT_ID does not match the hosted Agent ID parent.');
  }
  const blueprintId = child.agentIdentityBlueprintId;
  const application = one(request('GET', `/applications?$filter=appId eq '${blueprintId}'&$select=id,appId`).value, 'blueprint');
  const blueprint = request('GET', `/applications/${application.id}?$select=id,appId,api,identifierUris,requiredResourceAccess,keyCredentials`);
  request('GET', `/applications/${blueprint.id}/microsoft.graph.agentIdentityBlueprint`);
  const blueprintPrincipal = one(request('GET', `/servicePrincipals?$filter=appId eq '${blueprintId}'`).value, 'blueprint principal');
  const scopeName = env.DEMO_USER_SCOPE ?? 'access_agent_as_user';
  if (!/^[a-zA-Z][a-zA-Z0-9._]*$/.test(scopeName)) throw new Error('Invalid demo scope name.');
  const scopes = blueprint.api?.oauth2PermissionScopes ?? [];
  const matching = scopes.filter((scope) => scope.value === scopeName);
  if (matching.length > 1 || matching.some((scope) => !scope.isEnabled || !uuid.test(scope.id))) {
    throw new Error('The blueprint user-facing scope is ambiguous or disabled.');
  }
  const userScope = matching[0] ?? {
    id: randomUUID(), value: scopeName, type: 'User', isEnabled: true,
    adminConsentDisplayName: 'Use the Foundry tutor demo',
    adminConsentDescription: 'Allow the signed-in user to invoke the Foundry tutor demo.',
    userConsentDisplayName: 'Use the Foundry tutor demo',
    userConsentDescription: 'Invoke the Foundry tutors on your behalf.',
  };
  const api = { ...blueprint.api, requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: matching.length ? scopes : [...scopes, userScope] };
  const identifierUris = [...new Set([...(blueprint.identifierUris ?? []), `api://${blueprintId}`])];
  const resources = [
    { appId: foundryAppId, name: 'user_impersonation' },
    { appId: env.AGENTGATEWAY_ENTRA_CLIENT_ID, name: 'gateway.invoke' },
  ].map((resource) => {
    const principal = one(request('GET', `/servicePrincipals?$filter=appId eq '${resource.appId}'`).value, `${resource.name} resource principal`);
    const scope = one(principal.oauth2PermissionScopes?.filter((entry) => entry.value === resource.name && entry.isEnabled), `${resource.name} scope`);
    if (!uuid.test(scope.id)) throw new Error('The resource returned an invalid scope ID.');
    return { ...resource, principalId: principal.id, scopeId: scope.id };
  });
  const access = structuredClone(blueprint.requiredResourceAccess ?? []);
  for (const resource of resources) {
    let item = access.find((entry) => entry.resourceAppId === resource.appId);
    if (!item) { item = { resourceAppId: resource.appId, resourceAccess: [] }; access.push(item); }
    if (!item.resourceAccess.some((entry) => entry.id === resource.scopeId && entry.type === 'Scope')) {
      item.resourceAccess.push({ id: resource.scopeId, type: 'Scope' });
    }
  }
  const patch = { api, identifierUris, requiredResourceAccess: access };
  if (!managedIdentity) {
    const keys = structuredClone(blueprint.keyCredentials ?? []);
    if (keys.some((key) => !key.key)) throw new Error('Graph did not return all existing public keys; refusing to replace credentials.');
    if (!keys.some((key) => key.key === certificate.raw.toString('base64'))) {
      keys.push({
        keyId: randomUUID(), type: 'AsymmetricX509Cert', usage: 'Verify',
        displayName: 'agentgateway-demo-local', key: certificate.raw.toString('base64'),
        customKeyIdentifier: createHash('sha1').update(certificate.raw).digest('base64'),
        startDateTime: new Date(certificate.validFrom).toISOString(),
        endDateTime: new Date(certificate.validTo).toISOString(),
      });
    }
    patch.keyCredentials = keys;
  }
  const operations = [];
  if (Object.entries(patch).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(blueprint[key]))) {
    operations.push({ method: 'PATCH', path: `/applications/${blueprint.id}`, body: patch });
  }
  if (managedIdentity) {
    const path = `/applications/${blueprint.id}/federatedIdentityCredentials`;
    const result = request('GET', path);
    if (!Array.isArray(result.value) || result['@odata.nextLink']) throw new Error('Incomplete federation metadata needs manual review.');
    const name = 'agentgateway-demo-managed-identity';
    const expected = { name, issuer: `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/v2.0`,
      subject: managedIdentity, audiences: ['api://AzureADTokenExchange'] };
    const current = result.value.filter((entry) => entry.name === name);
    if (current.length > 1) throw new Error('Duplicate demo federation credentials need manual review.');
    if (current.length && (current[0].issuer !== expected.issuer || current[0].subject !== expected.subject
      || JSON.stringify(current[0].audiences) !== JSON.stringify(expected.audiences))) {
      throw new Error('The existing demo federation trusts a different identity; refusing to replace it.');
    }
    if (!current.length) operations.push({ method: 'POST', path, body: expected });
  }
  let redirectUris = [`${origin}/auth/callback`];
  if (env.DEMO_SPA_CLIENT_ID) {
    if (!uuid.test(env.DEMO_SPA_CLIENT_ID)) throw new Error('The SPA client ID must be a UUID.');
    const spa = one(request('GET', `/applications?$filter=appId eq '${env.DEMO_SPA_CLIENT_ID}'&$select=id,appId,spa`).value, 'existing demo SPA');
    redirectUris = [...new Set([...(spa.spa?.redirectUris ?? []), ...redirectUris])];
  }
  const inheritancePath = `/applications/${blueprint.id}/microsoft.graph.agentIdentityBlueprint/inheritablePermissions`;
  const inherited = request('GET', inheritancePath).value;
  if (!Array.isArray(inherited)) throw new Error('Graph returned incomplete inheritance metadata.');
  const grants = request('GET', `/oauth2PermissionGrants?$filter=clientId eq '${blueprintPrincipal.id}'`).value;
  if (!Array.isArray(grants)) throw new Error('Graph returned incomplete consent metadata.');
  for (const resource of resources) {
    const current = inherited.find((entry) => entry.resourceAppId === resource.appId);
    const pattern = current?.inheritableScopes;
    if (pattern && !['allAllowed', 'enumerated', 'none'].includes(pattern.kind)) {
      throw new Error('An unrecognized inheritance pattern needs manual review.');
    }
    if (pattern?.kind !== 'allAllowed' && !pattern?.scopes?.includes(resource.name)) {
      operations.push({
        method: current ? 'PATCH' : 'POST',
        path: current ? `${inheritancePath}/${resource.appId}` : inheritancePath,
        body: {
          ...(!current ? { resourceAppId: resource.appId } : {}),
          inheritableScopes: {
            '@odata.type': '#microsoft.graph.enumeratedScopes', kind: 'enumerated',
            scopes: [...new Set([...(pattern?.scopes ?? []), resource.name])],
          },
        },
      });
    }
    const matches = grants.filter((grant) => grant.resourceId === resource.principalId
      && grant.consentType === 'Principal' && grant.principalId === env.AZURE_PRINCIPAL_ID);
    if (matches.length > 1) throw new Error('Duplicate user-specific consent grants need manual review.');
    const grant = matches[0];
    const granted = grant?.scope?.split(' ').filter(Boolean) ?? [];
    if (!granted.includes(resource.name)) {
      operations.push({
        method: grant ? 'PATCH' : 'POST', path: grant ? `/oauth2PermissionGrants/${grant.id}` : '/oauth2PermissionGrants',
        body: grant
          ? { scope: [...granted, resource.name].join(' ') }
          : { clientId: blueprintPrincipal.id, resourceId: resource.principalId,
            consentType: 'Principal', principalId: env.AZURE_PRINCIPAL_ID, scope: resource.name },
      });
    }
  }
  return { blueprintId, blueprintPrincipalId: blueprintPrincipal.id, userScope, origin, redirectUris, operations, resources,
    applicationUniqueName: `${env.AZURE_SUBSCRIPTION_ID}-${env.AZURE_ENV_NAME}-copilotkit-demo` };
}

export function configureDemoIdentity({ env, certificate, apply = false, persistOrigin = true, request = createGraphClient(), run = execFileSync }) {
  const plan = planDemoIdentity({ env, certificate, request });
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'preview', blueprintClientId: plan.blueprintId, authorizedUserId: env.AZURE_PRINCIPAL_ID,
    origin: plan.origin, redirectUris: plan.redirectUris,
    credentialMode: env.DEMO_MANAGED_IDENTITY_PRINCIPAL_ID ? 'managed-identity' : 'certificate',
    ...(certificate ? { certificateExpires: certificate.validTo, certificateThumbprint: certificate.fingerprint256 } : {}),
    userScope: plan.userScope.value,
    delegatedPermissions: plan.resources.map(({ appId, name }) => ({ appId, scope: name })),
    changes: plan.operations.map(({ method, path }) => ({ method, path })),
    spa: plan.applicationUniqueName,
  }));
  if (!apply) return plan;
  for (const operation of plan.operations) request(operation.method, operation.path, operation.body);
  const parameters = Object.fromEntries(Object.entries({
    environmentName: env.AZURE_ENV_NAME, applicationUniqueName: plan.applicationUniqueName,
    redirectUris: plan.redirectUris, blueprintClientId: plan.blueprintId, blueprintPrincipalId: plan.blueprintPrincipalId,
    userScopeId: plan.userScope.id, userScopeName: plan.userScope.value, authorizedUserId: env.AZURE_PRINCIPAL_ID,
  }).map(([key, value]) => [key, { value }]));
  const deployment = JSON.parse(run('az', ['deployment', 'group', 'create', '--name', 'copilotkit-demo-entra',
    '--subscription', env.AZURE_SUBSCRIPTION_ID, '--resource-group', env.AZURE_RESOURCE_GROUP,
    '--template-file', fileURLToPath(new URL('../infra/demo-entra.bicep', import.meta.url)),
    '--parameters', JSON.stringify(parameters), '--output', 'json'], options));
  const clientId = deployment.properties?.outputs?.clientId?.value;
  if (!uuid.test(clientId ?? '') || (env.DEMO_SPA_CLIENT_ID && clientId !== env.DEMO_SPA_CLIENT_ID)) {
    throw new Error('The demo deployment did not return the expected SPA client ID.');
  }
  const remaining = planDemoIdentity({ env, certificate, request });
  if (remaining.operations.length) throw new Error('Demo identity settings did not persist; rerun the preview and inspect Graph state.');
  for (const [key, value] of Object.entries({
    DEMO_SPA_CLIENT_ID: clientId, DEMO_BLUEPRINT_CLIENT_ID: plan.blueprintId,
    ...(persistOrigin ? { DEMO_ORIGIN: plan.origin } : {}),
  })) {
    run('azd', ['env', 'set', key, value, '--environment', env.AZURE_ENV_NAME], options);
  }
  return { ...plan, clientId };
}

export function writeDemoEnvironment(env, { certificatePath, privateKeyPath, destination = resolve(root, 'apps/demo/.env.local') }) {
  if (existsSync(destination)) throw new Error('The demo environment file already exists. Review and remove it explicitly before exporting again.');
  if (!existsSync(privateKeyPath) || (statSync(privateKeyPath).mode & 0o077)) {
    throw new Error('The private key must exist with owner-only permissions (chmod 600).');
  }
  const values = {
    DEMO_AUTH_MODE: 'certificate',
    DEMO_TENANT_ID: env.AZURE_TENANT_ID, DEMO_SPA_CLIENT_ID: env.DEMO_SPA_CLIENT_ID,
    DEMO_BLUEPRINT_CLIENT_ID: env.DEMO_BLUEPRINT_CLIENT_ID,
    HOSTED_AGENT_PRINCIPAL_ID: env.HOSTED_AGENT_PRINCIPAL_ID, AZURE_PRINCIPAL_ID: env.AZURE_PRINCIPAL_ID,
    AGENTGATEWAY_ENTRA_CLIENT_ID: env.AGENTGATEWAY_ENTRA_CLIENT_ID,
    CONSUMER_FOUNDRY_PROJECT_ENDPOINT: env.CONSUMER_FOUNDRY_PROJECT_ENDPOINT,
    DEMO_ORIGIN: env.DEMO_ORIGIN ?? 'http://localhost:3000',
    DEMO_USER_SCOPE: env.DEMO_USER_SCOPE ?? 'access_agent_as_user',
    DEMO_CERTIFICATE_PATH: certificatePath, DEMO_PRIVATE_KEY_PATH: privateKeyPath,
    ...(env.AGENTGATEWAY_ENDPOINT ? { AGENTGATEWAY_ENDPOINT: env.AGENTGATEWAY_ENDPOINT } : {}),
  };
  if (Object.values(values).some((value) => typeof value !== 'string' || !value || /[\r\n]/.test(value))) {
    throw new Error('Complete the demo identity setup before exporting its environment.');
  }
  writeFileSync(destination, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n',
    { mode: 0o600, flag: 'wx' });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((arg) => !['--apply', '--write-env'].includes(arg))) {
      throw new Error('Use no arguments to preview, --apply for directory writes, or --write-env for local export.');
    }
    const env = { ...JSON.parse(execFileSync('azd', ['env', 'get-values', '--output', 'json'], options)) };
    for (const name of ['DEMO_ORIGIN', 'DEMO_CERTIFICATE_PATH', 'DEMO_PRIVATE_KEY_PATH', 'DEMO_USER_SCOPE',
      'DEMO_MANAGED_IDENTITY_PRINCIPAL_ID', 'DEMO_AUTH_MODE']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const mode = env.DEMO_AUTH_MODE ?? 'certificate';
    if (!['certificate', 'managed-identity'].includes(mode)) throw new Error('DEMO_AUTH_MODE must select certificate or managed-identity explicitly.');
    if (mode === 'certificate') delete env.DEMO_MANAGED_IDENTITY_PRINCIPAL_ID;
    else if (!uuid.test(env.DEMO_MANAGED_IDENTITY_PRINCIPAL_ID ?? '')) throw new Error('Managed identity mode requires its principal ID.');
    env.AZURE_TENANT_ID ??= execFileSync('az', ['account', 'show', '--query', 'tenantId', '--output', 'tsv'], options).trim();
    const certificatePath = resolve(env.DEMO_CERTIFICATE_PATH ?? resolve(root, '.certificates/demo.pem'));
    const privateKeyPath = resolve(env.DEMO_PRIVATE_KEY_PATH ?? resolve(root, '.certificates/demo.key'));
    if (args.includes('--write-env')) {
      writeDemoEnvironment(env, { certificatePath, privateKeyPath });
      console.log('Exported the allowlisted demo configuration; no secrets or private-key contents were exported.');
    } else {
      configureDemoIdentity({ env, certificate: env.DEMO_MANAGED_IDENTITY_PRINCIPAL_ID ? undefined
        : new X509Certificate(readFileSync(certificatePath)), apply: args.includes('--apply') });
    }
  } catch (error) {
    console.error(`Demo identity setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
