const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('../../backend/node_modules/js-yaml');
const root = path.resolve(__dirname, '../..');
const readWorkflow = name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));

for (const name of fs.readdirSync(path.join(root, '.github/workflows'))) {
  test(`${name} uses hosted runners for executable jobs`, () => {
    for (const job of Object.values(readWorkflow(name).jobs)) {
      if (job['runs-on']) assert.ok(['ubuntu-24.04', 'ubuntu-latest'].includes(job['runs-on']), job['runs-on']);
    }
  });
}
for (const name of ['ci.yml', 'backend-integration.yml', 'supply-chain-audit.yml']) {
  test(`${name} covers main and PR updates`, () => {
    const events = readWorkflow(name).on;
    assert.deepEqual(events.push.branches, ['main']);
    for (const event of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
      assert.ok(events.pull_request.types.includes(event));
    }
    assert.equal(events.pull_request_target, undefined);
  });
}
test('backend CI runs Signet regression, full tests and build', () => {
  const steps = readWorkflow('ci.yml').jobs.backend.steps;
  for (const command of ['npm run test:signet', 'npm run test:ci', 'npm run build']) {
    assert.ok(steps.some(step => step.run?.includes(command)), command);
  }
});
test('automatic browser tests do not require Cypress Cloud credentials', () => {
  for (const step of readWorkflow('ci.yml').jobs.e2e.steps) {
    if (step.uses?.startsWith('cypress-io/github-action')) {
      assert.equal(step.with.record, false);
      assert.equal(step.with.parallel, false);
    }
  }
});
