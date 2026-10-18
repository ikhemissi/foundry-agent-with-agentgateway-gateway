"use client";

import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { useEffect, useRef, useState } from "react";

export default function Callback() {
  const started = useRef(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    broadcastResponseToMainFrame().catch(() => setError(true));
  }, []);
  return <main><p role={error ? "alert" : "status"}>{error
    ? "Sign-in could not be returned to the demo. Close this window and try signing in again."
    : "Returning sign-in to the demo..."}</p></main>;
}
