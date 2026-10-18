import { getConfig } from "../lib/server/config";

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const environment = {
  DEMO_AUTH_MODE: "certificate",
  DEMO_TENANT_ID: id(1), DEMO_SPA_CLIENT_ID: id(2), DEMO_BLUEPRINT_CLIENT_ID: id(3),
  HOSTED_AGENT_PRINCIPAL_ID: id(4), AZURE_PRINCIPAL_ID: id(5), AGENTGATEWAY_ENTRA_CLIENT_ID: id(6),
  CONSUMER_FOUNDRY_PROJECT_ENDPOINT: "https://consumer.services.ai.azure.com/api/projects/tutors",
  DEMO_CERTIFICATE_PATH: "/unused/cert.pem", DEMO_PRIVATE_KEY_PATH: "/unused/key.pem",
};
export const config = getConfig(environment);
export const complete = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
export const text = (delta: string) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`;
export function streamResponse(data = text("Hello") + complete) {
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}
export const collect = async <T>(values: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};
