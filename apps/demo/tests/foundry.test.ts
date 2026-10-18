import assert from "node:assert/strict";
import { test } from "node:test";
import { sseData, streamFoundry, type ChatMessage } from "../lib/server/foundry";
import { config, collect, complete, text, streamResponse } from "./helpers";

const messages: ChatMessage[] = [{ role: "user", content: "Explain fractions" }];
const args = { config, tutor: "hosted" as const, messages, tokens: { foundry: "foundry-token", gateway: "gateway-token" },
  requestId: "request-test", signal: new AbortController().signal };

test("SSE parser handles fragmented UTF8, CRLF, multiline data and comments", async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\ndata: héllo\r\ndata: world\r\n\r\n');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
  assert.deepEqual(await collect(sseData(body)), ["héllo\nworld"]);
});
test("SSE parser rejects unterminated and oversized events", async () => {
  await assert.rejects(collect(sseData(new Response("data: unfinished").body!)), /incomplete/);
  await assert.rejects(collect(sseData(new Response(`data: ${"x".repeat(1_048_577)}\n\n`).body!)), /oversized/);
});
test("hosted invocation forwards only fixed credentials and stateless history", async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), `${config.CONSUMER_FOUNDRY_PROJECT_ENDPOINT}/agents/ai-tutor-hosted-agent/endpoint/protocols/openai/responses?api-version=v1`);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer foundry-token");
    assert.equal(headers.get("x-client-agentgateway-access-token"), "gateway-token");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { input: messages, stream: true, store: false, background: false });
    return streamResponse(text("one ") + text("two") + complete);
  };
  assert.deepEqual(await collect(streamFoundry({ ...args, fetchImpl: fakeFetch })), ["one ", "two"]);
});
test("prompt invocation uses only Foundry token and fixed prompt agent", async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), `${config.CONSUMER_FOUNDRY_PROJECT_ENDPOINT}/agents/ai-tutor-prompt-agent/endpoint/protocols/openai/responses?api-version=v1`);
    assert.equal(new Headers(init?.headers).has("x-client-agentgateway-access-token"), false);
    assert.deepEqual(JSON.parse(String(init?.body)), { input: messages, stream: true, store: false, background: false });
    return streamResponse();
  };
  assert.deepEqual(await collect(streamFoundry({ ...args, tutor: "prompt", tokens: { foundry: "only" }, fetchImpl: fakeFetch })), ["Hello"]);
});
test("requires gateway token for hosted and rejects invalid histories before HTTP", async () => {
  await assert.rejects(collect(streamFoundry({ ...args, tokens: { foundry: "only" } })), /gateway token/);
  for (const history of [[], [{ role: "assistant" as const, content: "hi" }],
    [{ role: "user" as const, content: "x".repeat(16_001) }], Array.from({ length: 41 }, () => messages[0])]) {
    await assert.rejects(collect(streamFoundry({ ...args, messages: history })), /1-40 text messages/);
  }
});
for (const [label, payload] of [
  ["failed", 'data: {"type":"response.failed","response":{"error":"PRIVATE"}}\n\n'],
  ["incomplete", 'data: {"type":"response.incomplete"}\n\n'],
  ["error", 'data: {"type":"error","message":"PRIVATE"}\n\n'],
  ["invalid JSON", "data: {oops}\n\n"], ["invalid shape", "data: null\n\n"],
  ["wrong delta", 'data: {"type":"response.output_text.delta","delta":12}\n\n'],
  ["wrong completion", 'data: {"type":"response.completed","response":{"status":"failed"}}\n\n'],
  ["truncated", text("partial")], ["DONE without completion", "data: [DONE]\n\n"],
] as const) {
  test(`does not treat HTTP200 ${label} as success`, async () => {
    await assert.rejects(collect(streamFoundry({ ...args, fetchImpl: async () => streamResponse(payload) })));
  });
}
test("rejects HTTP denial without leaking remote body and refuses non-SSE", async () => {
  await assert.rejects(collect(streamFoundry({ ...args, fetchImpl: async () => new Response("PRIVATE", { status: 403 }) })),
    (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes("PRIVATE"));
  await assert.rejects(collect(streamFoundry({ ...args, fetchImpl: async () => Response.json({ text: "unexpected" }) })), /event stream/);
});
test("enforces cumulative output limit", async () => {
  const output = Array.from({ length: 3 }, () => text("x".repeat(800_000))).join("") + complete;
  await assert.rejects(collect(streamFoundry({ ...args, fetchImpl: async () => streamResponse(output) })), /output limit/);
});
test("cancels remaining upstream stream on completion", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(text("done") + complete)); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await collect(streamFoundry({ ...args, fetchImpl: async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } }) })), ["done"]);
  assert.equal(cancelled, true);
});
