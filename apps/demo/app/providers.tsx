"use client";

import { AuthError, InteractionRequiredAuthError, InteractionStatus } from "@azure/msal-browser";
import { useMsal } from "@azure/msal-react";
import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LocalEvaluations } from "./evaluations";

export function DemoChat({ scope, localEvaluations = false }: { scope: string; localEvaluations?: boolean }) {
  const { instance, accounts, inProgress } = useMsal();
  const account = accounts[0];
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [tutor, setTutor] = useState<"hosted" | "prompt">("hosted");
  const [session, setSession] = useState(0);
  const [checks, setChecks] = useState<{ check: string; durationMs: number; requestId: string }[]>([]);
  const [checking, setChecking] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [renewal, setRenewal] = useState("");
  const checkController = useRef<AbortController | null>(null);
  useEffect(() => () => { checkController.current?.abort(); }, [account?.homeAccountId]);
  const refresh = useCallback(async (forceRefresh = false) => {
    if (!account) return;
    try {
      if (forceRefresh) setRenewal("");
      const result = await instance.acquireTokenSilent({ account, scopes: [scope], forceRefresh });
      if (forceRefresh && result.fromCache) throw new Error("Silent renewal returned a cached token.");
      setToken(result.accessToken);
      setError("");
      if (forceRefresh) setRenewal(`Entra silent renewal passed (not from cache).${
        result.expiresOn ? ` Token expires ${result.expiresOn.toISOString()}.` : ""}`);
    } catch (cause) {
      setToken("");
      setRenewal("");
      checkController.current?.abort();
      setChecks([]);
      setChecking(false);
      setError("");
      setError(cause instanceof InteractionRequiredAuthError
        ? "Your sign-in needs attention. Select Renew sign-in to continue."
        : "Could not renew sign-in. Sign out and try again.");
    }
  }, [account, instance, scope]);
  useEffect(() => {
    if (!account) return;
    // Re-entering the account creates a fresh chat; no user history is persisted.
    const start = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => { window.clearTimeout(start); window.clearInterval(timer); };
  }, [account, refresh]);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const signIn = () => {
    instance.loginPopup({ scopes: [scope] }).then((result) => {
      instance.setActiveAccount(result.account);
      setToken(result.accessToken);
      setError("");
    }).catch((cause: unknown) => setError(
      `Microsoft sign-in could not be completed${cause instanceof AuthError ? ` (${cause.errorCode})` : ""}.`,
    ));
  };
  if (!account) return <section>
    <h2>Sign in to test the tutors</h2>
    <p>The backend exchanges your sign-in token as the configured Agent ID. Access is limited to the configured demo user.</p>
    <button disabled={inProgress !== InteractionStatus.None} onClick={signIn}>Sign in with Microsoft</button>
    {error && <p role="alert">{error}</p>}
  </section>;
  return <>
    <section className="toolbar">
      <span>Signed in as <strong>{account.username}</strong></span>
      <button onClick={() => {
        setToken("");
        setRenewal("");
        setSession((value) => value + 1);
        instance.logoutPopup({ account }).catch(() => setError("Sign-out could not be completed."));
      }}>Sign out</button>
      <button disabled={!token || checking || renewing || inProgress !== InteractionStatus.None}
        onClick={async () => {
          setRenewing(true);
          try { await refresh(true); } finally { setRenewing(false); }
        }}>{renewing ? "Renewing token..." : "Check silent renewal"}</button>
      {renewal && <p role="status">{renewal}</p>}
    </section>
    <section>
      <label htmlFor="tutor">Tutor</label>{" "}
      <select id="tutor" value={tutor} onChange={(event) => {
        setTutor(event.target.value === "hosted" ? "hosted" : "prompt");
        setSession((value) => value + 1);
      }}>
        <option value="hosted">Hosted - delegated user via agent</option>
        <option value="prompt">Prompt - OAuth2 gateway connection</option>
      </select>{" "}
      <button onClick={() => setSession((value) => value + 1)}>Reset chat</button>
      {" "}<button disabled={!token || checking || renewing} onClick={async () => {
        const controller = new AbortController();
        checkController.current = controller;
        setChecking(true);
        setChecks([]);
        setError("");
        try {
          const response = await fetch("/api/acceptance", { method: "POST", headers, signal: controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(`${result.error.message} Request: ${result.error.requestId}`);
          setChecks(result.checks);
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Live checks could not complete.");
        } finally {
          setChecking(false);
        }
      }}>{checking ? "Running live checks..." : "Run live checks"}</button>
      <p className="flow">{tutor === "hosted"
        ? "You + hosted Agent ID → Foundry → delegated gateway route → model"
        : "You + Agent ID → Foundry prompt tutor → dedicated OAuth2 application → gateway → model"}</p>
      <p>No API-key fallback. Chat history stays in this page and resets on sign-out or tutor change.
        Tokens are never shown. Streaming failures include a request ID for investigation.</p>
      <p>Live checks invoke both deployed tutors (three model calls; Azure charges apply) and probe gateway denials.
        They do not change identities, deploy resources, or delete credentials.</p>
      <p>Check silent renewal bypasses MSAL&apos;s access-token cache. It tests an actual Entra renewal,
        not a naturally expired browser session.</p>
      {checks.length > 0 && <ul aria-label="Live check results">{checks.map((result) => <li key={result.check}>
        {result.check}: passed ({result.durationMs} ms) <small>Request: {result.requestId}</small>
      </li>)}</ul>}
    </section>
    {localEvaluations && <LocalEvaluations token={token} accountId={account.homeAccountId} />}
    {error && <section role="alert">{error} <button onClick={signIn}>Renew sign-in</button></section>}
    {token ? <section className="chat" aria-label="Tutor chat">
      <CopilotKitProvider key={`${account.homeAccountId}:${tutor}:${session}`}
        runtimeUrl="/api/copilotkit" agentId={tutor} headers={headers}>
        <CopilotChat agentId={tutor} />
      </CopilotKitProvider>
    </section> : !error && <p role="status">Acquiring your access token...</p>}
  </>;
}
