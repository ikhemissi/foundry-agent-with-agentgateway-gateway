import { randomUUID } from "node:crypto";
import type { JWTVerifyGetKey } from "jose";
import { acquireTokens, verifyGatewayDelegation, type AuthenticatedUser } from "./auth";
import type { DemoConfig, Tutor } from "./config";
import { DemoError } from "./errors";
import { streamFoundry } from "./foundry";

export interface CheckResult {
  check: string;
  status: "passed";
  requestId: string;
  durationMs: number;
}

export async function runAcceptance({
  user, config, signal, fetchImpl = fetch, tokensProvider = acquireTokens, gatewayKey,
}: {
  user: AuthenticatedUser; config: DemoConfig; signal: AbortSignal; fetchImpl?: typeof fetch;
  tokensProvider?: typeof acquireTokens; gatewayKey?: JWTVerifyGetKey;
}): Promise<CheckResult[]> {
  if (!config.AGENTGATEWAY_ENDPOINT) {
    throw new DemoError("request", "missing_gateway_endpoint", "Export AGENTGATEWAY_ENDPOINT to run the full live acceptance checks.", 400);
  }
  const checks: CheckResult[] = [];
  const gateway = new URL(config.AGENTGATEWAY_ENDPOINT).origin;
  const hosted = await tokensProvider(user, "hosted", config, signal);
  if (!hosted.gateway) throw new DemoError("authentication", "missing_gateway_token", "No delegated gateway token was acquired.", 401);
  const verifyStart = performance.now();
  await verifyGatewayDelegation(hosted.gateway, config, gatewayKey);
  checks.push({ check: "Signed gateway token has the configured human, hosted Agent ID, audience, and scope",
    status: "passed", requestId: randomUUID(), durationMs: Math.round(performance.now() - verifyStart) });
  for (const tutor of ["hosted", "prompt"] satisfies Tutor[]) {
    const requestId = randomUUID();
    const start = performance.now();
    const tokens = tutor === "hosted" ? hosted : await tokensProvider(user, "prompt", config, signal);
    let output = "";
    for await (const delta of streamFoundry({
      config, tutor, tokens, signal, requestId, fetchImpl,
      messages: [{ role: "user", content: "Explain one half in one short sentence." }],
    })) output += delta;
    if (!output.trim()) throw new DemoError("foundry", "empty_response", `The ${tutor} tutor completed without text.`);
    if (tutor === "hosted") {
      let continuation = "";
      for await (const delta of streamFoundry({
        config, tutor, tokens, signal, requestId, fetchImpl,
        messages: [{ role: "user", content: "Explain one half in one short sentence." },
          { role: "assistant", content: output }, { role: "user", content: "Now explain one quarter just as briefly." }],
      })) continuation += delta;
      if (!continuation.trim()) throw new DemoError("foundry", "empty_response", "The hosted tutor continuation completed without text.");
    }
    checks.push({ check: tutor === "hosted" ? "Hosted delegated streaming and stateless continuation"
      : "Prompt streaming through the managed OAuth2 connection", status: "passed", requestId,
    durationMs: Math.round(performance.now() - start) });
  }
  for (const scenario of [
    { check: "Gateway rejects missing authorization", path: "/delegated/v1/chat/completions" },
    { check: "Gateway rejects a Foundry-audience token", path: "/delegated/v1/chat/completions", token: hosted.foundry },
    { check: "Legacy shared-key route is absent", path: "/v1/chat/completions", absent: true },
  ]) {
    const requestId = randomUUID();
    const start = performance.now();
    const response = await fetchImpl(`${gateway}${scenario.path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { "Content-Type": "application/json", "x-ms-client-request-id": requestId,
        ...(scenario.token ? { Authorization: `Bearer ${scenario.token}` } : {}) },
      body: JSON.stringify({ model: "gpt-5.4-nano", messages: [{ role: "user", content: "Authorization denial check" }] }),
    });
    await response.body?.cancel();
    if (scenario.absent ? response.status !== 404 : ![401, 403].includes(response.status)) {
      throw new DemoError("foundry", "acceptance_denial_failed",
        `${scenario.check}: expected ${scenario.absent ? "404" : "401/403"}, received HTTP ${response.status}.`);
    }
    checks.push({ check: scenario.check, status: "passed", requestId, durationMs: Math.round(performance.now() - start) });
  }
  return checks;
}
