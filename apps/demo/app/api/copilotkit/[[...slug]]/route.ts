import { handleRequest } from "@/lib/server/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export function GET(request: Request) {
  return handleRequest(request);
}
export const POST = GET;
