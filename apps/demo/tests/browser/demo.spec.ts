import { test, expect, type Page } from "@playwright/test";
import { handleRequest } from "../../lib/server/handler";
import { config, streamResponse, text, complete } from "../helpers";

const origin = "http://127.0.0.1:3007";
const tenant = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const blueprint = "00000000-0000-4000-8000-000000000003";
const oid = "00000000-0000-4000-8000-000000000005";
const scope = `api://${blueprint}/access_agent_as_user`;
const authority = `https://login.microsoftonline.com/${tenant}/v2.0`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function mockSignIn(page: Page, renewal?: { requests: number; reject: boolean }, localEvaluations = false) {
  let nonce = "";
  await page.route("**/api/config", (route) => route.fulfill({ json: { tenantId: tenant, clientId, scope, origin, localEvaluations } }));
  await page.context().route("https://login.microsoftonline.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/authorize")) {
      nonce = url.searchParams.get("nonce") ?? "";
      const callback = new URL(`${origin}/auth/callback`);
      callback.hash = new URLSearchParams({
        code: "offline-authorization-code", state: url.searchParams.get("state") ?? "",
      }).toString();
      await route.fulfill({ status: 302, headers: { location: callback.href } });
    } else if (url.pathname.endsWith("/token")) {
      const refreshing = new URLSearchParams(route.request().postData() ?? "").get("grant_type") === "refresh_token";
      if (refreshing && renewal) {
        renewal.requests++;
        if (renewal.reject) {
          await route.fulfill({ status: 400, json: {
            error: "interaction_required", error_description: "Offline renewal requires interaction.",
          } });
          return;
        }
      }
      const now = Math.floor(Date.now() / 1000);
      // Synthetic tokens are confined to the browser network mock, never accepted by the server.
      const token = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        aud: clientId, iss: authority, iat: now, nbf: now, exp: now + 3600, nonce, tid: tenant, oid,
        preferred_username: "learner@example.test", name: "Offline Learner", sub: oid,
      })}.offline-signature`;
      await route.fulfill({ json: {
        token_type: "Bearer", scope, expires_in: 3600, ext_expires_in: 3600,
        access_token: "OFFLINE-BROWSER-ASSERTION", id_token: token,
        refresh_token: "OFFLINE-REFRESH-TOKEN",
        client_info: encode({ uid: oid, utid: tenant }),
      } });
    } else if (url.pathname.includes("/discovery/instance")) {
      await route.fulfill({ json: {
        tenant_discovery_endpoint: `${authority}/.well-known/openid-configuration`,
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net",
          aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      } });
    } else if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      await route.fulfill({ json: {
        authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        issuer: authority, jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
        end_session_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`,
      } });
    } else if (url.pathname.endsWith("/logout")) {
      const callback = new URL(`${origin}/auth/callback`);
      callback.hash = new URLSearchParams({ state: url.searchParams.get("state") ?? "" }).toString();
      await route.fulfill({ status: 302, headers: { location: callback.href } });
    } else {
      throw new Error(`Unexpected mocked Entra call: ${url.pathname}`);
    }
  });
}

