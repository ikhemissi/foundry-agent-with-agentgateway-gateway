import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const secretName = 'agentgateway-prompt-client-secret';

export async function configurePromptGatewayEntra({ env, run = execFileSync, fetchImpl = fetch, now = new Date() } = {}) {
  for (const name of ['AZURE_KEY_VAULT_NAME', 'PROMPT_GATEWAY_CLIENT_ID', 'PROMPT_GATEWAY_PRINCIPAL_ID']) {
    if (!env?.[name]?.trim()) throw new Error(`${name} is required; run configure-gateway-entra.mjs --include-prompt first.`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(env.AZURE_KEY_VAULT_NAME)) {
    throw new Error('AZURE_KEY_VAULT_NAME must be a valid Key Vault name.');
  }
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  const az = (...args) => JSON.parse(run('az', [...args, '--output', 'json'], options));
  const app = az('ad', 'app', 'show', '--id', env.PROMPT_GATEWAY_CLIENT_ID);
  const principal = az('ad', 'sp', 'show', '--id', env.PROMPT_GATEWAY_PRINCIPAL_ID);
  if (app.appId !== env.PROMPT_GATEWAY_CLIENT_ID || !app.id
      || principal.id !== env.PROMPT_GATEWAY_PRINCIPAL_ID || principal.appId !== app.appId) {
    throw new Error('The configured prompt application and service principal do not match the Graph Bicep outputs.');
  }
  const existing = az('keyvault', 'secret', 'list', '--vault-name', env.AZURE_KEY_VAULT_NAME,
    '--query', `[?name=='${secretName}']`);
  if (existing.length) {
    const expires = Date.parse(existing[0].attributes?.expires ?? '');
    if (existing[0].tags?.clientId !== app.appId || !existing[0].attributes?.enabled
        || !Number.isFinite(expires) || expires <= now.getTime()) {
      throw new Error('The stored prompt OAuth credential is disabled, expired, missing valid expiry metadata, or belongs to another application. Rotate it explicitly.');
    }
  } else {
    const expires = new Date(now);
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
    const credential = az('rest', '--method', 'POST',
      '--url', `https://graph.microsoft.com/v1.0/applications/${app.id}/addPassword`,
      '--body', JSON.stringify({ passwordCredential: {
        displayName: 'agentgateway-model-connection', endDateTime: expires.toISOString(),
      } }));
    if (!credential.secretText?.trim() || !credential.keyId) throw new Error('Entra returned an incomplete prompt client credential.');
    try {
      const token = az('account', 'get-access-token', '--resource', 'https://vault.azure.net').accessToken;
      if (!token?.trim()) throw new Error('Azure CLI returned an empty Key Vault token.');
      const response = await fetchImpl(
        `https://${env.AZURE_KEY_VAULT_NAME}.vault.azure.net/secrets/${secretName}?api-version=7.5`,
        {
          method: 'PUT', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            value: credential.secretText, contentType: 'ModelGateway OAuth2 client credential',
            attributes: { enabled: true, exp: Math.floor(expires.getTime() / 1000) },
            tags: { clientId: app.appId },
          }),
        });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Key Vault credential storage failed (HTTP ${response.status}).`);
    } catch (error) {
      try {
        run('az', ['rest', '--method', 'POST',
          '--url', `https://graph.microsoft.com/v1.0/applications/${app.id}/removePassword`,
          '--body', JSON.stringify({ keyId: credential.keyId }), '--output', 'none'], options);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          `Vault storage and credential cleanup failed; remove Entra password ${credential.keyId} explicitly.`);
      }
      throw error;
    }
  }
  console.log(`Configured prompt OAuth client ${app.appId}; its credential is stored in Key Vault.`);
  return { clientId: app.appId, principalId: principal.id };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const env = JSON.parse(execFileSync('azd', ['env', 'get-values', '--output', 'json'], { encoding: 'utf8' }));
    await configurePromptGatewayEntra({ env });
  } catch (error) {
    console.error(`Prompt gateway Entra configuration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
