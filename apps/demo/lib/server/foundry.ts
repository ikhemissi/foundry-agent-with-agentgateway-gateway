import { z } from "zod";
import type { DemoConfig, Tutor } from "./config";
import { DemoError } from "./errors";

const messagesSchema = z.array(z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(16_000),
})).min(1).max(40);
const eventSchema = z.object({
  type: z.string(), delta: z.unknown().optional(),
  response: z.object({ status: z.string().optional() }).passthrough().optional(),
}).passthrough();

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (end > 1_048_576) throw new DemoError("foundry", "invalid_stream", "Foundry returned an oversized stream event.");
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) yield data.join("\n");
          data = [];
          eventSize = 0;
        } else if (line.startsWith("data:")) {
          const content = line.slice(5).replace(/^ /, "");
          eventSize += content.length;
          if (eventSize > 1_048_576) throw new DemoError("foundry", "invalid_stream", "Foundry returned an oversized stream event.");
          data.push(content);
        }
      }
      if (buffer.length > 1_048_576) throw new DemoError("foundry", "invalid_stream", "Foundry returned an oversized stream event.");
      if (done) break;
    }
    if (buffer.trim() || data.length) throw new DemoError("foundry", "truncated_stream", "Foundry ended an incomplete stream event.");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function* streamFoundry({
  config, tutor, messages, tokens, signal, requestId, fetchImpl = fetch,
}: {
  config: DemoConfig; tutor: Tutor; messages: ChatMessage[];
  tokens: { foundry: string; gateway?: string }; signal: AbortSignal; requestId: string;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<string> {
  const input = messagesSchema.safeParse(messages);
  if (!input.success || input.data.at(-1)?.role !== "user") {
    throw new DemoError("request", "invalid_messages", "Send 1-40 text messages ending with a user message; system messages and tools are not supported.", 400);
  }
  if (tutor === "hosted" && !tokens.gateway) {
    throw new DemoError("authentication", "missing_gateway_token", "A delegated gateway token is required.", 401);
  }
  const project = config.CONSUMER_FOUNDRY_PROJECT_ENDPOINT.replace(/\/$/, "");
  const name = tutor === "hosted" ? "ai-tutor-hosted-agent" : "ai-tutor-prompt-agent";
  const endpoint = `${project}/agents/${name}/endpoint/protocols/openai/responses?api-version=v1`;
  const response = await fetchImpl(endpoint, {
    method: "POST", redirect: "error",
    headers: {
      Authorization: `Bearer ${tokens.foundry}`,
      "Content-Type": "application/json", "x-ms-client-request-id": requestId,
      ...(tutor === "hosted" ? { "x-client-agentgateway-access-token": tokens.gateway! } : {}),
    },
    body: JSON.stringify({
      input: input.data, stream: true, store: false, background: false,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DemoError("foundry", "invocation_rejected", `Foundry rejected the ${tutor} invocation (HTTP ${response.status}). Check the deployed version, caller access, and gateway policy.`);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new DemoError("foundry", "invalid_response", "Foundry did not return a Responses event stream.");
  }
  let completed = false;
  let outputSize = 0;
  for await (const data of sseData(response.body)) {
    if (data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new DemoError("foundry", "invalid_stream", "Foundry returned an invalid Responses event.");
    }
    const result = eventSchema.safeParse(parsed);
    if (!result.success) throw new DemoError("foundry", "invalid_stream", "Foundry returned an invalid Responses event.");
    const event = result.data;
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") throw new DemoError("foundry", "invalid_stream", "Foundry returned an invalid text delta.");
      outputSize += event.delta.length;
      if (outputSize > 2_097_152) throw new DemoError("foundry", "output_limit", "The response exceeded the demo output limit.");
      yield event.delta;
    } else if (["response.failed", "response.incomplete", "error"].includes(event?.type)) {
      throw new DemoError("foundry", "response_failed", "The agent failed to complete its response. Inspect Foundry diagnostics using the request ID.");
    } else if (event?.type === "response.completed") {
      if (event.response?.status !== "completed") throw new DemoError("foundry", "response_failed", "Foundry did not report a completed response.");
      completed = true;
      break;
    }
  }
  if (!completed) throw new DemoError("foundry", "truncated_stream", "Foundry closed the stream without completing the response.");
}
