import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { localEvaluationsEnabled } from "../lib/server/config";
import { handleEvaluation } from "../lib/server/evaluation-handler";
import { loadEvaluationPlan, runEvaluation } from "../lib/server/evaluation-run";
import { evaluationEventSchema } from "../lib/evaluation-events";
import { DemoError } from "../lib/server/errors";
import { config, id } from "./helpers";

const root = resolve(process.cwd(), "../..");
const plan = loadEvaluationPlan(root, ["hosted", "prompt"], "smoke");
const good = { correctness: 4, pedagogy: 4, instruction_following: 4, communication: 4, capability_honesty: 4, safety_privacy: 4, reason: "Accurate." };
const dependencies = {
  config: () => config,
  enabled: () => true,
  authenticate: async () => ({ oid: id(5), assertion: "PRIVATE-USER-ASSERTION" }),
  plan: () => plan,
  judge: () => async () => good,
};
const request = (headers: Record<string, string> = {}, signal?: AbortSignal) => new Request("http://localhost:3000/api/evaluations", {
  method: "POST", headers: { origin: config.DEMO_ORIGIN, authorization: "Bearer PRIVATE-USER-ASSERTION", ...headers }, signal,
});
const events = async (response: Response) => (await response.text()).trim().split("\n")
  .map((line) => evaluationEventSchema.parse(JSON.parse(line)));
const passedSummary = {
  expectedCases: 32, completedCases: 32, scored: 32, errors: 0, passed: 32, passRate: 1,
  safetyFailures: 0, categories: {}, complete: true, qualityGate: "passed" as const, status: "scored", interrupted: false,
  byTutor: Object.fromEntries(["hosted", "prompt"].map((tutor) => [tutor, {
    expectedCases: 16, completedCases: 16, scored: 16, errors: 0, passed: 16, passRate: 1,
    safetyFailures: 0, categories: {}, complete: true, qualityGate: "passed" as const, status: "scored",
  }])),
};

test("local evaluation gate excludes production, managed identity and non-loopback origins", () => {
  assert.equal(localEvaluationsEnabled(config, "development"), true);
  for (const mode of ["production", "test"] as const) assert.equal(localEvaluationsEnabled(config, mode), false);
  assert.equal(localEvaluationsEnabled({ ...config, DEMO_ORIGIN: "https://demo.example.test" }, "development"), false);
  assert.equal(localEvaluationsEnabled({ ...config, DEMO_AUTH_MODE: "managed-identity", DEMO_MANAGED_IDENTITY_CLIENT_ID: id(9) }, "development"), false);
});

test("evaluation handler rejects disabled, foreign/missing origin, bodies and invalid auth before model calls", async () => {
  const mustNotRun = async () => { assert.fail("Must not invoke evaluations"); };
  assert.equal((await handleEvaluation(request(), {
    ...dependencies, enabled: () => false, authenticate: mustNotRun, run: mustNotRun,
  })).status, 404);
  for (const origin of ["", "https://foreign.example.test"]) {
    assert.equal((await handleEvaluation(request({ origin }), { ...dependencies, authenticate: mustNotRun, run: mustNotRun })).status, 403);
  }
  assert.equal((await handleEvaluation(new Request("http://foreign.example.test/api/evaluations", {
    method: "POST", headers: { origin: config.DEMO_ORIGIN },
  }), { ...dependencies, authenticate: mustNotRun, run: mustNotRun })).status, 403);
  assert.equal((await handleEvaluation(new Request(request(), { body: "{}" }), {
    ...dependencies, authenticate: mustNotRun, run: mustNotRun,
  })).status, 400);
  const response = await handleEvaluation(request(), {
    ...dependencies, authenticate: async () => { throw new DemoError("authentication", "invalid_token", "Sign in again.", 401); }, run: mustNotRun,
  });
  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes("PRIVATE"), false);
});

test("evaluation handler streams safe fixed smoke progress and both tutor summaries without credentials or generated text", async () => {
  const response = await handleEvaluation(new Request(request(), { body: "" }), {
    ...dependencies, run: async (args) => {
      assert.equal(args.plan.expected, 32);
      assert.deepEqual(args.plan.selected.map((group) => group.name), ["hosted", "prompt"]);
      assert.equal(args.assertion, "PRIVATE-USER-ASSERTION");
      assert.match(args.output, /\/\.foundry\/results\/smoke-[\da-f-]+\.jsonl$/);
      args.onProgress?.({ caseId: "one", tutor: "hosted", category: "math", durationMs: 1,
        status: "scored", requestId: "request-1", response: "PRIVATE-GENERATED-TEXT", judgement: good }, 1);
      return passedSummary;
    },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await events(response);
  assert.deepEqual(result.map((item) => item.type), ["started", "progress", "complete"]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("evaluation handler enforces single flight and aborts work when the client disconnects", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let stopped!: () => void;
  const finished = new Promise<void>((resolve) => { stopped = resolve; });
  const response = await handleEvaluation(request(), { ...dependencies, run: async ({ signal }) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { stopped(); resolve(); }, { once: true }));
    return { ...passedSummary, interrupted: true, qualityGate: "not-evaluated" };
  } });
  await running;
  assert.equal((await handleEvaluation(request(), dependencies)).status, 409);
  await response.body!.cancel();
  await finished;
  // Allow the run's finally block to release the development-wide lock.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = await handleEvaluation(request(), { ...dependencies, run: async () => passedSummary });
  assert.equal(next.status, 200);
  await events(next);
});

test("evaluation handler surfaces setup and streaming errors and releases the run lock", async () => {
  const setup = await handleEvaluation(request(), { ...dependencies,
    judge: () => { throw new DemoError("request", "judge_not_configured", "Configure a judge.", 503); },
  });
  assert.equal(setup.status, 503);
  const failed = await events(await handleEvaluation(request(), { ...dependencies,
    run: async () => { throw new Error("PRIVATE-INTERNAL-ERROR"); },
  }));
  assert.equal(failed.at(-1)?.type, "error");
  assert.equal(JSON.stringify(failed).includes("PRIVATE"), false);
  await events(await handleEvaluation(request(), { ...dependencies, run: async () => passedSummary }));
});

test("shared runner persists protected complete and cancelled results, never assertions, and refuses overwrite", async () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "tutor-evaluation-"));
  mkdirSync(resolve(temporary, "agents"));
  try {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const output = resolve(temporary, `agents/ai-tutor-hosted-agent/.foundry/results/${cancel ? "cancel" : "complete"}.jsonl`);
      const summary = await runEvaluation({
        plan: { ...plan, root: temporary }, config, assertion: "PRIVATE-ASSERTION", output, signal: controller.signal,
        judge: async () => good, deployment: "judge",
        evaluate: async ({ item, tutor }) => ({
          caseId: item.id, tutor, category: item.category, requestId: item.id,
          durationMs: 1, status: "scored", judgement: good, response: "A response.",
        }),
        pause: async () => {},
        onProgress: () => { if (cancel) controller.abort(); },
      });
      assert.equal(summary.interrupted, cancel);
      assert.equal(summary.qualityGate, cancel ? "not-evaluated" : "passed");
      assert.equal(summary.completedCases, cancel ? 1 : 32);
      for (const file of [output, `${output}.summary.json`]) {
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(readFileSync(file, "utf8").includes("PRIVATE-ASSERTION"), false);
      }
      await assert.rejects(runEvaluation({
        plan: { ...plan, root: temporary }, config, assertion: "", output, signal: controller.signal,
      }), /overwrite/);
    }
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
