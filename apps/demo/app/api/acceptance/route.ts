import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { authenticate } from "@/lib/server/auth";
import { runAcceptance } from "@/lib/server/acceptance";
import { DemoError, reportError } from "@/lib/server/errors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const config = getConfig();
    if (request.headers.get("origin") !== config.DEMO_ORIGIN) {
      throw new DemoError("request", "invalid_origin", "This origin is not permitted.", 403);
    }
    const user = await authenticate(request.headers.get("authorization"), config);
    const checks = await runAcceptance({ config, user, signal: request.signal });
    return Response.json({ checks }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  } catch (error) {
    const { status, body } = reportError(error, requestId);
    return Response.json(body, { status, headers: { "Cache-Control": "no-store", "x-request-id": requestId } });
  }
}
