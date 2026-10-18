import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = JSON.parse(readFileSync(resolve(root, 'evaluations/tutor-cases.json'), 'utf8'));
const rubric = JSON.parse(readFileSync(resolve(root, 'evaluations/tutor-rubric.json'), 'utf8'));

for (const agent of ['ai-tutor-hosted-agent', 'ai-tutor-prompt-agent']) {
  const directory = resolve(root, 'agents', agent, '.foundry');
  const outputs = [
    [`datasets/${agent}-curated-v1.jsonl`, cases.map((item) => JSON.stringify(item)).join('\n') + '\n'],
    ['evaluators/tutor-rubric-v1.json', JSON.stringify(rubric, null, 2) + '\n'],
    ['suites/curated-v1.json', JSON.stringify({
      status: 'local-draft',
      generationSource: 'curated-reference',
      targetAgent: agent,
      datasetFile: `.foundry/datasets/${agent}-curated-v1.jsonl`,
      rubricFile: '.foundry/evaluators/tutor-rubric-v1.json',
      caseCount: cases.length,
      tiers: Object.fromEntries(['smoke', 'regression', 'coverage'].map((tier) =>
        [tier, cases.filter((item) => item.tier === tier).length])),
      categoryCounts: Object.fromEntries([...new Set(cases.map((item) => item.category))]
        .map((category) => [category, cases.filter((item) => item.category === category).length])),
      invocation: 'Delegated user Agent ID OBO through the existing demo adapter; hosted gateway token required.',
      gates: rubric.gates,
    }, null, 2) + '\n'],
  ];
  for (const [name, content] of outputs) {
    const path = resolve(directory, name);
    if (existsSync(path) && readFileSync(path, 'utf8') !== content) {
      throw new Error(`Refusing to overwrite changed evaluation asset: ${path}`);
    }
  }
  for (const [name, content] of outputs) {
    const path = resolve(directory, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
  }
  console.log(JSON.stringify({ agent, cases: cases.length, status: 'local-draft', remoteRegistration: false }));
}