test("silent renewal bypasses the token cache and interaction-required removes authenticated chat", async ({ page }) => {
  const renewal = { requests: 0, reject: false };
  await mockSignIn(page, renewal);
  await page.route("**/api/copilotkit/**", (route) => route.fulfill({
    json: { agents: { hosted: { name: "hosted", description: "Offline tutor" } } },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByLabel("Tutor chat", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check silent renewal" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Entra silent renewal passed (not from cache)" })).toBeVisible();
  expect(renewal.requests).toBe(1);
  renewal.reject = true;
  await page.getByRole("button", { name: "Check silent renewal" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Your sign-in needs attention" })).toBeVisible();
  await expect(page.getByLabel("Tutor chat", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Entra silent renewal passed" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run live checks" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Renew sign-in" })).toBeVisible();
  expect(renewal.requests).toBe(2);
  await page.getByRole("button", { name: "Renew sign-in" }).click();
  await expect(page.getByLabel("Tutor chat", { exact: true })).toBeVisible();
});

test("configuration failures are visible without exposing environment values", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({ status: 500, json: { error: "safe" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Foundry + agentgateway" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "configuration is incomplete" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toHaveCount(0);
});

test("local smoke UI reuses the in-memory assertion and displays both scored summaries without text or tokens", async ({ page }) => {
  await mockSignIn(page, undefined, true);
  await page.route("**/api/copilotkit/**", (route) => route.fulfill({
    json: { agents: { hosted: { name: "hosted", description: "Offline tutor" } } },
  }));
  let runs = 0;
  await page.route("**/api/evaluations", (route) => {
    runs++;
    expect(route.request().headers().authorization).toBe("Bearer OFFLINE-BROWSER-ASSERTION");
    expect(route.request().postData()).toBe(null);
    return route.fulfill({ contentType: "application/x-ndjson", body: [
      { type: "started", expectedCases: 32, output: "agents/ai-tutor-hosted-agent/.foundry/results/offline.jsonl" },
      { type: "progress", completedCases: 1, expectedCases: 32, tutor: "hosted", caseId: "math-one", status: "scored", requestId: "offline-1" },
      { type: "complete", interrupted: false, qualityGate: "failed",
        output: "agents/ai-tutor-hosted-agent/.foundry/results/offline.jsonl",
        byTutor: [
          { tutor: "hosted", expectedCases: 16, scored: 16, passed: 16, errors: 0, passRate: 1, qualityGate: "passed" },
          { tutor: "prompt", expectedCases: 16, scored: 16, passed: 15, errors: 0, passRate: 15 / 16, qualityGate: "failed" },
        ] },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n" });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Run smoke evaluations with judging" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await page.getByRole("button", { name: "Run smoke evaluations with judging" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Provisional quality gate: failed" })).toBeVisible();
  await expect(page.getByLabel("Evaluation summaries")).toContainText("hosted: 16/16 scored, 16 passed");
  await expect(page.getByLabel("Evaluation summaries")).toContainText("prompt: 16/16 scored, 15 passed");
  await expect(page.getByLabel("Local tutor evaluations")).not.toContainText("OFFLINE-BROWSER-ASSERTION");
  await expect(page.getByRole("button", { name: "Run smoke evaluations with judging" })).toBeEnabled();
  expect(runs).toBe(1);
});

test("local smoke UI reports incomplete streams and permits cancellation", async ({ page }) => {
  await mockSignIn(page, undefined, true);
  await page.route("**/api/copilotkit/**", (route) => route.fulfill({
    json: { agents: { hosted: { name: "hosted", description: "Offline tutor" } } },
  }));
  await page.route("**/api/evaluations", (route) => route.fulfill({
    contentType: "application/x-ndjson", body: JSON.stringify({
      type: "started", expectedCases: 32, output: "agents/ai-tutor-hosted-agent/.foundry/results/incomplete.jsonl",
    }) + "\n",
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  const start = page.getByRole("button", { name: "Run smoke evaluations with judging" });
  await start.click();
  await expect(page.getByRole("alert").filter({ hasText: "ended before a summary arrived" })).toBeVisible();
  await page.unroute("**/api/evaluations");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/evaluations", async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: { message: "Offline unavailable", requestId: "offline" } } });
  });
  await start.click();
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "Cancel evaluations" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Evaluation cancelled" })).toBeVisible();
  release();
  await expect(start).toBeEnabled();
});

test("production configuration hides evaluations and the real endpoint rejects direct calls", async ({ page }) => {
  await mockSignIn(page);
  await page.route("**/api/copilotkit/**", (route) => route.fulfill({
    json: { agents: { hosted: { name: "hosted", description: "Offline tutor" } } },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByLabel("Tutor chat", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run smoke evaluations with judging" })).toHaveCount(0);
  const response = await page.request.post("/api/evaluations", { headers: { origin } });
  expect(response.status()).toBe(404);
  expect((await response.json()).error.code).toBe("local_evaluations_disabled");
});

test("MSAL sign-in, CopilotKit streaming, independent tutor selection, reset and sign-out", async ({ page }) => {
  const externalOrigins: string[] = [];
  page.context().on("request", (request) => {
    const target = new URL(request.url());
    if (!["http://127.0.0.1:3007", "https://login.microsoftonline.com"].includes(target.origin)) externalOrigins.push(target.origin);
  });
  await mockSignIn(page);
  const runs: { agent: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/copilotkit/**", async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe("Bearer OFFLINE-BROWSER-ASSERTION");
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/run")) {
      const body = request.postDataJSON();
      const agent = path.includes("/hosted/") ? "hosted" : "prompt";
      runs.push({ agent, body });
    }
    const response = await handleRequest(new Request(request.url(), {
      method: request.method(), headers: request.headers(), body: request.postData() ?? undefined,
    }), {
      config: () => ({ ...config, DEMO_ORIGIN: origin }),
      authenticate: async () => ({ oid, assertion: "OFFLINE-BROWSER-ASSERTION" }),
      tokens: async () => ({ foundry: "OFFLINE-FOUNDRY", gateway: "OFFLINE-GATEWAY" }),
      fetchImpl: async (url) => streamResponse(
        text(`${String(url).includes("ai-tutor-hosted-agent") ? "hosted" : "prompt"} explains fractions.`) + complete,
      ),
    });
    expect(response.status).toBe(200);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByText("learner@example.test", { exact: true })).toBeVisible({ timeout: 20_000 });
  const input = page.getByRole("textbox");
  await input.fill("Explain one half");
  await input.press("Enter");
  await expect(page.getByText("hosted explains fractions.", { exact: true })).toBeVisible();
  await page.getByLabel("Tutor", { exact: true }).selectOption("prompt");
  await expect(page.getByText("hosted explains fractions.", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox").fill("Explain one quarter");
  await page.getByRole("textbox").press("Enter");
  await expect(page.getByText("prompt explains fractions.", { exact: true })).toBeVisible();
  expect(runs.map((run) => run.agent)).toEqual(["hosted", "prompt"]);
  for (const run of runs) {
    expect(run.body.messages).toEqual([expect.objectContaining({ role: "user" })]);
  }
  await page.getByRole("button", { name: "Reset chat" }).click();
  await expect(page.getByText("prompt explains fractions.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in with Microsoft" })).toBeVisible();
  await expect(page.getByText("OFFLINE-BROWSER-ASSERTION")).toHaveCount(0);
  expect(externalOrigins).toEqual([]);
});
