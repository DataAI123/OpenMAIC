import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enterpriseSuiteFailures,
  REQUIRED_ENTERPRISE_SUITES,
} from './assert-enterprise-regression-suites.mjs';

function passingResults(suites = REQUIRED_ENTERPRISE_SUITES) {
  return {
    testResults: suites.map((name) => ({
      name: `D:/workspace/${name}`,
      status: 'passed',
      assertionResults: [{ status: 'passed' }],
    })),
  };
}

test('accepts every required suite when each collected case passed', () => {
  assert.deepEqual(enterpriseSuiteFailures(passingResults()), []);
});

test('rejects a required suite that was filtered out during collection', () => {
  const results = passingResults();
  results.testResults = results.testResults.slice(1);
  assert.match(enterpriseSuiteFailures(results)[0], /did not run/);
});

test('rejects a suite with skipped cases even if another case passed', () => {
  const results = passingResults();
  results.testResults[0].assertionResults.push({ status: 'pending' });
  assert.match(enterpriseSuiteFailures(results)[0], /skipped or unfinished/);
});

test('rejects a suite with no assertions', () => {
  const results = passingResults();
  results.testResults[0].assertionResults = [];
  assert.match(enterpriseSuiteFailures(results)[0], /no passing test cases/);
});

test('applies the same required-run guard to a separate PostgreSQL suite list', () => {
  const suites = ['tests/agent-runtime/session-events-live.pg.test.ts'];
  assert.deepEqual(enterpriseSuiteFailures(passingResults(suites), suites), []);
  assert.match(enterpriseSuiteFailures(passingResults(), suites)[0], /did not run/);
});
