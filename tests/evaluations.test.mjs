import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const cases = JSON.parse(read('evaluations/tutor-cases.json'));
const rubric = JSON.parse(read('evaluations/tutor-rubric.json'));

test('curated baseline has 100 unique cases across 16 well-covered categories', () => {
  assert.equal(cases.length, 100);
  assert.equal(new Set(cases.map((item) => item.id)).size, 100);
  assert.equal(new Set(cases.map((item) => item.query)).size, 100);
  const categories = [...new Set(cases.map((item) => item.category))];
  assert.equal(categories.length, 16);
  for (const category of categories) {
    assert.ok(cases.filter((item) => item.category === category).length >= 6);
    assert.ok(cases.some((item) => item.category === category && item.tier === 'smoke'));
    assert.ok(cases.some((item) => item.category === category && item.tier === 'regression'));
  }
  for (const item of cases) {
    assert.ok(item.expected_behavior.length > 40, item.id);
    assert.ok(item.query.length <= 16000, item.id);
    assert.ok(['smoke', 'regression', 'coverage'].includes(item.tier));
    if (item.history) {
      assert.ok(item.history.length <= 38);
      assert.equal(item.history.at(-1).role, 'assistant');
    }
  }
  assert.equal(cases.filter((item) => item.history).length, 10);
  assert.ok(cases.filter((item) => item.ground_truth).length >= 55);
});
test('rubric preserves approved provisional gates and does not pretend calibration', () => {
  assert.equal(Object.keys(rubric.dimensions).length, 6);
  assert.equal(rubric.gates.status, 'provisional-until-human-calibrated');
  assert.equal(rubric.gates.minimumOverallPassRate, 0.9);
  assert.equal(rubric.gates.minimumCategoryPassRate, 0.8);
  assert.equal(rubric.gates.maximumSafetyPrivacyFailures, 0);
  assert.equal(rubric.gates.minimumDimensionScore, 3);
});
test('per-agent curated datasets and rubrics are identical and reproducible', () => {
  execFileSync(process.execPath, ['scripts/create-tutor-evaluation-assets.mjs'], { stdio: 'pipe' });
  for (const agent of ['ai-tutor-hosted-agent', 'ai-tutor-prompt-agent']) {
    const base = `agents/${agent}/.foundry`;
    const dataset = read(`${base}/datasets/${agent}-curated-v1.jsonl`).trim().split('\n').map(JSON.parse);
    assert.deepEqual(dataset, cases);
    assert.deepEqual(JSON.parse(read(`${base}/evaluators/tutor-rubric-v1.json`)), rubric);
    const suite = JSON.parse(read(`${base}/suites/curated-v1.json`));
    assert.equal(suite.status, 'local-draft');
    assert.equal(suite.caseCount, 100);
    assert.deepEqual(suite.tiers, { smoke: 16, regression: 18, coverage: 66 });
    assert.equal(suite.targetAgent, agent);
    assert.equal(suite.suiteName, undefined);
  }
});
