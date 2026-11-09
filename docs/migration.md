# Existing-environment migration

This is a breaking change for API-key clients and hosted app-only callers.
Before changing a running deployment, prepare the trusted OBO caller.

1. Reuse the existing gateway/prompt registrations with
   `configure-gateway-entra.mjs`, and run the prompt credential helper. Existing
   deployments do not need the fresh-install bootstrap.
2. Reprovision with only `PROMPT_GATEWAY_CLIENT_SECRET` as shown above. This
   replaces the gateway routes and prompt connection. The hosted app-only
   version will no longer infer; schedule the transition accordingly.
3. Deploy the hosted agent, then verify prompt OAuth and hosted delegated
   inference using the trusted backend.
4. Preview and apply removal of the obsolete key and its readers:

   ```bash
   node scripts/remove-legacy-gateway-key.mjs
   node scripts/remove-legacy-gateway-key.mjs --apply
   ```

The [cleanup helper](../scripts/remove-legacy-gateway-key.mjs) refuses cleanup until
the prompt connection uses OAuth2, the latest hosted version is active and
delegated-only, active gateway revisions no longer reference the key, and the
old `/v1/chat/completions` endpoint returns 404. It removes any remaining
Container Apps secret named `agentgateway-api-key`, exact-secret-scoped
**Key Vault Secrets User** assignments, and the Key Vault secret of that name.
It does not delete the prompt-client secret, inherited permissions, the vault,
or telemetry permissions. Key Vault deletion is soft deletion, never purge.
Incomplete metadata or resources remaining after deletion cause an explicit failure.

**Tested environment cleanup — 18 October 2026:** in
`agentgateway-uksouth-demo`, the obsolete vault secret was soft-deleted and its
one exact-secret-scoped reader assignment was removed. The Container App shared
key was already absent. A fresh preview confirmed no legacy cleanup resources
remain; the prompt OAuth secret remains enabled. No purge was performed.
These are environment-specific results, not an automatic migration for other
deployments. Both tutors' live acceptance checks were rerun after cleanup and
passed.

Incremental Bicep alone does **not** remove previously created secrets or roles.
The cleanup is explicit, not an automatic deployment hook.
Remove obsolete `AGENTGATEWAY_AUTH_MODE`, `HOSTED_GATEWAY_AUTH_MODE`,
`AGENTGATEWAY_TOKEN_SCOPE`, and any old API-key values from local azd/shell/CI
configuration. They no longer select supported modes.
