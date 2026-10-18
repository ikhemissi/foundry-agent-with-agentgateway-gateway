import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { authenticate, acquireTokens, blueprintAssertion, certificateAssertion } from "../lib/server/auth";
import { getConfig, publicConfig } from "../lib/server/config";
import { reportError } from "../lib/server/errors";
import { config, environment, id } from "./helpers";

const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
const getKey = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
async function signed(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    tid: config.DEMO_TENANT_ID, oid: config.AZURE_PRINCIPAL_ID, azp: config.DEMO_SPA_CLIENT_ID,
    scp: config.DEMO_USER_SCOPE, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(typeof overrides.iss === "string" ? overrides.iss : `https://login.microsoftonline.com/${config.DEMO_TENANT_ID}/v2.0`)
    .setAudience(typeof overrides.aud === "string" ? overrides.aud : config.DEMO_BLUEPRINT_CLIENT_ID)
    .setIssuedAt().setExpirationTime(typeof overrides.exp === "number" ? overrides.exp : "5m").sign(keys.privateKey);
}

test("validates signed delegated JWT and returns the original assertion", async () => {
  const jwt = await signed();
  assert.deepEqual(await authenticate(`Bearer ${jwt}`, config, getKey), { oid: config.AZURE_PRINCIPAL_ID, assertion: jwt });
});
for (const [label, overrides] of [
  ["tenant", { tid: id(20) }], ["caller", { azp: id(20) }], ["user", { oid: id(20) }],
  ["scope", { scp: "different" }], ["application", { idtyp: "app" }], ["missing scope", { scp: undefined }],
  ["audience", { aud: id(20) }], ["issuer", { iss: "https://example.com" }], ["expired", { exp: 1 }],
] as const) {
  test(`rejects ${label} mismatch without identity fallback`, async () => {
    await assert.rejects(authenticate(`Bearer ${await signed(overrides)}`, config, getKey), /token|delegated|authorized/);
  });
}
test("rejects missing, combined, whitespace, and forged bearer tokens", async () => {
  for (const value of [null, "", "Basic abc", "Bearer a b", "Bearer a,b", `Bearer ${await signed()}forged`]) {
    await assert.rejects(authenticate(value, config, getKey));
  }
});
test("exports only public auth config and constrains server endpoints", () => {
  assert.deepEqual(Object.keys(publicConfig(config)).sort(), ["clientId", "localEvaluations", "origin", "scope", "tenantId"]);
  for (const endpoint of ["http://consumer.services.ai.azure.com/api/projects/a",
    "https://evil.example/api/projects/a", `${environment.CONSUMER_FOUNDRY_PROJECT_ENDPOINT}?next=evil`]) {
    assert.throws(() => getConfig({ ...environment, CONSUMER_FOUNDRY_PROJECT_ENDPOINT: endpoint }));
  }
  assert.throws(() => getConfig({ ...environment, DEMO_ORIGIN: "http://not-local.example" }));
  assert.throws(() => getConfig({ ...environment, DEMO_ORIGIN: "https://user:pass@example.com" }));
});
test("exchanges certificate credential for child Agent ID then separate downstream tokens", async () => {
  const requests: URLSearchParams[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), `https://login.microsoftonline.com/${config.DEMO_TENANT_ID}/oauth2/v2.0/token`);
    assert.equal(init?.redirect, "error");
    const body = new URLSearchParams(String(init?.body));
    requests.push(body);
    return Response.json({ access_token: body.get("grant_type") === "client_credentials" ? "exchange" : body.get("scope") });
  };
  const tokens = await acquireTokens({ oid: id(5), assertion: "user-assertion" }, "hosted", config,
    new AbortController().signal, fakeFetch, async () => "signed-certificate");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].get("fmi_path"), id(4));
  assert.equal(requests[0].get("client_id"), id(3));
  assert.equal(requests[0].get("client_assertion"), "signed-certificate");
  for (const body of requests.slice(1)) {
    assert.equal(body.get("client_id"), id(4));
    assert.equal(body.get("client_assertion"), "exchange");
    assert.equal(body.get("assertion"), "user-assertion");
    assert.equal(body.get("requested_token_use"), "on_behalf_of");
    assert.equal(body.has("client_secret"), false);
  }
  assert.equal(tokens.foundry, "https://ai.azure.com/.default");
  assert.equal(tokens.gateway, `api://${id(6)}/gateway.invoke`);
});
test("prompt comparison never requests a gateway token or prompt client secret", async () => {
  const scopes: string[] = [];
  const fakeFetch: typeof fetch = async (_, init) => {
    scopes.push(new URLSearchParams(String(init?.body)).get("scope")!);
    return Response.json({ access_token: "token" });
  };
  assert.deepEqual(await acquireTokens({ oid: id(5), assertion: "user" }, "prompt", config,
    new AbortController().signal, fakeFetch, async () => "cert"), { foundry: "token", gateway: undefined });
  assert.deepEqual(scopes, ["api://AzureADTokenExchange/.default", "https://ai.azure.com/.default"]);
});
test("Entra denial is safe, explicit, and does not retry with a different credential", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response("SECRET ASSERTION", { status: 403 }); };
  await assert.rejects(acquireTokens({ oid: id(5), assertion: "user" }, "hosted", config,
    new AbortController().signal, fakeFetch, async () => "cert"), /Entra rejected/);
  assert.equal(calls, 1);
  for (const body of [{}, { access_token: "" }, { access_token: "two tokens" }]) {
    await assert.rejects(acquireTokens({ oid: id(5), assertion: "user" }, "hosted", config,
      new AbortController().signal, async () => Response.json(body), async () => "cert"), /usable access token/);
  }
});
test("certificate assertions use matching RSA certificate, thumbprint, audience, and short lifetime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demo-cert-"));
  try {
    const certificate = join(directory, "cert.pem");
    const privateKey = join(directory, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
      "-out", certificate, "-days", "1", "-subj", "/CN=offline-demo-test"], { stdio: "ignore" });
    const local = { ...config, DEMO_AUTH_MODE: "certificate" as const,
      DEMO_CERTIFICATE_PATH: certificate, DEMO_PRIVATE_KEY_PATH: privateKey };
    const cert = new X509Certificate(readFileSync(certificate));
    const assertion = await certificateAssertion(local);
    const { payload, protectedHeader } = await jwtVerify(assertion, cert.publicKey, {
      issuer: id(3), subject: id(3), audience: `https://login.microsoftonline.com/${id(1)}/oauth2/v2.0/token`,
    });
    assert.equal(protectedHeader.x5t, createHash("sha1").update(cert.raw).digest("base64url"));
    assert.ok(payload.exp! - payload.iat! <= 300);
    assert.notEqual((await certificateAssertion(local)), assertion);
    const otherKey = join(directory, "other.pem");
    execFileSync("openssl", ["genrsa", "-out", otherKey, "2048"], { stdio: "ignore" });
    await assert.rejects(certificateAssertion({ ...local, DEMO_PRIVATE_KEY_PATH: otherKey }), /does not match/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test("unexpected errors do not leak credentials or exception bodies", () => {
  const result = reportError(new Error("SECRET-user-assertion"), "safe-request");
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(result.body.error.requestId, "safe-request");
});

const managed = getConfig({
  ...environment, DEMO_AUTH_MODE: "managed-identity", DEMO_ORIGIN: "https://demo.example.com",
  DEMO_MANAGED_IDENTITY_CLIENT_ID: id(80), DEMO_CERTIFICATE_PATH: undefined, DEMO_PRIVATE_KEY_PATH: undefined,
});
test("credential modes are explicit and managed identity never accepts local key configuration", () => {
  assert.throws(() => getConfig({ ...environment, DEMO_AUTH_MODE: undefined }));
  assert.throws(() => getConfig({ ...environment, DEMO_AUTH_MODE: "automatic" }));
  assert.throws(() => getConfig({ ...environment, DEMO_ORIGIN: "https://demo.example.com" }), /loopback/);
  assert.throws(() => getConfig({ ...environment, DEMO_AUTH_MODE: "managed-identity",
    DEMO_MANAGED_IDENTITY_CLIENT_ID: id(80) }), /must not configure/);
  assert.throws(() => getConfig({ ...environment, DEMO_AUTH_MODE: "managed-identity",
    DEMO_CERTIFICATE_PATH: undefined, DEMO_PRIVATE_KEY_PATH: undefined }), /MANAGED_IDENTITY/);
  assert.equal("DEMO_CERTIFICATE_PATH" in managed, false);
  assert.deepEqual(Object.keys(publicConfig(managed)).sort(), ["clientId", "localEvaluations", "origin", "scope", "tenantId"]);
  assert.equal(publicConfig(managed).localEvaluations, false);
});
test("managed identity acquires only the token-exchange audience and retains user-via-agent OBO", async () => {
  const signal = new AbortController().signal;
  const credential = {
    async getToken(scope: string, options: { abortSignal: AbortSignal }) {
      assert.equal(scope, "api://AzureADTokenExchange/.default");
      assert.ok(options.abortSignal instanceof AbortSignal);
      return { token: "managed-identity-assertion" };
    },
  };
  const bodies: URLSearchParams[] = [];
  await acquireTokens({ oid: id(5), assertion: "signed-user" }, "hosted", managed, signal,
    async (_, init) => {
      const body = new URLSearchParams(String(init?.body));
      bodies.push(body);
      return Response.json({ access_token: bodies.length === 1 ? "blueprint-exchange" : "delegated-token" });
    }, (config, requestSignal) => blueprintAssertion(config, requestSignal, credential));
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].get("client_assertion"), "managed-identity-assertion");
  assert.equal(bodies[0].get("client_id"), managed.DEMO_BLUEPRINT_CLIENT_ID);
  assert.equal(bodies[0].get("fmi_path"), managed.HOSTED_AGENT_PRINCIPAL_ID);
  for (const body of bodies.slice(1)) {
    assert.equal(body.get("client_id"), managed.HOSTED_AGENT_PRINCIPAL_ID);
    assert.equal(body.get("client_assertion"), "blueprint-exchange");
    assert.equal(body.get("assertion"), "signed-user");
    assert.equal(body.get("requested_token_use"), "on_behalf_of");
  }
});
test("managed identity denial and empty responses fail without certificate fallback or leaked errors", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  await assert.rejects(blueprintAssertion(managed, signal, {
    async getToken() { calls++; throw new Error("sensitive-identity-error"); },
  }), /configured managed identity/);
  assert.equal(calls, 1);
  for (const value of [null, { token: "" }, { token: "invalid token" }]) {
    await assert.rejects(blueprintAssertion(managed, signal, { async getToken() { return value; } }), /usable assertion/);
  }
  await assert.rejects(certificateAssertion(managed), /not enabled/);
});
test("managed identity cancellation remains cancellation rather than a credential fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(blueprintAssertion(managed, controller.signal, {
    async getToken() { throw new Error("aborted"); },
  }), { name: "AbortError" });
});
