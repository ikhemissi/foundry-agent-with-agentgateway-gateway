# Local CopilotKit demo

[apps/demo](../apps/demo) is one Next.js application: React/CopilotKit and MSAL in the
browser, plus JWT validation, Agent ID OBO, and a streaming
Responses-to-AG-UI adapter on the server. There is no Python/FastAPI middle tier
and no local model or extra agent. The hosted tutor still runs Python/MAF in
Foundry. Both tutors keep their existing definitions and gateway policies.

| Run location | Backend blueprint credential | Hosting |
| --- | --- | --- |
| Local development | Certificate; explicit `DEMO_AUTH_MODE=certificate` | Loopback-only Next.js server |
| Azure | Federated managed identity; explicit `DEMO_AUTH_MODE=managed-identity` | Separate demo Container App |

Both use the [same two-stage OBO flow](../README.md#demo-authentication-same-obo-flow-different-backend-credentials).

The browser token targets the hosted agent's **parent blueprint API**, not the
gateway or Foundry. The backend checks its signature, issuer, tenant, audience,
SPA client, delegated scope, expiration, and authorized human before any OBO
exchange. Only that human is allowed; signing in as another tenant user is not
enough. Agent IDs, endpoints, scope names, and credentials come from server
configuration, never browser-provided overrides.

## 1. Prepare local dependencies and a certificate

Use Node.js 22 or later. From the repository root:

```bash
npm ci --prefix apps/demo
mkdir -p .certificates
chmod 700 .certificates
```

Generate a dedicated local certificate only if these files do not already exist.
Do not overwrite an existing credential just to restart the app:

```bash
(umask 077; openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout .certificates/demo.key -out .certificates/demo.pem \
  -days 365 -subj "/CN=foundry-agentgateway-local-demo")
chmod 600 .certificates/demo.key
```

These files are ignored by Git. The public certificate is uploaded to the parent
blueprint; the private key stays on this machine. Neither its contents nor a
client secret are written to azd environment state. For production, prefer
managed-identity federation and a hosted, access-controlled backend rather than
copying the local private key to a service.

## 2. Preview, then explicitly configure Entra

First deploy the hosted tutor so `HOSTED_AGENT_PRINCIPAL_ID` identifies the actual
hosted Agent ID. Sign in to Azure CLI in the same tenant as the selected azd
environment. With an existing deployment, prepare the caller before switching
gateway authentication as described under migration.

```bash
node scripts/configure-demo-entra.mjs
```

The [setup helper](../scripts/configure-demo-entra.mjs) defaults to **read-only
preview**. It discovers and checks the hosted identity's real parent blueprint,
then describes the API scope, public certificate, two downstream permissions,
user-specific grants, and dedicated SPA registration. Review the plan before:

```bash
node scripts/configure-demo-entra.mjs --apply
node scripts/configure-demo-entra.mjs --write-env
```

`--apply` performs directory changes and saves only the nonsecret SPA/blueprint
IDs and origin in azd. [demo-entra.bicep](../infra/demo-entra.bicep) uses the existing
pinned Graph extension for the SPA, service principal, and SPA-to-blueprint
consent. Narrow Graph REST operations adopt the existing Foundry-owned blueprint,
preserve unrelated API settings, credentials, scopes, and grants, and configure
its Agent ID inheritance, which this pinned Bicep extension does not model.
The helper rereads Graph and fails if blueprint changes did not persist.

The downstream permissions are `https://ai.azure.com` / `user_impersonation` and
the gateway API / `gateway.invoke`. Consent grants are for `AZURE_PRINCIPAL_ID`,
not tenant-wide. **Blueprint inheritance applies to its child identities**, not
just this UI: review other children before applying. Existing broad inheritance
or grants are preserved, not silently narrowed. The helper does not grant Azure
RBAC or rotate/delete existing credentials. Agent ID blueprint administration
and delegated-consent permissions can require additional directory roles; an
application-management role alone is not a guarantee.

`--write-env` exports an allowlist to ignored `apps/demo/.env.local` with mode
`0600`. It refuses to overwrite an existing file, validates private-key file
permissions, and never exports the prompt client's secret. Review the existing
file before explicitly removing/re-exporting it. See
[.env.example](../apps/demo/.env.example) for the configuration contract.
`DEMO_CERTIFICATE_PATH` and `DEMO_PRIVATE_KEY_PATH` can point to alternative
absolute paths. Set `DEMO_ORIGIN` before preview/apply to use a different origin.

The default origin is **`http://localhost:3000`** and the registered SPA callback
is **`http://localhost:3000/auth/callback`**. MSAL uses a dedicated redirect-bridge
page and **popup sign-in**, allowing access tokens to remain memory-only; allow
the popup. Do not browse `127.0.0.1` while configuring `localhost`, or change the
port without updating the origin/registration.

## 3. Start and compare the tutors

```bash
npm run dev --prefix apps/demo
```

Open `http://localhost:3000` or select **Debug CopilotKit demo** in VS Code.
The server binds to loopback. Sign in as the configured human, choose the hosted
or prompt tutor, and send a message. Chat is text-only, with 1-40 messages per
request, at most 16,000 characters per message and a 128 KiB request limit.
Client-defined tools, system instructions, endpoint overrides, and attachments
are unsupported. The upstream run is foreground, streamed, and `store:false`;
the current page supplies its history. There is no application database or global
downstream token cache. CopilotKit keeps bounded process-local run/event state
for runtime coordination; it is not a durable chat store. Resetting, changing
tutor, signing out, or reloading the page starts a fresh UI conversation; it does
not promise immediate erasure of runtime memory or Azure diagnostic records.

**Stop** aborts the bridge's active Foundry HTTP request. The next request can
continue normally; this was verified live after fixing the adapter's
`abortRun()` implementation. Cancellation does not prove that Foundry or the
source model stops computation or billing.

Sign-in tokens renew silently while the page is open. If interaction is needed,
chat unmounts until sign-in is renewed. The backend remains authoritative even
when the browser has a token. Errors expose safe stage/code/request identifiers,
not assertions, private keys, token endpoint response bodies, or model prompts.
CopilotKit server telemetry is disabled; the existing Azure monitoring remains.

## 4. Test offline, then run explicit live acceptance

```bash
npm test --prefix apps/demo
npm run typecheck --prefix apps/demo
npm run lint --prefix apps/demo
npm run build --prefix apps/demo
cd apps/demo
npx playwright install --with-deps chromium
npm run test:browser
```

Browser tests use mocked Entra and Foundry responses with the real CopilotKit
runtime/adapter, including a real MSAL popup/redirect-bridge round trip, chat,
tutor isolation, reset, sign-out, forced silent renewal, and recovery when Entra
requires interaction. No authentication bypass is exposed by
the application; test doubles are confined to the test runner.
Server tests use signed local JWTs, real certificate assertions, mocked token
endpoints and Responses streams, and the real CopilotKit HTTP runtime. They cover
wrong tenant/user/caller/audience/scope, expiry, credential isolation, malformed
and truncated streams, HTTP-200 failure events, cancellation, and output limits.
The actual CopilotKit Stop endpoint is tested for upstream abort, stale-run
rejection, and a successful subsequent run on the same thread.
The Graph setup tests also verify preview-only behavior, preservation,
user-specific consent, persistence checks, and safe environment export.

Offline success is **not** proof of deployed user OBO. After the explicit
identity setup and identity-only rollout, sign in and select **Run live checks**:

- Verify the signed gateway token's human, hosted actor, audience, tenant, and scope.
- Complete hosted streaming and a stateless follow-up.
- Complete prompt streaming through its existing managed OAuth2 connection.
- Confirm the delegated gateway route denies missing and wrong-audience tokens.
- Confirm the old `/v1/chat/completions` route returns 404.

This makes **three model calls** and can incur Azure charges. It does not mutate
Azure, deploy, create credentials, or remove the legacy key. Results contain only
check names, duration, and request IDs. A failed check is not reported as passed.
Expired tokens, wrong gateway actors/users, and stream failure cases are tested
offline; the live button does not mint extra identities just to reproduce them.
The prompt success check relies on the deployed OAuth2 connection and the
gateway's strict prompt-client policy; use Azure diagnostics for that identity's
audit trail.

Select **Check silent renewal** to bypass MSAL's access-token cache and request a
token from Entra. The UI reports only success and expiry, never token contents.
Then rerun the live checks to verify that the renewed token works through OBO.
If Entra requires interaction, the chat is unmounted, in-flight live checks are
aborted, and **Renew sign-in** is offered. This forced-renewal check does not
prove natural expiry or a multi-hour session; those need a separate soak test.
Browser regression tests simulate successful renewal and interaction-required
recovery; they are not live Entra evidence.

For a caller that already supplies a legitimate SPA-to-blueprint assertion via
a protected file or stdin, an equivalent CLI runner is available:

```bash
cd apps/demo
npm run test:live -- --token-file /absolute/path/to/owner-only-assertion-file
# Or pipe the assertion from a trusted source:
# <trusted-source> | npm run test:live -- --stdin
```

Do not paste tokens into command-line arguments, terminal output, source files,
or shared logs. The UI button needs no manual token extraction and is preferred.
Delete any temporary assertion file after use. The CLI does not sign in as an
application if a user assertion is missing or rejected.

For certificate rotation, generate a new pair at different ignored paths,
preview/apply the new public certificate, update the local paths, and test both
tutors before separately retiring the old certificate. Nothing deletes or
replaces an old credential automatically.
