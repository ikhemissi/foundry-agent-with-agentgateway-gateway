import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { authenticate } from "./auth";
import { getConfig, localEvaluationsEnabled } from "./config";
import { DemoError, reportError } from "./errors";
import { createEvaluationJudge, loadEvaluationPlan, runEvaluation } from "./evaluation-run";
import type { EvaluationEvent } from "../evaluation-events";

// Keep the lock through development hot reloads; there is no background job queue.
const state = globalThis as typeof globalThis & { localTutorEvaluationActive?: boolean };

export async function handleEvaluation(request: Request, dependencies: {
  config?: typeof getConfig;
  enabled?: typeof localEvaluationsEnabled;
  authenticate?: typeof authenticate;
  plan?: typeof loadEvaluationPlan;
  judge?: typeof createEvaluationJudge;
  run?: typeof runEvaluation;
} = {}): Promise<Response> {
  const requestId = randomUUID();
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  let ownsLock = false;
  try {
    const config = (dependencies.config ?? getConfig)();
    if (!(dependencies.enabled ?? localEvaluationsEnabled)(config)) {
      throw new DemoError("request", "local_evaluations_disabled", "Evaluations are available only in the local development app.", 404);
    }
    if (request.headers.get("origin") !== config.DEMO_ORIGIN
        || new URL(request.url).origin !== config.DEMO_ORIGIN) {
      throw new DemoError("request", "invalid_origin", "This origin is not permitted.", 403);
    }
    if (request.body) {
      const reader = request.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.byteLength) {
            await reader.cancel();
            throw new DemoError("request", "unsupported_body", "Smoke evaluations accept no client-defined configuration.", 400);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    const user = await (dependencies.authenticate ?? authenticate)(request.headers.get("authorization"), config);
    if (state.localTutorEvaluationActive) {
      throw new DemoError("request", "evaluation_busy", "Another smoke evaluation is running. Wait for it to finish or cancel it.", 409);
    }
    state.localTutorEvaluationActive = true;
    ownsLock = true;
    const root = resolve(process.cwd(), "../..");
    const plan = (dependencies.plan ?? loadEvaluationPlan)(root, ["hosted", "prompt"], "smoke");
    const deployment = process.env.EVALUATION_JUDGE_DEPLOYMENT;
    const judge = (dependencies.judge ?? createEvaluationJudge)(config, plan.rubricText, deployment);
    const output = resolve(root, `agents/ai-tutor-hosted-agent/.foundry/results/smoke-${requestId}.jsonl`);
    const outputLabel = relative(root, output);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([request.signal, cancellation.signal]);
    let disconnected = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: EvaluationEvent) => {
          if (!disconnected && !signal.aborted) controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
        };
        const run = async () => {
          try {
            emit({ type: "started", expectedCases: plan.expected, output: outputLabel });
            const summary = await (dependencies.run ?? runEvaluation)({
              plan, config, assertion: user.assertion, output, signal, judge, deployment,
              onProgress: (result, completedCases) => emit({
                type: "progress", completedCases, expectedCases: plan.expected,
                tutor: result.tutor, caseId: result.caseId, status: result.status, requestId: result.requestId,
              }),
            });
            emit({
              type: "complete", output: outputLabel, interrupted: summary.interrupted, qualityGate: summary.qualityGate,
              byTutor: plan.selected.map((group) => ({ tutor: group.name, ...summary.byTutor[group.name] })),
            });
          } catch (error) {
            const { body } = reportError(error, requestId);
            emit({ type: "error", message: body.error.message, requestId });
          } finally {
            state.localTutorEvaluationActive = false;
            if (!disconnected) controller.close();
          }
        };
        void run();
      },
      cancel() { disconnected = true; cancellation.abort(); },
    });
    return new Response(body, { headers: { ...headers, "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" } });
  } catch (error) {
    if (ownsLock) state.localTutorEvaluationActive = false;
    const { status, body } = reportError(error, requestId);
    return Response.json(body, { status, headers });
  }
}
