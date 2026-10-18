import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getConfig } from "../lib/server/config";
import { DemoError, reportError } from "../lib/server/errors";
import { createEvaluationJudge, loadEvaluationPlan, runEvaluation } from "../lib/server/evaluation-run";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = fileURLToPath(new URL("../", import.meta.url));
const controller = new AbortController();
const abort = () => controller.abort();

try {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--run", "--stdin", "--judge"].includes(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
      flags.add(arg);
    } else if (["--tutor", "--tier", "--token-file", "--output"].includes(arg) && args[index + 1] && !args[index + 1].startsWith("--")) {
      if (values.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
      values.set(arg, args[++index]);
    } else throw new Error(`Unsupported evaluation argument: ${arg}`);
  }
  const tutor = z.enum(["hosted", "prompt", "both"]).parse(values.get("--tutor") ?? "both");
  const tier = z.enum(["smoke", "regression", "coverage"]).parse(values.get("--tier") ?? "smoke");
  const tutors = tutor === "both" ? ["hosted", "prompt"] as const : [tutor];
  const plan = loadEvaluationPlan(root, tutors, tier);
  console.log(JSON.stringify({ mode: flags.has("--run") ? "run" : "preview", tier,
    tutors: plan.selected.map((item) => ({ tutor: item.name, cases: item.cases.length, datasetHash: item.datasetHash })),
    agentCalls: plan.expected, judgeCalls: flags.has("--judge") ? plan.expected : 0,
    multiTurn: "Seeded history replay, not a generated sequential conversation.",
    gates: plan.gates, warning: "Live agent and judge calls incur charges. Results may contain generated text." }));
  if (flags.has("--run")) {
    if (flags.has("--stdin") === values.has("--token-file") || !values.has("--output")) {
      throw new Error("Live runs require --output <new-owner-only-jsonl-file> and exactly one of --stdin or --token-file <owner-only-file>.");
    }
    if (flags.has("--stdin") && process.stdin.isTTY) throw new Error("Pipe the assertion through stdin; do not enter it interactively.");
    const file = values.get("--token-file");
    if (file && (!statSync(file).isFile() || (statSync(file).mode & 0o077))) throw new Error("The assertion must be a regular owner-only file (chmod 600).");
    const assertion = readFileSync(file ?? 0, "utf8").trim();
    const output = resolve(values.get("--output")!);
    if (existsSync(resolve(directory, ".env.local"))) process.loadEnvFile(resolve(directory, ".env.local"));
    const config = getConfig();
    const deployment = process.env.EVALUATION_JUDGE_DEPLOYMENT;
    const judge = flags.has("--judge") ? createEvaluationJudge(config, plan.rubricText, deployment) : undefined;
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const summary = await runEvaluation({
        plan, config, assertion, output, signal: controller.signal, judge, deployment,
        onProgress: (result) => console.log(JSON.stringify({
          caseId: result.caseId, tutor: result.tutor, status: result.status, requestId: result.requestId,
        })),
      });
      console.log(JSON.stringify(summary));
      if (summary.interrupted || summary.status === "failed" || summary.qualityGate === "failed") process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  } else if (flags.has("--stdin") || values.has("--token-file") || values.has("--output")) {
    throw new Error("Authentication and output arguments require --run. Preview never reads assertions or writes results.");
  }
} catch (error) {
  const known = error instanceof DemoError ? error : new DemoError("request", "evaluation_setup_failed",
    error instanceof Error && !error.name.includes("Zod") ? error.message : "Invalid evaluation configuration.", 400);
  console.error(JSON.stringify(reportError(known, randomUUID()).body));
  process.exitCode = 1;
}
