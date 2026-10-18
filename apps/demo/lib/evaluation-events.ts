import { z } from "zod";

const qualityGate = z.enum(["passed", "failed", "not-evaluated"]);
export const evaluationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), expectedCases: z.number().int().positive(), output: z.string() }),
  z.object({
    type: z.literal("progress"), completedCases: z.number().int(), expectedCases: z.number().int(),
    tutor: z.enum(["hosted", "prompt"]), caseId: z.string(), status: z.enum(["captured", "scored", "error"]),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("complete"), output: z.string(), interrupted: z.boolean(), qualityGate,
    byTutor: z.array(z.object({
      tutor: z.enum(["hosted", "prompt"]), expectedCases: z.number().int(), scored: z.number().int(),
      errors: z.number().int(), passed: z.number().int(), passRate: z.number(), qualityGate,
    })),
  }),
  z.object({ type: z.literal("error"), message: z.string(), requestId: z.string() }),
]);
export type EvaluationEvent = z.infer<typeof evaluationEventSchema>;
