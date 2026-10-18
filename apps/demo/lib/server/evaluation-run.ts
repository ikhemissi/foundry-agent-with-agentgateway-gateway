import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { DemoConfig, Tutor } from "./config";
import { DemoError, reportError } from "./errors";
import { evaluateCase, evaluationCaseSchema, gatesSchema, judgeResponse, selectCases, summarize, type EvaluationCase, type EvaluationResult } from "./evaluation";

export function loadEvaluationPlan(root: string, tutors: readonly Tutor[], tier: EvaluationCase["tier"]) {
  const rubricText = readFileSync(resolve(root, "evaluations/tutor-rubric.json"), "utf8");
  const gates = gatesSchema.parse(JSON.parse(rubricText).gates);
  const selected = tutors.map((name) => {
    const data = readFileSync(resolve(root,
      `agents/ai-tutor-${name}-agent/.foundry/datasets/ai-tutor-${name}-agent-curated-v1.jsonl`), "utf8");
    const cases = data.trim().split("\n").map((line) => evaluationCaseSchema.parse(JSON.parse(line)));
    if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Duplicate evaluation case IDs.");
    return { name, cases: selectCases(cases, tier), datasetHash: createHash("sha256").update(data).digest("hex") };
  });
  return { root, rubricText, gates, selected, expected: selected.reduce((count, group) => count + group.cases.length, 0) };
}
export type EvaluationPlan = ReturnType<typeof loadEvaluationPlan>;
export type EvaluationSummary = Awaited<ReturnType<typeof runEvaluation>>;

export function createEvaluationJudge(config: DemoConfig, rubricText: string, deployment: string | undefined) {
  if (!deployment || !/^[a-zA-Z0-9._-]+$/.test(deployment)) {
    throw new DemoError("request", "judge_not_configured",
      "Set EVALUATION_JUDGE_DEPLOYMENT to a verified consumer-project judge deployment.", 503);
  }
  return async (item: EvaluationCase, response: string, signal: AbortSignal) => {
    let accessToken: string;
    try {
      const { stdout } = await promisify(execFile)("az", ["account", "get-access-token", "--tenant", config.DEMO_TENANT_ID,
        "--resource", "https://cognitiveservices.azure.com", "--query", "accessToken", "-o", "tsv"],
      { encoding: "utf8", timeout: 30_000, signal });
      accessToken = stdout.trim();
    } catch {
      signal.throwIfAborted();
      throw new DemoError("request", "judge_credential_unavailable", "Azure CLI could not acquire the separate judge credential.");
    }
    if (!accessToken) throw new DemoError("request", "judge_credential_unavailable", "Azure CLI returned no judge credential.");
    return judgeResponse({
      item, response, rubricText, deployment, accessToken, signal,
      projectEndpoint: config.CONSUMER_FOUNDRY_PROJECT_ENDPOINT,
    });
  };
}

export async function runEvaluation({
  plan, config, assertion, output, signal, judge, deployment, onProgress,
  evaluate = evaluateCase, pause = (signal: AbortSignal) => setTimeout(2000, undefined, { signal }),
}: {
  plan: EvaluationPlan; config: DemoConfig; assertion: string; output: string; signal: AbortSignal;
  judge?: ReturnType<typeof createEvaluationJudge>; deployment?: string;
  onProgress?: (result: EvaluationResult, completed: number) => void;
  evaluate?: typeof evaluateCase; pause?: (signal: AbortSignal) => Promise<void>;
}) {
  output = resolve(output);
  if (existsSync(output) || existsSync(`${output}.summary.json`)) throw new Error("Refusing to overwrite evaluation results.");
  if (!plan.selected.some((group) => output.startsWith(resolve(plan.root,
    `agents/ai-tutor-${group.name}-agent/.foundry/results`) + "/"))) {
    throw new Error("Write results inside a selected agent's ignored .foundry/results directory.");
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (!realpathSync(dirname(output)).startsWith(realpathSync(resolve(plan.root, "agents")) + "/")) {
    throw new Error("Evaluation output directory must not redirect outside agent roots.");
  }
  writeFileSync(output, "", { mode: 0o600, flag: "wx" });
  const results: EvaluationResult[] = [];
  let interrupted = false;
  try {
    for (const group of plan.selected) {
      for (const item of group.cases) {
        signal.throwIfAborted();
        const result = await evaluate({ item, tutor: group.name, assertion, config, signal, judge });
        results.push(result);
        writeFileSync(output, JSON.stringify({
          ...result, query: item.query, expected_behavior: item.expected_behavior,
          ground_truth: item.ground_truth, history: item.history,
          datasetHash: group.datasetHash,
          rubricHash: createHash("sha256").update(plan.rubricText).digest("hex"),
          judgeDeployment: judge ? deployment : null,
          projectEndpoint: config.CONSUMER_FOUNDRY_PROJECT_ENDPOINT,
          agentEndpointSelector: "@latest", authMode: config.DEMO_AUTH_MODE, recordedAt: new Date().toISOString(),
        }) + "\n", { flag: "a", mode: 0o600 });
        if (result.status === "error") reportError(new DemoError("request", result.error?.code ?? "evaluation_failed",
          "Evaluation failed; inspect the protected result file."), result.requestId);
        onProgress?.(result, results.length);
        if (result.status === "error") throw new Error("Evaluation item failed.");
        if (results.length < plan.expected) await pause(signal);
      }
    }
  } catch {
    interrupted = true;
    reportError(new DemoError("request", signal.aborted ? "evaluation_cancelled" : "evaluation_incomplete",
      signal.aborted ? "Evaluation was cancelled." : "Evaluation stopped; inspect the protected result file."), randomUUID());
  }
  const byTutor = Object.fromEntries(plan.selected.map((group) => [group.name,
    summarize(results.filter((item) => item.tutor === group.name), group.cases.length, plan.gates)]));
  const aggregate = summarize(results, plan.expected, plan.gates);
  const qualityGate: typeof aggregate.qualityGate = interrupted ? "not-evaluated"
    : Object.values(byTutor).some((item) => item.qualityGate === "failed") ? "failed" : aggregate.qualityGate;
  const summary = {
    ...aggregate, interrupted, byTutor,
    status: interrupted ? "failed" : aggregate.status, qualityGate,
  };
  writeFileSync(`${output}.summary.json`, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return summary;
}
