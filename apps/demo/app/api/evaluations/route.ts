import { handleEvaluation } from "@/lib/server/evaluation-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleEvaluation(request);
}
