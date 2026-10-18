import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const loadJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('prompt tutor selects the connection-qualified gateway model', async () => {
  const agent = await loadJson('agents/ai-tutor-prompt-agent/agent.json');
  assert.deepEqual(Object.keys(agent).sort(), ['description', 'instructions', 'kind', 'model', 'name']);
  assert.equal(agent.name, 'ai-tutor-prompt-agent');
  assert.equal(agent.kind, 'prompt');
  assert.equal(agent.model, 'agentgateway-gateway/gpt-5.4-nano');
  assert.ok(agent.description.includes('agentgateway'));
});

test('hosted tutor selects the direct model alias independently', async () => {
  const agent = await loadJson('agents/ai-tutor-hosted-agent/agent.json');
  assert.deepEqual(Object.keys(agent).sort(), ['instructions', 'model', 'name']);
  assert.equal(agent.name, 'ai-tutor-hosted-agent');
  assert.equal(agent.model, 'gpt-5.4-nano');
});

test('both tutors share the same teaching behavior without cross-agent instructions', async () => {
  const [prompt, hosted] = await Promise.all([
    loadJson('agents/ai-tutor-prompt-agent/agent.json'),
    loadJson('agents/ai-tutor-hosted-agent/agent.json'),
  ]);
  assert.equal(prompt.instructions, hosted.instructions);
  for (const agent of [prompt, hosted]) {
    assert.ok(agent.instructions.trim().length > 0);
    assert.ok(!agent.instructions.includes(prompt.name));
    assert.ok(!agent.instructions.includes(hosted.name));
    assert.ok(!agent.instructions.includes('LiteLLM'));
  }
  assert.equal(prompt.model, `agentgateway-gateway/${hosted.model}`);
});

test('VS Code test tasks run existing tests from the workspace root', async () => {
  const config = await loadJson('.vscode/tasks.json');
  assert.equal(config.version, '2.0.0');
  const testTasks = config.tasks.filter((task) => task.group);
  assert.deepEqual(testTasks.map((task) => task.label), [
    'Test project scaffold',
    'Test infrastructure contracts',
    'Test gateway compatibility',
  ]);
  for (const task of testTasks) {
    assert.equal(task.type, 'process');
    assert.equal(task.command, 'node');
    assert.equal(task.options.cwd, '${workspaceFolder}');
    assert.equal(task.args[0], '--test');
    for (const file of task.args.slice(1)) await readFile(new URL(file, root));
  }
});

test('root F5 configuration uses the agent virtual environment and VS Code Inspector', async () => {
  const [tasks, launch] = await Promise.all([loadJson('.vscode/tasks.json'), loadJson('.vscode/launch.json')]);
  const debug = launch.configurations[0];
  assert.equal(debug.type, 'debugpy');
  assert.equal(debug.connect.host, '127.0.0.1');
  assert.equal(debug.connect.port, 5679);
  const inspector = tasks.tasks.find((task) => task.label === debug.preLaunchTask);
  assert.ok(inspector);
  const server = tasks.tasks.find((task) => task.label === inspector.dependsOn);
  assert.ok(server.command.includes('--no-client'));
  assert.ok(server.command.includes('.venv/bin/python -Xfrozen_modules=off -m debugpy --listen 127.0.0.1:5679 main.py'));
  assert.equal(server.options.cwd, '${workspaceFolder}');
  assert.ok(tasks.tasks.some((task) => task.label === server.dependsOn && task.type === 'aitk'));
  assert.equal(tasks.inputs[0].command, 'ai-mlstudio.openTestTool');
  assert.equal(tasks.inputs[0].args.port, 8088);
});

test('Git ignores local secrets, build outputs and virtual environments', () => {
  const paths = [
    '.azure/dev/.env',
    '.env',
    '.env.local',
    'agents/ai-tutor-hosted-agent/.env',
    'agents/ai-tutor-hosted-agent/.env.local',
    'agents/ai-tutor-hosted-agent/.venv/pyvenv.cfg',
    'agents/ai-tutor-hosted-agent/__pycache__/main.cpython-313.pyc',
    'infra/main.json',
    '.env.example',
    'infra/main.parameters.json',
    'agents/ai-tutor-hosted-agent/agent.json',
  ];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: fileURLToPath(root),
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  }).trim().split('\n');
  assert.deepEqual(ignored, paths.slice(0, 8));
});

test('demo configuration, keys, dependencies and build outputs stay local', () => {
  const paths = [
    '.certificates/demo.key', '.certificates/demo.pem', 'apps/demo/.env.local',
    'apps/demo/node_modules/next/package.json', 'apps/demo/.next/server/app/page.js',
    'apps/demo/test-results/result.json', 'apps/demo/playwright-report/index.html',
    'apps/demo/tsconfig.tsbuildinfo',
  ];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: fileURLToPath(root), input: `${paths.join('\n')}\n`, encoding: 'utf8',
  }).trim().split('\n');
  assert.deepEqual(ignored, paths);
});

test('demo adds separate npm tasks and debugging without replacing hosted F5', async () => {
  const [tasks, launch, manifest] = await Promise.all([
    loadJson('.vscode/tasks.json'), loadJson('.vscode/launch.json'), loadJson('apps/demo/package.json'),
  ]);
  assert.equal(launch.configurations[0].type, 'debugpy');
  assert.equal(launch.configurations.find((entry) => entry.name === 'Debug CopilotKit demo').cwd, '${workspaceFolder}/apps/demo');
  assert.equal(tasks.tasks.find((entry) => entry.label === 'Run CopilotKit demo').command, 'npm');
  assert.equal(manifest.engines.node, '>=22');
  assert.equal(manifest.dependencies['@ag-ui/client'], '1.0.2');
  assert.equal(manifest.dependencies['@copilotkit/runtime'], manifest.dependencies['@copilotkit/react-core']);
  for (const path of ['apps/demo/.env.example', 'apps/demo/package-lock.json', 'infra/demo-entra.bicep']) {
    assert.ok((await readFile(new URL(path, root))).length);
  }
});
