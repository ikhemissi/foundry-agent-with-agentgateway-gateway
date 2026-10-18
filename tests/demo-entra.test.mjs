import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDemoIdentity, planDemoIdentity, writeDemoEnvironment } from '../scripts/configure-demo-entra.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = mkdtempSync(join(tmpdir(), 'demo-entra-'));
const certificatePath = join(directory, 'cert.pem');
const privateKeyPath = join(directory, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKeyPath,
  '-out', certificatePath, '-days', '1', '-subj', '/CN=offline-demo-test'], { stdio: 'ignore' });
const certificate = new X509Certificate(readFileSync(certificatePath));
after(() => rmSync(directory, { recursive: true }));
const env = {
  AZURE_TENANT_ID: id(1), AZURE_SUBSCRIPTION_ID: id(2), AZURE_PRINCIPAL_ID: id(5),
  HOSTED_AGENT_PRINCIPAL_ID: id(4), AGENTGATEWAY_ENTRA_CLIENT_ID: id(6),
  AZURE_ENV_NAME: 'offline', AZURE_RESOURCE_GROUP: 'offline-rg',
  CONSUMER_FOUNDRY_PROJECT_ENDPOINT: 'https://consumer.services.ai.azure.com/api/projects/tutors',
};
function fixture() {
  const blueprint = {
    id: id(11), appId: id(3), api: { knownClientApplications: [id(30)],
      oauth2PermissionScopes: [{ id: id(12), value: 'existing.scope', isEnabled: true }] },
    identifierUris: ['api://existing'], requiredResourceAccess: [{ resourceAppId: id(40), resourceAccess: [{ id: id(41), type: 'Scope' }] }],
    keyCredentials: [{ keyId: id(31), key: 'existing-public-key', type: 'AsymmetricX509Cert', usage: 'Verify' }],
  };
  const inherited = [{ resourceAppId: id(40), inheritableScopes: { kind: 'allAllowed' } }];
  const grants = [{ id: id(32), resourceId: id(40), consentType: 'AllPrincipals', scope: 'existing' }];
  const requests = [];
  const federations = [];
  const spaRedirects = ['http://localhost:3000/auth/callback'];
  const request = (method, path, body) => {
    requests.push({ method, path, body });
    if (method === 'GET') {
      if (path.endsWith('/federatedIdentityCredentials')) return { value: structuredClone(federations) };
      if (path.startsWith(`/applications?$filter=appId eq '${id(7)}'`)) {
        return { value: [{ id: id(71), appId: id(7), spa: { redirectUris: spaRedirects } }] };
      }
      if (path.includes('/microsoft.graph.agentIdentity') && path.startsWith('/servicePrincipals/')) {
        return { id: id(4), agentIdentityBlueprintId: id(3) };
      }
      if (path.startsWith('/applications?$filter=')) return { value: [structuredClone(blueprint)] };
      if (path.startsWith(`/applications/${id(11)}?$select=`)) return structuredClone(blueprint);
      if (path.endsWith('/microsoft.graph.agentIdentityBlueprint')) return structuredClone(blueprint);
      if (path.startsWith('/servicePrincipals?$filter=')) {
        const appId = path.match(/appId eq '([^']+)'/)[1];
        if (appId === id(3)) return { value: [{ id: id(13), appId }] };
        const gateway = appId === id(6);
        return { value: [{ id: gateway ? id(16) : id(18), appId, oauth2PermissionScopes: [
          { id: gateway ? id(17) : id(19), value: gateway ? 'gateway.invoke' : 'user_impersonation', isEnabled: true },
        ] }] };
      }
      if (path.endsWith('/inheritablePermissions')) return { value: structuredClone(inherited) };
      if (path.startsWith('/oauth2PermissionGrants?$filter=')) return { value: structuredClone(grants) };
    }
    if (method === 'POST' && path.endsWith('/federatedIdentityCredentials')) { federations.push(body); return; }
    if (method === 'PATCH' && path === `/applications/${id(11)}`) { Object.assign(blueprint, body); return; }
    if (path.includes('/inheritablePermissions')) {
      if (method === 'POST') inherited.push(body);
      else Object.assign(inherited.find((entry) => path.endsWith(entry.resourceAppId)), body);
      return;
    }
    if (path.startsWith('/oauth2PermissionGrants')) {
      if (method === 'POST') grants.push({ ...body, id: id(50 + grants.length) });
      else Object.assign(grants.find((entry) => path.endsWith(entry.id)), body);
      return;
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { blueprint, inherited, grants, federations, spaRedirects, requests, request };
}

test('demo identity preview performs reads only and preserves existing blueprint settings', () => {
  const state = fixture();
  const plan = configureDemoIdentity({ env, certificate, request: state.request,
    run: () => { throw new Error('Preview must not run deployments or write azd state'); } });
  assert.ok(state.requests.every((entry) => entry.method === 'GET'));
  const patch = plan.operations.find((entry) => entry.path === `/applications/${id(11)}`).body;
  assert.deepEqual(patch.api.knownClientApplications, [id(30)]);
  assert.equal(patch.api.requestedAccessTokenVersion, 2);
  assert.equal(patch.api.oauth2PermissionScopes[0].value, 'existing.scope');
  assert.equal(patch.api.oauth2PermissionScopes[1].value, 'access_agent_as_user');
  assert.deepEqual(patch.keyCredentials[0], state.blueprint.keyCredentials[0]);
  assert.equal(patch.keyCredentials.length, 2);
  assert.equal(patch.requiredResourceAccess[0].resourceAppId, id(40));
  const consents = plan.operations.filter((entry) => entry.path === '/oauth2PermissionGrants');
  assert.equal(consents.length, 2);
  assert.ok(consents.every((entry) => entry.body.consentType === 'Principal' && entry.body.principalId === id(5)));
  const scopes = plan.operations.filter((entry) => entry.path.endsWith('/inheritablePermissions'));
  assert.ok(scopes.every((entry) => entry.body.inheritableScopes.kind === 'enumerated'));
});
test('managed identity federation preserves certificate credentials and local SPA redirects', () => {
  const state = fixture();
  state.blueprint.keyCredentials[0].key = null;
  const managedEnv = { ...env, DEMO_MANAGED_IDENTITY_PRINCIPAL_ID: id(80),
    DEMO_SPA_CLIENT_ID: id(7), DEMO_ORIGIN: 'https://demo.example.com' };
  const plan = planDemoIdentity({ env: managedEnv, request: state.request });
  const patch = plan.operations.find((entry) => entry.method === 'PATCH' && entry.path === `/applications/${id(11)}`).body;
  assert.equal('keyCredentials' in patch, false);
  const fic = plan.operations.find((entry) => entry.path.endsWith('/federatedIdentityCredentials'));
  assert.deepEqual(fic.body, { name: 'agentgateway-demo-managed-identity',
    issuer: `https://login.microsoftonline.com/${id(1)}/v2.0`, subject: id(80), audiences: ['api://AzureADTokenExchange'] });
  assert.deepEqual(plan.redirectUris, ['http://localhost:3000/auth/callback', 'https://demo.example.com/auth/callback']);
  const commands = [];
  configureDemoIdentity({ env: managedEnv, apply: true, persistOrigin: false, request: state.request,
    run(command, args) {
      commands.push([command, args]);
      if (command === 'az') {
        const parameters = JSON.parse(args[args.indexOf('--parameters') + 1]);
        assert.deepEqual(parameters.redirectUris.value, plan.redirectUris);
        return JSON.stringify({ properties: { outputs: { clientId: { value: id(7) } } } });
      }
      return '';
    } });
  assert.equal(planDemoIdentity({ env: managedEnv, request: state.request }).operations.length, 0);
  assert.equal(state.federations.length, 1);
  assert.equal(state.blueprint.keyCredentials[0].key, null);
  assert.equal(commands.some(([command, args]) => command === 'azd' && args.includes('DEMO_ORIGIN')), false);
});
test('managed identity setup refuses to replace a mismatched federation', () => {
  const state = fixture();
  state.federations.push({ name: 'agentgateway-demo-managed-identity',
    issuer: `https://login.microsoftonline.com/${id(1)}/v2.0`, subject: id(99), audiences: ['api://AzureADTokenExchange'] });
  assert.throws(() => planDemoIdentity({ env: { ...env, DEMO_MANAGED_IDENTITY_PRINCIPAL_ID: id(80) },
    request: state.request }), /refusing to replace/);
});
test('explicit apply persists certificate, narrow scopes, user grants and dedicated SPA through Bicep', () => {
  const state = fixture();
  const commands = [];
  const run = (command, args) => {
    commands.push([command, args]);
    if (command === 'az') {
      assert.equal(args[0], 'deployment');
      assert.equal(args[1], 'group');
      assert.match(args[args.indexOf('--template-file') + 1], /demo-entra\.bicep$/);
      const parameters = JSON.parse(args[args.indexOf('--parameters') + 1]);
      assert.equal(parameters.authorizedUserId.value, id(5));
      assert.equal(parameters.blueprintClientId.value, id(3));
      return JSON.stringify({ properties: { outputs: { clientId: { value: id(7) } } } });
    }
    return '';
  };
  const result = configureDemoIdentity({ env, certificate, apply: true, request: state.request, run });
  assert.equal(result.clientId, id(7));
  assert.equal(commands.filter(([command]) => command === 'azd').length, 3);
  assert.equal(planDemoIdentity({ env, certificate, request: state.request }).operations.length, 0);
  assert.equal(state.blueprint.keyCredentials.length, 2);
  assert.equal(state.grants[0].consentType, 'AllPrincipals');
  assert.equal(state.inherited[0].resourceAppId, id(40));
});
test('apply refuses success when directory settings did not persist', () => {
  const state = fixture();
  const request = (method, ...args) => method === 'GET' ? state.request(method, ...args) : undefined;
  assert.throws(() => configureDemoIdentity({
    env, certificate, apply: true, request,
    run: () => JSON.stringify({ properties: { outputs: { clientId: { value: id(7) } } } }),
  }), /did not persist/);
});
test('refuses blueprint mismatch, disabled scopes, unreadable existing credentials and invalid origins', () => {
  for (const override of [{ DEMO_BLUEPRINT_CLIENT_ID: id(99) }, { DEMO_ORIGIN: 'http://remote.example' }]) {
    assert.throws(() => planDemoIdentity({ env: { ...env, ...override }, certificate, request: fixture().request }));
  }
  const missingKeys = fixture();
  missingKeys.blueprint.keyCredentials[0].key = null;
  assert.throws(() => planDemoIdentity({ env, certificate, request: missingKeys.request }), /existing public keys/);
  const disabled = fixture();
  disabled.blueprint.api.oauth2PermissionScopes.push({ id: id(70), value: 'access_agent_as_user', isEnabled: false });
  assert.throws(() => planDemoIdentity({ env, certificate, request: disabled.request }), /disabled/);
});
test('adds to existing narrow inheritance and consent without replacing unrelated scopes', () => {
  const state = fixture();
  state.inherited.push({ resourceAppId: id(6), inheritableScopes: { kind: 'enumerated', scopes: ['existing.gateway'] } });
  state.grants.push({ id: id(77), clientId: id(13), resourceId: id(16), consentType: 'Principal', principalId: id(5), scope: 'existing.gateway' });
  const plan = planDemoIdentity({ env, certificate, request: state.request });
  const inheritance = plan.operations.find((entry) => entry.path.endsWith(`/inheritablePermissions/${id(6)}`));
  assert.deepEqual(inheritance.body.inheritableScopes.scopes, ['existing.gateway', 'gateway.invoke']);
  const consent = plan.operations.find((entry) => entry.path.endsWith(`/oauth2PermissionGrants/${id(77)}`));
  assert.equal(consent.body.scope, 'existing.gateway gateway.invoke');
});
test('local export allowlists config, excludes secrets, refuses overwrite and protects permissions', () => {
  const destination = join(directory, '.env.local');
  const values = { ...env, DEMO_SPA_CLIENT_ID: id(7), DEMO_BLUEPRINT_CLIENT_ID: id(3),
    PROMPT_GATEWAY_CLIENT_SECRET: 'NEVER-EXPORT', PRIVATE_KEY: 'NEVER-EXPORT' };
  writeDemoEnvironment(values, { certificatePath, privateKeyPath, destination });
  const output = readFileSync(destination, 'utf8');
  assert.match(output, /DEMO_SPA_CLIENT_ID=/);
  assert.doesNotMatch(output, /NEVER-EXPORT|PROMPT_GATEWAY_CLIENT_SECRET|BEGIN PRIVATE KEY/);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.throws(() => writeDemoEnvironment(values, { certificatePath, privateKeyPath, destination }), /already exists/);
  const exposedKey = join(directory, 'exposed.key');
  writeFileSync(exposedKey, 'not-a-real-key', { mode: 0o644 });
  assert.throws(() => writeDemoEnvironment(values, { certificatePath, privateKeyPath: exposedKey, destination: join(directory, 'other.env') }), /owner-only/);
});
