import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { runAcceptance } from "../lib/server/acceptance";
import { config, id, streamResponse } from "./helpers";

const keys = await generateKeyPair("RS256");
const gatewayKey = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test" }] });
async function gatewayToken(overrides = {}) {
  return new SignJWT({ tid: id(1), oid: id(5), azp: id(4), scp: "gateway.invoke", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuedAt().setExpirationTime("5m")
    .setIssuer(`https://login.microsoftonline.com/${id(1)}/v2.0`).setAudience(id(6)).sign(keys.privateKey);
}
const liveConfig = { ...config, AGENTGATEWAY_ENDPOINT: "https://gateway.example.azurecontainerapps.io" };
const user = { oid: id(5), assertion: "PRIVATE-USER-ASSERTION" };
test("live runner verifies signed delegation, both tutors, continuation, denials and removed route", async () => {
  const requests: string[] = [];
  const tutors: string[] = [];
  const gateway = await gatewayToken();
  const results = await runAcceptance({
    user, config: liveConfig, signal: new AbortController().signal, gatewayKey,
    tokensProvider: async (_, tutor) => {
      tutors.push(tutor);
      return { foundry: "PRIVATE-FOUNDRY-TOKEN", ...(tutor === "hosted" ? { gateway } : {}) };
    },
    fetchImpl: async (url, init) => {
      requests.push(String(url));
      if (String(url).includes(".services.ai.azure.com")) return streamResponse();
      const legacy = String(url).endsWith("/v1/chat/completions") && !String(url).includes("/delegated/");
      assert.equal(new Headers(init?.headers).get("authorization"), legacy ? null
        : requests.length === 5 ? "Bearer PRIVATE-FOUNDRY-TOKEN" : null);
      return new Response(null, { status: legacy ? 404 : 401 });
    },
  });
  assert.deepEqual(tutors, ["hosted", "prompt"]);
  assert.equal(requests.filter((url) => url.includes("/agents/ai-tutor-hosted-agent/")).length, 2);
  assert.equal(results.length, 6);
  assert.ok(results.every((result) => result.status === "passed" && result.requestId && result.durationMs >= 0));
  assert.equal(JSON.stringify(results).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(results).includes(gateway), false);
});
test("live runner refuses wrong actor or application tokens before inference", async () => {
  for (const overrides of [{ azp: id(99) }, { oid: id(99) }, { idtyp: "app" }, { scp: "different.scope" }]) {
    const gateway = await gatewayToken(overrides);
    await assert.rejects(runAcceptance({
      user, config: liveConfig, signal: new AbortController().signal, gatewayKey,
      tokensProvider: async () => ({ foundry: "foundry", gateway }),
      fetchImpl: async () => { throw new Error("Inference must not be reached"); },
    }), /signed user-via-agent/);
  }
});
test("live runner does not turn failed or empty inference into passed acceptance", async () => {
  const gateway = await gatewayToken();
  for (const response of [new Response(null, { status: 403 }),
    streamResponse('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')]) {
    await assert.rejects(runAcceptance({
      user, config: liveConfig, signal: new AbortController().signal, gatewayKey,
      tokensProvider: async () => ({ foundry: "foundry", gateway }), fetchImpl: async () => response,
    }), /rejected|without text/);
  }
});
test("live runner fails if the delegated route permits missing credentials or the legacy route still exists", async () => {
  const gateway = await gatewayToken();
  for (const status of [200, 404, 500]) {
    await assert.rejects(runAcceptance({
      user, config: liveConfig, signal: new AbortController().signal, gatewayKey,
      tokensProvider: async () => ({ foundry: "foundry", gateway }),
      fetchImpl: async (url) => String(url).includes(".services.ai.azure.com") ? streamResponse() : new Response(null, { status }),
    }), /expected 401\/403/);
  }
});
