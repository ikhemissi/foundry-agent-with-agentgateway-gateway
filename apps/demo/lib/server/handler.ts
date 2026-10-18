import { randomUUID } from "node:crypto";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { authenticate } from "./auth";
import { FoundryTutorAgent, type InvocationContext } from "./agent";
import { getConfig } from "./config";
import { DemoError, reportError } from "./errors";

process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

async function limitBody(request: Request, signal: AbortSignal): Promise<Request> {
  const headers = new Headers();
  for (const name of ["content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!request.body) return new Request(request.url, { method: request.method, headers, signal });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131_072) {
        await reader.cancel();
        throw new DemoError("request", "request_too_large", "The demo accepts requests up to 128 KiB.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  if (/\/agent\/(hosted|prompt)\/run$/.test(new URL(request.url).pathname)) {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString("utf8")); }
    catch { throw new DemoError("request", "invalid_json", "Send a valid AG-UI JSON request.", 400); }
    const input = RunAgentInputSchema.safeParse(parsed);
    if (!input.success) throw new DemoError("request", "invalid_run", "The AG-UI run request is invalid.", 400);
    if (input.data.tools.length || input.data.context.length || Object.keys(input.data.forwardedProps ?? {}).length) {
      throw new DemoError("request", "unsupported_context", "Client-defined tools, context, and runtime overrides are not supported.", 400);
    }
  }
  return new Request(request.url, {
    method: request.method, headers, signal, body,
  });
}

export async function handleRequest(
  request: Request,
  dependencies: {
    config?: typeof getConfig;
    authenticate?: typeof authenticate;
    tokens?: InvocationContext["tokens"];
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const config = (dependencies.config ?? getConfig)();
    const origin = request.headers.get("origin");
    if (origin && origin !== config.DEMO_ORIGIN) {
      throw new DemoError("request", "invalid_origin", "This origin is not permitted.", 403);
    }
    const user = await (dependencies.authenticate ?? authenticate)(request.headers.get("authorization"), config);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    // The outer stream owns cancellation so the runtime can finalize its SSE writer.
    const bounded = await limitBody(request, new AbortController().signal);
    const context: InvocationContext = {
      user, config, signal, requestId,
      tokens: dependencies.tokens, fetchImpl: dependencies.fetchImpl,
    };
    // Agents are request-owned; the runtime's thread coordination is process-local.
    const runtime = new CopilotRuntime({
      agents: { hosted: new FoundryTutorAgent(context, "hosted"), prompt: new FoundryTutorAgent(context, "prompt") },
      runner: new InMemoryAgentRunner(),
    });
    const handler = createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit", activateChannels: false });
    const response = await handler(bounded);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("x-request-id", requestId);
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (cancellation.signal.aborted) return;
          if (result.done) { controller.close(); reader.releaseLock(); }
          else controller.enqueue(result.value);
        } catch (error) {
          cancellation.abort();
          const { body } = reportError(error, requestId);
          controller.error(new Error(`${body.error.message} Request: ${requestId}`));
          reader.releaseLock();
        }
      },
      async cancel() {
        cancellation.abort();
        try {
          while (!(await reader.read()).done) { /* Drain terminal events after aborting the model request. */ }
        } catch (error) {
          reportError(error, requestId);
          throw new Error(`Could not close the runtime stream. Request: ${requestId}`);
        } finally {
          reader.releaseLock();
        }
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    const { status, body } = reportError(error, requestId);
    return Response.json(body, { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  }
}
