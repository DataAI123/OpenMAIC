import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ENTERPRISE_E2E_TESTS = [
  'owner completes HTTPS OIDC login and receives only its tenant permissions',
  'viewer completes HTTPS OIDC login and receives only its tenant permissions',
  'a user with multiple tenant memberships must choose before using a tenant',
];

function collectTests(suites) {
  const tests = [];
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) tests.push({ title: spec.title, test });
    }
    tests.push(...collectTests(suite.suites ?? []));
  }
  return tests;
}

export function assertEnterpriseE2eReport(report) {
  assert.ok(report && typeof report === 'object', 'Playwright report must be an object');
  const actualTests = collectTests(Array.isArray(report.suites) ? report.suites : []);
  assert.equal(
    actualTests.length,
    REQUIRED_ENTERPRISE_E2E_TESTS.length,
    `expected exactly ${REQUIRED_ENTERPRISE_E2E_TESTS.length} required enterprise E2E tests`,
  );

  const actualTitles = actualTests.map(({ title }) => title).sort();
  assert.deepEqual(actualTitles, [...REQUIRED_ENTERPRISE_E2E_TESTS].sort());
  for (const { title, test } of actualTests) {
    assert.equal(test.status, 'expected', `${title} must not be skipped or flaky`);
    assert.equal(test.expectedStatus, 'passed', `${title} must expect a passing result`);
    assert.equal(test.results?.length, 1, `${title} must run exactly once without retries`);
    assert.equal(test.results[0]?.status, 'passed', `${title} must pass`);
  }

  assert.deepEqual(report.stats, {
    ...report.stats,
    expected: REQUIRED_ENTERPRISE_E2E_TESTS.length,
    unexpected: 0,
    flaky: 0,
    skipped: 0,
  });
  return actualTests.length;
}

async function main() {
  if (process.env.ENTERPRISE_E2E_REQUIRED !== '1') {
    throw new Error('Set ENTERPRISE_E2E_REQUIRED=1 in the required enterprise E2E job.');
  }
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error('Pass the Playwright JSON report path.');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const passed = assertEnterpriseE2eReport(report);
  process.stdout.write(
    `Enterprise E2E required gate: ${passed} expected tests passed, zero skipped.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Enterprise E2E guard failed'}\n`,
    );
    process.exitCode = 1;
  });
}
