"use client";

import { useEffect, useRef, useState } from "react";
import { evaluationEventSchema, type EvaluationEvent } from "@/lib/evaluation-events";

export function LocalEvaluations({ token, accountId }: { token: string; accountId: string }) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [output, setOutput] = useState("");
  const [summary, setSummary] = useState<Extract<EvaluationEvent, { type: "complete" }>>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, [accountId]);
  useEffect(() => { if (!token) active.current?.abort(); }, [token]);

  const run = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setStatus("Starting smoke evaluations...");
    setError("");
    setOutput("");
    setSummary(undefined);
    try {
      const response = await fetch("/api/evaluations", {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(`${result.error.message} Request: ${result.error.requestId}`);
      }
      if (!response.body) throw new Error("The evaluation returned no progress stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let terminal = false;
      const consume = (line: string) => {
        const event = evaluationEventSchema.parse(JSON.parse(line));
        if (terminal) throw new Error("The evaluation sent data after its terminal result.");
        if (event.type === "started") {
          setOutput(event.output);
          setStatus(`Running 0/${event.expectedCases} cases.`);
        } else if (event.type === "progress") {
          setStatus(`${event.completedCases}/${event.expectedCases}: ${event.tutor} / ${event.caseId} - ${event.status}. Request: ${event.requestId}`);
        } else if (event.type === "complete") {
          terminal = true;
          setSummary(event);
          setOutput(event.output);
          setStatus(event.interrupted ? "Evaluation stopped early. Review partial results."
            : `Smoke evaluations finished. Provisional quality gate: ${event.qualityGate}.`);
        } else {
          terminal = true;
          throw new Error(`${event.message} Request: ${event.requestId}`);
        }
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) if (line) consume(line);
          if (done) break;
        }
        if (pending.trim()) consume(pending);
        if (!terminal) throw new Error("The evaluation stream ended before a summary arrived. Review partial results.");
      } finally {
        reader.releaseLock();
      }
    } catch (cause) {
      controller.abort();
      setStatus("");
      setError(cause instanceof Error && cause.name !== "AbortError"
        ? cause.message : "Evaluation cancelled. Completed cases and an incomplete summary are retained locally.");
    } finally {
      active.current = null;
      setRunning(false);
    }
  };

  return <section aria-label="Local tutor evaluations">
    <h2>Local smoke evaluations</h2>
    <p>Runs both deployed tutors: <strong>32 agent calls + 32 judge calls</strong>. Azure charges apply.
      Uses your current sign-in and the real Agent ID OBO flow; no token export is needed.</p>
    <p>The independent judge uses this server&apos;s Azure CLI sign-in and
      <code> EVALUATION_JUDGE_DEPLOYMENT</code>. Scores are provisional, not human-calibrated.
      These are local captures, not Foundry evaluation-portal runs.</p>
    <button disabled={!token || running} onClick={() => { void run(); }}>Run smoke evaluations with judging</button>
    {" "}{running && <button onClick={() => active.current?.abort()}>Cancel evaluations</button>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
    {summary && <ul aria-label="Evaluation summaries">{summary.byTutor.map((item) => <li key={item.tutor}>
      {item.tutor}: {item.scored}/{item.expectedCases} scored, {item.passed} passed,
      {" "}{item.errors} errors. Quality gate: {item.qualityGate}.
    </li>)}</ul>}
    {output && <p>Protected local results: <code>{output}</code> and <code>{output}.summary.json</code>.
      Generated text stays in ignored owner-only files, not this page. Closing the page, signing out,
      or cancelling stops the run and retains partial results. A new run starts over.</p>}
  </section>;
}
