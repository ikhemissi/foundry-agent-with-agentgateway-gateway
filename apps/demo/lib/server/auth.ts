import { createHash, createPrivateKey, createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from "jose";
import { ManagedIdentityCredential } from "@azure/identity";
import type { DemoConfig, Tutor } from "./config";
import { DemoError } from "./errors";

export interface AuthenticatedUser {
  oid: string;
  assertion: string;
}

const keySets = new Map<string, JWTVerifyGetKey>();

function tenantKeys(tenant: string): JWTVerifyGetKey {
  let keys = keySets.get(tenant);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
    keySets.set(tenant, keys);
  }
  return keys;
}

export async function authenticate(
  authorization: string | null,
  config: DemoConfig,
  getKey?: JWTVerifyGetKey,
): Promise<AuthenticatedUser> {
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization ?? "");
  if (!match) throw new DemoError("authentication", "missing_token", "Sign in before using the demo.", 401);
  const issuer = `https://login.microsoftonline.com/${config.DEMO_TENANT_ID}/v2.0`;
  getKey ??= tenantKeys(config.DEMO_TENANT_ID);
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(match[1], getKey, {
      algorithms: ["RS256"], issuer, audience: config.DEMO_BLUEPRINT_CLIENT_ID,
      requiredClaims: ["exp", "iat", "oid", "tid", "azp", "scp"],
    }));
  } catch {
    throw new DemoError("authentication", "invalid_token", "The sign-in token is invalid or expired. Sign in again.", 401);
  }
  if (claims.tid !== config.DEMO_TENANT_ID || claims.azp !== config.DEMO_SPA_CLIENT_ID
      || claims.idtyp === "app" || typeof claims.scp !== "string"
      || !claims.scp.split(" ").includes(config.DEMO_USER_SCOPE)) {
    throw new DemoError("authentication", "invalid_delegation", "A delegated token from this demo's sign-in client is required.", 403);
  }
  if (claims.oid !== config.AZURE_PRINCIPAL_ID) {
    throw new DemoError("authentication", "user_not_allowed", "This user is not authorized for the demo.", 403);
  }
  return { oid: config.AZURE_PRINCIPAL_ID, assertion: match[1] };
}

export async function verifyGatewayDelegation(token: string, config: DemoConfig, getKey?: JWTVerifyGetKey) {
  try {
    const { payload } = await jwtVerify(token, getKey ?? tenantKeys(config.DEMO_TENANT_ID), {
      algorithms: ["RS256"], issuer: `https://login.microsoftonline.com/${config.DEMO_TENANT_ID}/v2.0`,
      audience: config.AGENTGATEWAY_ENTRA_CLIENT_ID,
      requiredClaims: ["exp", "iat", "oid", "tid", "azp", "scp"],
    });
    if (payload.tid !== config.DEMO_TENANT_ID || payload.oid !== config.AZURE_PRINCIPAL_ID
      || payload.azp !== config.HOSTED_AGENT_PRINCIPAL_ID || payload.idtyp === "app"
      || typeof payload.scp !== "string" || !payload.scp.split(" ").includes("gateway.invoke")) {
      throw new Error("Unexpected delegation");
    }
  } catch {
    throw new DemoError("authentication", "unexpected_gateway_identity", "The gateway token does not match the required signed user-via-agent identity.", 403);
  }
}

export async function certificateAssertion(config: DemoConfig): Promise<string> {
  if (config.DEMO_AUTH_MODE !== "certificate") {
    throw new DemoError("exchange", "invalid_credential_mode", "Certificate authentication is not enabled.");
  }
  const [certificatePem, privatePem] = await Promise.all([
    readFile(config.DEMO_CERTIFICATE_PATH, "utf8"),
    readFile(config.DEMO_PRIVATE_KEY_PATH, "utf8"),
  ]);
  const certificate = new X509Certificate(certificatePem);
  const key = createPrivateKey(privatePem);
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)
      || key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || !createPublicKey(key).export({ type: "spki", format: "der" }).equals(certificate.publicKey.export({ type: "spki", format: "der" }))) {
    throw new DemoError("exchange", "invalid_certificate", "The configured RSA certificate is expired, not yet valid, or does not match its private key.");
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", x5t: createHash("sha1").update(certificate.raw).digest("base64url") })
    .setIssuer(config.DEMO_BLUEPRINT_CLIENT_ID)
    .setSubject(config.DEMO_BLUEPRINT_CLIENT_ID)
    .setAudience(`https://login.microsoftonline.com/${config.DEMO_TENANT_ID}/oauth2/v2.0/token`)
    .setJti(randomUUID()).setIssuedAt().setExpirationTime("5m").sign(key);
}

interface AssertionCredential {
  getToken(scope: string, options: { abortSignal: AbortSignal }): Promise<{ token: string } | null>;
}

export async function blueprintAssertion(
  config: DemoConfig, signal: AbortSignal, credential?: AssertionCredential,
): Promise<string> {
  if (config.DEMO_AUTH_MODE === "certificate") return certificateAssertion(config);
  credential ??= new ManagedIdentityCredential({ clientId: config.DEMO_MANAGED_IDENTITY_CLIENT_ID });
  let result;
  try {
    result = await credential.getToken("api://AzureADTokenExchange/.default", {
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch {
    signal.throwIfAborted();
    throw new DemoError("exchange", "managed_identity_unavailable",
      "The configured managed identity could not acquire a blueprint assertion. Check its assignment and Azure hosting environment.");
  }
  if (!result?.token || /\s/.test(result.token)) {
    throw new DemoError("exchange", "invalid_managed_identity_token", "Managed identity did not return a usable assertion.");
  }
  return result.token;
}

export async function acquireTokens(
  user: AuthenticatedUser, tutor: Tutor, config: DemoConfig, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  sign: (config: DemoConfig, signal: AbortSignal) => Promise<string> = blueprintAssertion,
): Promise<{ foundry: string; gateway?: string }> {
  const url = `https://login.microsoftonline.com/${config.DEMO_TENANT_ID}/oauth2/v2.0/token`;
  const assertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
  async function token(fields: Record<string, string>) {
    const response = await fetchImpl(url, {
      method: "POST", redirect: "error",
      body: new URLSearchParams(fields),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DemoError("exchange", "entra_rejected", `Entra rejected the Agent ID exchange (HTTP ${response.status}). Check consent, inheritance, and the configured blueprint credential.`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("access_token" in body)
        || typeof body.access_token !== "string" || !body.access_token || /\s/.test(body.access_token)) {
      throw new DemoError("exchange", "invalid_token_response", "Entra did not return a usable access token.");
    }
    return body.access_token;
  }
  const exchange = await token({
    client_id: config.DEMO_BLUEPRINT_CLIENT_ID,
    client_assertion_type: assertionType, client_assertion: await sign(config, signal),
    grant_type: "client_credentials", scope: "api://AzureADTokenExchange/.default",
    fmi_path: config.HOSTED_AGENT_PRINCIPAL_ID,
  });
  const delegated = (scope: string) => token({
    client_id: config.HOSTED_AGENT_PRINCIPAL_ID,
    client_assertion_type: assertionType, client_assertion: exchange,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: user.assertion, requested_token_use: "on_behalf_of", scope,
  });
  const [foundry, gateway] = await Promise.all([
    delegated("https://ai.azure.com/.default"),
    tutor === "hosted" ? delegated(`api://${config.AGENTGATEWAY_ENTRA_CLIENT_ID}/gateway.invoke`) : undefined,
  ]);
  return { foundry, gateway };
}
