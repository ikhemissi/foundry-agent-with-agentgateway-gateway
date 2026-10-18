"use client";

import { useEffect, useState } from "react";
import { PublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { DemoChat } from "./providers";

let initialization: Promise<{ app: PublicClientApplication; scope: string }> | undefined;

async function initialize() {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Demo configuration is incomplete. Run the documented identity setup and environment export.");
  const config = await response.json();
  const app = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: `${config.origin}/auth/callback`,
      postLogoutRedirectUri: `${config.origin}/auth/callback`,
    },
    cache: { cacheLocation: "memoryStorage" },
  });
  await app.initialize();
  return { app, scope: config.scope };
}

export default function Page() {
  const [instance, setInstance] = useState<PublicClientApplication>();
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    initialization ??= initialize();
    initialization.then(({ app, scope }) => {
      if (!disposed) {
        setScope(scope);
        setInstance(app);
      }
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not initialize sign-in.");
    });
    return () => { disposed = true; };
  }, []);
  return <main>
    <header><p className="eyebrow">IDENTITY-FIRST INFERENCE</p><h1>Foundry + agentgateway</h1>
      <p>Two independent tutors. One gateway. Different authorization boundaries.</p></header>
    {error ? <section role="alert">{error}</section>
      : instance ? <MsalProvider instance={instance}><DemoChat scope={scope} /></MsalProvider>
        : <p role="status">Preparing Microsoft sign-in...</p>}
  </main>;
}
