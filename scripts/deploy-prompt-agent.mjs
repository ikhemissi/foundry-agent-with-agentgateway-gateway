import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export async function deployPromptAgent({ endpoint, agent, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('A Foundry access token is required.');
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new Error('CONSUMER_FOUNDRY_PROJECT_ENDPOINT is required.');
  }
  const project = new URL(endpoint);
  if (project.protocol !== 'https:' || !/^\/api\/projects\/[^/]+\/?$/.test(project.pathname)
      || project.username || project.password || project.search || project.hash) {
    throw new Error('CONSUMER_FOUNDRY_PROJECT_ENDPOINT must be an HTTPS Foundry project endpoint.');
  }
  if (!agent || typeof agent.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(agent.name)
      || agent.kind !== 'prompt' || typeof agent.instructions !== 'string' || !agent.instructions.trim()
      || typeof agent.description !== 'string' || !agent.description.trim()) {
    throw new Error('The prompt agent requires a valid name, description, kind, and instructions.');
  }
  if (typeof agent.model !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(agent.model)) {
    throw new Error('The prompt model must use <connection-name>/<model-name>.');
  }
  const desired = {
    description: agent.description,
    definition: { kind: agent.kind, model: agent.model, instructions: agent.instructions },
  };
  const base = `${project.href.replace(/\/$/, '')}/agents/${encodeURIComponent(agent.name)}`;
  async function request(url, method = 'GET', body) {
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120000),
      redirect: 'error',
    });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Foundry ${method} failed (${response.status}): ${await response.text()}`);
    }
    return response.json();
  }
  const matches = (version) => version?.description === desired.description
    && isDeepStrictEqual(version.definition, desired.definition);
  const current = await request(`${base}?api-version=v1`);
  if (matches(current?.versions?.latest)) return { ...current.versions.latest, changed: false };
  const created = await request(`${base}/versions?api-version=v1`, 'POST', desired);
  const persisted = await request(`${base}?api-version=v1`);
  const latest = persisted?.versions?.latest;
  if (!created?.version || latest?.version !== created.version || !matches(latest)) {
    throw new Error(`Foundry did not persist the expected version of ${agent.name}.`);
  }
  return { ...latest, changed: true };
}

async function main() {
  const subscription = process.env.AZURE_SUBSCRIPTION_ID;
  if (!subscription?.trim()) throw new Error('AZURE_SUBSCRIPTION_ID is required; run through azd hooks.');
  const agent = JSON.parse(readFileSync(new URL('../agents/ai-tutor-prompt-agent/agent.json', import.meta.url), 'utf8'));
  const token = execFileSync('az', [
    'account', 'get-access-token', '--scope', 'https://ai.azure.com/.default',
    '--subscription', subscription, '--query', 'accessToken', '--output', 'tsv',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const result = await deployPromptAgent({
    endpoint: process.env.CONSUMER_FOUNDRY_PROJECT_ENDPOINT, agent, token,
  });
  console.log(`${result.changed ? 'Deployed' : 'Unchanged'}: ${agent.name}, version ${result.version}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Prompt agent deployment failed: ${error.message}`);
    process.exitCode = 1;
  });
}
