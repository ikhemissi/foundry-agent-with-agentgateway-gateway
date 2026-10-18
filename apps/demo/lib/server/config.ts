import { z } from "zod";

const common = z.object({
  DEMO_TENANT_ID: z.string().uuid(),
  DEMO_SPA_CLIENT_ID: z.string().uuid(),
  DEMO_BLUEPRINT_CLIENT_ID: z.string().uuid(),
  HOSTED_AGENT_PRINCIPAL_ID: z.string().uuid(),
  AZURE_PRINCIPAL_ID: z.string().uuid(),
  AGENTGATEWAY_ENTRA_CLIENT_ID: z.string().uuid(),
  CONSUMER_FOUNDRY_PROJECT_ENDPOINT: z.string().url(),
  DEMO_ORIGIN: z.string().url().default("http://localhost:3000"),
  DEMO_USER_SCOPE: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._]*$/).default("access_agent_as_user"),
  AGENTGATEWAY_ENDPOINT: z.string().url().optional(),
});
const schema = z.discriminatedUnion("DEMO_AUTH_MODE", [
  common.extend({
    DEMO_AUTH_MODE: z.literal("certificate"),
    DEMO_CERTIFICATE_PATH: z.string().min(1),
    DEMO_PRIVATE_KEY_PATH: z.string().min(1),
  }),
  common.extend({
    DEMO_AUTH_MODE: z.literal("managed-identity"),
    DEMO_MANAGED_IDENTITY_CLIENT_ID: z.string().uuid(),
  }),
]);

export type DemoConfig = z.infer<typeof schema>;
export type Tutor = "hosted" | "prompt";

export function getConfig(env: Record<string, string | undefined> = process.env): DemoConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Demo configuration is missing or invalid: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  const config = parsed.data;
  const project = new URL(config.CONSUMER_FOUNDRY_PROJECT_ENDPOINT);
  const origin = new URL(config.DEMO_ORIGIN);
  if (project.protocol !== "https:" || !project.hostname.endsWith(".services.ai.azure.com")
      || !/^\/api\/projects\/[a-zA-Z0-9_-]+\/?$/.test(project.pathname)
      || project.username || project.password || project.search || project.hash) {
    throw new Error("The demo requires an HTTPS Foundry project endpoint.");
  }
  if (origin.origin !== config.DEMO_ORIGIN || origin.username || origin.password
      || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) {
    throw new Error("DEMO_ORIGIN must be an HTTPS origin or a loopback HTTP origin.");
  }
  if (config.DEMO_AUTH_MODE === "certificate" && !["localhost", "127.0.0.1"].includes(origin.hostname)) {
    throw new Error("Certificate authentication is only supported for a loopback development origin.");
  }
  if (config.DEMO_AUTH_MODE === "managed-identity"
      && (env.DEMO_CERTIFICATE_PATH || env.DEMO_PRIVATE_KEY_PATH)) {
    throw new Error("Managed identity mode must not configure a certificate or private key.");
  }
  if (config.AGENTGATEWAY_ENDPOINT) {
    const gateway = new URL(config.AGENTGATEWAY_ENDPOINT);
    if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.pathname !== "/"
      || gateway.search || gateway.hash || !gateway.hostname.endsWith(".azurecontainerapps.io")) {
      throw new Error("AGENTGATEWAY_ENDPOINT must be an HTTPS Container Apps origin.");
    }
  }
  return config;
}

export function publicConfig(config: DemoConfig) {
  return {
    tenantId: config.DEMO_TENANT_ID,
    clientId: config.DEMO_SPA_CLIENT_ID,
    scope: `api://${config.DEMO_BLUEPRINT_CLIENT_ID}/${config.DEMO_USER_SCOPE}`,
    origin: config.DEMO_ORIGIN,
    localEvaluations: localEvaluationsEnabled(config),
  };
}

export function localEvaluationsEnabled(config: DemoConfig, mode = process.env.NODE_ENV) {
  return mode === "development" && config.DEMO_AUTH_MODE === "certificate"
    && ["localhost", "127.0.0.1"].includes(new URL(config.DEMO_ORIGIN).hostname);
}
