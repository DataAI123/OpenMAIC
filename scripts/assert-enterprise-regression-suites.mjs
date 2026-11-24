import { readFileSync } from 'node:fs';

export const REQUIRED_ENTERPRISE_SUITES = [
  'tests/api/tenant-active.test.ts',
  'tests/api/tenant-members.test.ts',
  'tests/api/tenant-membership-lifecycle.test.ts',
  'tests/server/auth-session-tenant.test.ts',
  'tests/persistence/agent-session-tenant.test.ts',
  'tests/api/agent-sessions-tenant.test.ts',
  'tests/api/persistence-tenant-boundary.test.ts',
  'tests/persistence/owner-materials-tenant-boundary.test.ts',
  'tests/persistence/quota-tenant-boundaries-migration.test.ts',
  'tests/persistence/rate-limit-tenant-boundary-migration.test.ts',
  'tests/persistence/resource-tenant-boundaries-migration.test.ts',
  'tests/persistence/resource-tenant-boundaries-assets-migration.test.ts',
  'tests/persistence/full-migration-chain.test.ts',
  'tests/agent-runtime/persistence-routes-gate.test.ts',
  'tests/api/health-live.test.ts',
  'tests/api/health-ready.test.ts',
  'tests/api/auth-request-id.test.ts',
  'tests/api/auth-callback.test.ts',
  'tests/server/access-code-status-route.test.ts',
  'tests/server/access-code-verify-route.test.ts',
  'tests/server/request-id-owner-gate.test.ts',
  'tests/server/health-access-code.test.ts',
  'tests/server/video-export-capability.test.ts',
  'tests/server/middleware-oidc.test.ts',
  'tests/auth/client-login.test.ts',
  'tests/workbench/workspace-actions-auth.test.ts',
  'tests/agent-runtime/runtime-probe.test.ts',
  'tests/agent-runtime/sessions-route.test.ts',
  'tests/agent-runtime/session-detail-route.test.ts',
  'tests/agent-runtime/session-status-route.test.ts',
  'tests/agent-runtime/cancel-route.test.ts',
  'tests/agent-runtime/messages-route.test.ts',
  'tests/agent-runtime/skills-route.test.ts',
  'tests/agent-runtime/skill-detail-route.test.ts',
  'tests/agent-runtime/session-events-route.test.ts',
  'tests/agent-runtime/owner-events-route.test.ts',
  'tests/agent-runtime/stage-freshness-route.test.ts',
  'tests/agent-runtime/export-video-ownership.test.ts',
  'tests/agent-runtime/stages-route.test.ts',
  'tests/agent-runtime/stage-detail-route.test.ts',
  'tests/agent-runtime/material-detail-route.test.ts',
  'tests/agent-runtime/stage-meta-routes.test.ts',
  'tests/api/classroom-media-range.test.ts',
  'tests/api/verify-pdf-provider.test.ts',
  'tests/api/verify-image-provider.test.ts',
  'tests/api/verify-video-provider.test.ts',
  'tests/generation/safe-session.test.ts',
];

export const REQUIRED_ENTERPRISE_PG_SUITES = [
  'tests/agent-runtime/event-notify.pg.test.ts',
  'tests/agent-runtime/park-attempt-budget.pg.test.ts',
  'tests/agent-runtime/session-events-live.pg.test.ts',
  'tests/persistence/owner-materials.pg.test.ts',
];

export function enterpriseSuiteFailures(results, requiredSuites = REQUIRED_ENTERPRISE_SUITES) {
  if (!Array.isArray(results?.testResults)) {
    return ['Vitest JSON has no testResults array. Run with the json reporter.'];
  }

  const failures = [];
  for (const requiredSuite of requiredSuites) {
    const suite = results.testResults.find(
      (entry) =>
        typeof entry.name === 'string' && entry.name.replaceAll('\\', '/').endsWith(requiredSuite),
    );
    if (!suite) {
      failures.push(`${requiredSuite} did not run.`);
      continue;
    }

    const cases = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    const passed = cases.filter((testCase) => testCase.status === 'passed').length;
    const unfinished = cases.filter((testCase) => testCase.status !== 'passed');
    if (suite.status !== 'passed') {
      failures.push(`${requiredSuite} reported status "${suite.status}".`);
    } else if (passed === 0) {
      failures.push(`${requiredSuite} ran no passing test cases.`);
    } else if (unfinished.length > 0) {
      failures.push(`${requiredSuite} has ${unfinished.length} skipped or unfinished case(s).`);
    }
  }
  return failures;
}

function main() {
  const postgresMode = process.argv[2] === '--postgres';
  const requiredFlag = postgresMode
    ? process.env.ENTERPRISE_PG_REGRESSION_REQUIRED
    : process.env.ENTERPRISE_REGRESSION_REQUIRED;
  if (requiredFlag !== '1') {
    console.error(
      `Set ${postgresMode ? 'ENTERPRISE_PG_REGRESSION_REQUIRED' : 'ENTERPRISE_REGRESSION_REQUIRED'}=1 in the required CI step. This guard must not silently become optional.`,
    );
    process.exit(2);
  }
  if (postgresMode && !process.env.PG_CONTRACT_URL) {
    console.error('PG_CONTRACT_URL must be set for the required enterprise PostgreSQL suites.');
    process.exit(2);
  }
  const resultsPath = process.argv[postgresMode ? 3 : 2];
  if (!resultsPath || process.argv.length !== (postgresMode ? 4 : 3)) {
    console.error(
      'Usage: ENTERPRISE_REGRESSION_REQUIRED=1 node assert-enterprise-regression-suites.mjs <vitest-json>\n' +
        '   or: ENTERPRISE_PG_REGRESSION_REQUIRED=1 PG_CONTRACT_URL=... node assert-enterprise-regression-suites.mjs --postgres <vitest-json>',
    );
    process.exit(2);
  }

  let results;
  try {
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch (error) {
    console.error(`Cannot read Vitest JSON results: ${error.message}`);
    process.exit(2);
  }

  const requiredSuites = postgresMode ? REQUIRED_ENTERPRISE_PG_SUITES : REQUIRED_ENTERPRISE_SUITES;
  const failures = enterpriseSuiteFailures(results, requiredSuites);
  if (failures.length > 0) {
    console.error(
      [
        'Required enterprise regression suites are incomplete:',
        ...failures.map((item) => `- ${item}`),
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(
    `Verified ${requiredSuites.length} required enterprise${postgresMode ? ' PostgreSQL' : ''} suites ran with no skipped cases.`,
  );
}

if (process.argv[1]?.endsWith('assert-enterprise-regression-suites.mjs')) {
  main();
}
