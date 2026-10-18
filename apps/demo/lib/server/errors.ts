export class DemoError extends Error {
  constructor(
    public readonly stage: "authentication" | "exchange" | "foundry" | "request",
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

export function reportError(error: unknown, requestId: string) {
  const known = error instanceof DemoError;
  const code = known ? error.code : "internal_error";
  const stage = known ? error.stage : "request";
  console.error(JSON.stringify({ requestId, stage, code }));
  return {
    status: known ? error.status : 500,
    body: {
      error: {
        stage, code, requestId,
        message: known ? error.message : "The demo could not complete the request. Check server configuration.",
      },
    },
  };
}
