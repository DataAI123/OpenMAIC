import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertEnterpriseE2eReport,
  REQUIRED_ENTERPRISE_E2E_TESTS,
} from './assert-enterprise-e2e-results.mjs';

function passingReport() {
  return {
    suites: [
      {
        title: 'enterprise',
        specs: REQUIRED_ENTERPRISE_E2E_TESTS.map((title) => ({
          title,
          tests: [
            {
              status: 'expected',
              expectedStatus: 'passed',
              results: [{ status: 'passed' }],
            },
          ],
        })),
      },
    ],
    stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 },
  };
}

test('accepts exactly the owner, viewer, and tenant selection cases', () => {
  assert.equal(assertEnterpriseE2eReport(passingReport()), 3);
});

test('rejects a missing required browser case', () => {
  const report = passingReport();
  report.suites[0].specs.pop();
  assert.throws(() => assertEnterpriseE2eReport(report), /expected exactly 3/);
});

test('rejects skipped or retried tests', () => {
  const report = passingReport();
  report.suites[0].specs[1].tests[0].status = 'skipped';
  report.suites[0].specs[1].tests[0].results = [];
  report.stats = { ...report.stats, expected: 1, skipped: 1 };
  assert.throws(() => assertEnterpriseE2eReport(report), /must not be skipped or flaky/);
});

test('rejects unexpected and flaky test totals', () => {
  const report = passingReport();
  report.stats = { ...report.stats, unexpected: 1 };
  assert.throws(() => assertEnterpriseE2eReport(report), /unexpected/);
});
