import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * File types generated for each scaffolded Cricket domain.
 */
export let domainFileTypes = [
  'model',
  'validations',
  'normalizers',
  'serializers',
  'service',
  'rules',
  'routes',
  'test'
];

function toWords(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function toFileStem(value) {
  return toWords(value)
    .map(word => word.toLowerCase())
    .join('-');
}

function toPascalCase(value) {
  return toWords(value)
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join('');
}

function toCamelCase(value) {
  let pascal = toPascalCase(value);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function toTableName(value) {
  return toWords(value)
    .map(word => word.toLowerCase())
    .join('_');
}

function fileNameFor(fileStem, type) {
  return `${fileStem}.${type}.js`;
}

function domainFilePath(domainRoot, fileStem, type) {
  return path.join(domainRoot, fileNameFor(fileStem, type));
}

function modelTemplate({ pascalName, tableName }) {
  return `import {
  defineModel,
  field,
  z
} from '@robdel12/cricket';

export let ${pascalName} = defineModel({
  name: '${pascalName}',
  table: '${tableName}',
  row: {
    id: field.public(z.uuid())
  }
});
`;
}

function validationsTemplate({ pascalName }) {
  return `import { z } from '@robdel12/cricket';

// Rename this to the first body, params, query, source, or service input your domain needs.
export let ${pascalName}CreateInput = z.object({});
`;
}

function serializersTemplate({ fileStem, pascalName }) {
  return `import {
  defineSerializer,
  pickFields
} from '@robdel12/cricket';

import { ${pascalName} } from './${fileStem}.model.js';

export let serialize${pascalName}Public = defineSerializer({
  name: '${pascalName}.public',
  output: ${pascalName}.public,
  serialize: pickFields(['id'])
});
`;
}

function normalizersTemplate({ pascalName }) {
  return `// Add ${pascalName} source-boundary normalizers here.
`;
}

function serviceTemplate({ pascalName }) {
  return `export function create${pascalName}Service() {
  return {};
}
`;
}

function rulesTemplate({ pascalName }) {
  return `// Add ${pascalName} auth, existence, ownership, and business guards here.
`;
}

function routesTemplate({ camelName }) {
  return `// Add ${camelName} endpoint contracts here.
export let ${camelName}Endpoints = [
];
`;
}

function testTemplate({ fileStem }) {
  return `import { describe, it } from 'node:test';

describe('${fileStem} endpoints', () => {
  it('tests user-visible HTTP behavior through the app boundary', async () => {
    // Start the real app test server, make an HTTP request, and assert the response.
  });
});
`;
}

let templates = {
  model: modelTemplate,
  validations: validationsTemplate,
  normalizers: normalizersTemplate,
  serializers: serializersTemplate,
  service: serviceTemplate,
  rules: rulesTemplate,
  routes: routesTemplate,
  test: testTemplate
};

function templateFor(type, domain) {
  return templates[type](domain);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a user-supplied domain name into the file and symbol names used
 * by the scaffold templates.
 *
 * @param {string} name - Human-entered domain name from the CLI.
 * @returns {{
 *   camelName: string,
 *   fileStem: string,
 *   pascalName: string,
 *   tableName: string
 * }} Derived names used across generated files.
 */
export function domainNames(name) {
  let fileStem = toFileStem(name);

  if (!fileStem)
    throw new Error('Domain name is required');

  return {
    camelName: toCamelCase(fileStem),
    fileStem,
    pascalName: toPascalCase(fileStem),
    tableName: toTableName(fileStem)
  };
}

/**
 * Create or overwrite the standard Cricket domain files for a feature area.
 *
 * @param {object} options - Scaffolding options.
 * @param {string} [options.root='.'] - Directory that will contain the domain folder.
 * @param {string} options.name - Domain name to scaffold.
 * @param {boolean} [options.force=false] - Overwrite existing files when true.
 * @returns {Promise<{
 *   created: string[],
 *   skipped: string[],
 *   domainRoot: string
 * }>} Summary of the scaffold operation.
 */
export async function scaffoldDomain({
  root = '.',
  name,
  force = false
}) {
  let domain = domainNames(name);
  let domainRoot = path.join(root, domain.fileStem);
  let created = [];
  let skipped = [];

  await fs.mkdir(domainRoot, { recursive: true });

  for (let type of domainFileTypes) {
    let filePath = domainFilePath(domainRoot, domain.fileStem, type);
    let exists = await pathExists(filePath);

    if (exists && !force) {
      skipped.push(filePath);
      continue;
    }

    await fs.writeFile(filePath, templateFor(type, domain));
    created.push(filePath);
  }

  return {
    created,
    skipped,
    domain,
    root,
    domainRoot
  };
}

/**
 * Format the scaffold summary for terminal output.
 *
 * @param {{
 *   created: string[],
 *   skipped: string[],
 *   domain: {
 *     camelName: string,
 *     fileStem: string,
 *     pascalName: string,
 *     tableName: string
 *   },
 *   root: string,
 *   domainRoot: string
 * }} result - Summary returned by {@link scaffoldDomain}.
 * @returns {string} Human-readable multi-line status message.
 */
export function formatScaffoldResult(result) {
  let lines = [
    `Created ${result.domain.camelName} domain at ${result.domainRoot}`,
    '',
    'Files'
  ];

  for (let filePath of result.created)
    lines.push(`  + ${filePath}`);

  for (let filePath of result.skipped)
    lines.push(`  ! skipped existing ${filePath}`);

  lines.push(
    '',
    'Next',
    `  - Add the ${result.domain.tableName} table migration in api/migrations/.`,
    `  - Point \`defineCricketApp({ domains })\` at the domain root (${result.root}).`,
    '  - Run `pnpm cricket inspect <app-module>` and `pnpm cricket docs <app-module> --out openapi.json`.'
  );

  return lines.join('\n');
}

function appIndexTemplate() {
  return `import { defineCricketApp, startCricketApp } from '@robdel12/cricket';

export let app = defineCricketApp({
  name: 'Cricket API',
  version: '1.0.0',
  logger: {
    service: 'cricket-api',
    level: process.env.LOG_LEVEL ?? 'info'
  },
  domains: './domains'
});

if (process.env.NODE_ENV !== 'test')
  await startCricketApp(app, {
    port: process.env.PORT || 3000,
    main: import.meta.url
  });
`;
}

export let appPaths = [
  'api/index.js',
  'api/domains',
  'api/middleware',
  'api/services',
  'api/workers',
  'api/migrations',
  'api/dev'
];

let appFileTemplates = {
  'api/index.js': appIndexTemplate
};

async function scaffoldPath(root, relativePath, {
  force
}) {
  let filePath = path.join(root, relativePath);
  let template = appFileTemplates[relativePath];
  let exists = await pathExists(filePath);

  if (exists && (!template || !force))
    return { skipped: filePath };

  if (template) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, template());
    return { created: filePath };
  }

  await fs.mkdir(filePath, { recursive: true });
  return { created: filePath };
}

/**
 * Scaffold the small recommended Cricket app shell.
 *
 * @param {object} [options]
 * @param {string} [options.root='.'] - Project root.
 * @param {boolean} [options.force=false] - Overwrite existing files when true.
 * @returns {Promise<{root: string, created: string[], skipped: string[]}>}
 */
export async function scaffoldApp({
  root = '.',
  force = false
} = {}) {
  let created = [];
  let skipped = [];

  for (let relativePath of appPaths) {
    let result = await scaffoldPath(root, relativePath, { force });

    if (result.created)
      created.push(result.created);

    if (result.skipped)
      skipped.push(result.skipped);
  }

  return {
    root,
    created,
    skipped
  };
}

/**
 * Format the app scaffold summary for terminal output.
 *
 * @param {{root: string, created: string[], skipped: string[]}} result
 * @returns {string}
 */
export function formatAppScaffoldResult(result) {
  let lines = [
    `Created Cricket app structure at ${result.root}`,
    '',
    'Paths'
  ];

  for (let filePath of result.created)
    lines.push(`  + ${filePath}`);

  for (let filePath of result.skipped)
    lines.push(`  ! skipped existing ${filePath}`);

  lines.push(
    '',
    'Next',
    '  - Add domains with `pnpm cricket new domain project api/domains`.',
    '  - Configure `defineCricketApp({ database })` and put migrations in `api/migrations` if the app persists data.',
    '  - Run `pnpm cricket inspect api/index.js` and `pnpm cricket docs api/index.js --out openapi.json`.'
  );

  return lines.join('\n');
}

let agentGuidanceStart = '<!-- cricket-agent-guidance -->';
let agentGuidanceEnd = '<!-- /cricket-agent-guidance -->';

function appendSection(content, section) {
  if (!content.trim())
    return section;

  return `${content.replace(/\s*$/, '')}\n\n${section}`;
}

function replaceMarkedSection(content, section) {
  let start = content.indexOf(agentGuidanceStart);
  let end = content.indexOf(agentGuidanceEnd);

  if (start === -1 || end === -1 || end < start)
    return appendSection(content, section);

  return `${content.slice(0, start)}${section}${content.slice(end + agentGuidanceEnd.length)}`;
}

function createAgentGuidanceContent() {
  return `${agentGuidanceStart}
## Cricket App Guidance

## App Shape

Cricket provides the architecture. Your app defines the behavior.

- \`api/index.js\` is the normal Node entrypoint and visible Cricket app wiring.
- \`api/domains/\` contains product API domains.
- \`api/middleware/\` contains request middleware such as auth extraction, request IDs, rate limits, raw webhooks, CORS, and frontend fallbacks.
- \`api/services/\` contains narrow app-wide capabilities that are not owned by one domain.
- \`api/workers/\` contains background worker entrypoints that start Cricket workers.
- \`api/migrations/\` contains app database migrations for \`cricket migrate\`.
- \`api/dev/\` contains local-only developer support code. It is not product architecture and must not be required by production runtime.

First-class means scaffolded, documented, inspectable, and agent-readable. It does not mean Cricket takes over auth policy, table design, product data policy, local tooling, or deployment.

Cricket passes runtime capabilities such as \`lifecycle\`, \`logger\`, \`services\`,
and \`trace\` through setup, middleware, context, handlers, workers, and shutdown
hooks. Product health checks may read \`lifecycle\`, but they still own database,
worker, and deploy readiness.

## Domain Shape

- \`*.model.js\` owns durable row fields and public/private visibility.
- \`*.validations.js\` owns reusable request, source, and service input schemas.
- \`*.normalizers.js\` owns pure source-boundary projections for third-party, webhook, queue, import, or legacy payloads.
- \`*.serializers.js\` owns response projections and validates output contracts.
- \`*.service.js\` owns data and integration operations.
- \`*.rules.js\` owns auth, existence, ownership, and business preconditions.
- \`*.routes.js\` owns endpoint contracts.
- \`*.jobs.js\` owns background job contracts for validated asynchronous work.
- \`*.test.js\` tests endpoint behavior through HTTP and job behavior through the worker boundary.

The folder is the domain. Keep services boring, rules named, and routes thin.
Keep HTTP request behavior in \`middleware/\`, not in rules. Keep app-wide clients
and shared capabilities in \`services/\`, not in one random domain.
Keep source payload weirdness in \`*.normalizers.js\`, not scattered through
services and routes.
Keep create/update/search/import input contracts in \`*.validations.js\`, not on
the model. Routes still import validations explicitly; Cricket does not
auto-wire schemas by name.
If code affects product behavior, start in the domain that owns it. Reach for an
app service, worker, middleware, or migration only when the responsibility is
actually shared, asynchronous, HTTP-edge, or schema-changing. Keep \`dev/\`
local-only.

## Jobs

Use \`defineJob\` for asynchronous work that needs validated input, retry policy,
Redis coordination, and the same services/logger/trace/lifecycle/jobs/progress
capabilities as HTTP.
Keep job contracts in domain-local \`*.jobs.js\` files when the work belongs to
one domain.

Redis is hot coordination: queue membership, leases, wakeups, attempts, delayed
availability, schedule materialization, and progress. App tables keep product
truth. Add Cricket's \`cricket_jobs\` ledger in a normal app migration when you
want execution history, but do not use it as the domain state model.

Use \`cronSchedule\` for recurring work. Schedules live on job contracts, not in
separate app cron sidecars. Test schedules through the worker boundary with a fixed
clock and \`worker.schedules.tick()\`.

Use \`jobFailure({ retrying, exhausted })\` when product records need to follow
retry decisions. The handlers run after Cricket has scheduled a retry or marked
the envelope failed, and they receive app capabilities instead of Redis objects.

Use \`createCricketJobs\` in producers that only enqueue work. Use
\`startCricketWorker\` in \`api/workers/\` entrypoints that execute work, then
\`worker.run()\` for the job loop. Deploy checks and product health remain app
responsibility.
${agentGuidanceEnd}
`;
}

function trackScaffoldResult(result, buckets) {
  if (result.status === 'created')
    buckets.created.push(result.filePath);
  else if (result.status === 'updated')
    buckets.updated.push(result.filePath);
  else
    buckets.skipped.push(result.filePath);
}

let agentFiles = {
  '.agents/skills/cricket/SKILL.md': `---
name: cricket
description: Work in a Cricket Node API app. Use when changing Cricket domains, routes, validations, normalizers, serializers, services, rules, app structure, CLI usage, OpenAPI docs, or when deciding where product behavior belongs in a Cricket project.
---

# Cricket Skill

Use this when changing a Cricket API app.

## Orientation

Start with \`pnpm cricket inspect api/index.js\`, then read \`api/index.js\` and the domain files for the feature you are changing.

## Principles

- Keep data plain: no model instances, hidden mutation, or ORM lifecycle.
- Put contracts at real boundaries: requests, responses, source payloads, jobs, and database rows.
- Compose small functions. Keep side effects in services, handlers, jobs, middleware, migrations, or external clients.
- Preserve predictable files. Agents should be able to guess where behavior lives.

## App Shape

- Cricket provides the architecture, HTTP runtime, job runtime, logger, trace, and read-only runtime lifecycle. The app defines product behavior, auth policy, data work, worker entrypoints, product health, and deployment.
- \`api/middleware/\` is for request middleware, not domain authorization.
- \`api/services/\` is for narrow app-wide capabilities not owned by one domain.
- \`api/workers/\` is for background worker entrypoints that start Cricket workers.
- \`api/migrations/\` is migration history for the app's Cricket database contract.
- \`api/dev/\` is for local-only development support. If code touches product behavior, move that behavior into a real service, worker, migration, or domain.

## Domain Files

- Put durable row contracts in \`*.model.js\`.
- Put request, source, and service input schemas in \`*.validations.js\`.
- Put pure source-boundary projections in \`*.normalizers.js\`.
- Put outgoing API projections in \`*.serializers.js\`.
- Put data and integration operations in \`*.service.js\`.
- Put auth, existence, ownership, and business checks in \`*.rules.js\`.
- Put endpoint contracts in \`*.routes.js\`.
- Put asynchronous job contracts in \`*.jobs.js\`.

The folder is the domain. Optional files stay optional, but standard filenames should stay predictable.

## Change Flow

1. Update the schema at the boundary that changed.
2. Put request/source input schemas in \`*.validations.js\` and import them explicitly.
3. Normalize third-party/source payloads in \`*.normalizers.js\`.
4. Shape API output in \`*.serializers.js\`.
5. Keep data and integration work in services.
6. Put auth, existence, and ownership checks in rules.
7. Put async contracts in \`*.jobs.js\` when behavior leaves the request path.
8. Keep endpoint handlers and job handlers focused on composition.
9. Generate OpenAPI and check the contract diff when HTTP contracts changed.

## Focused Skills

- Use \`cricket-jobs\` for background work, scheduling, retries, worker entrypoints, and the \`cricket_jobs\` ledger.
- Use \`cricket-observability\` for logging, tracing, lifecycle, request/job inspection, and \`cricket trace\`.
- Use \`cricket-testing\` for HTTP-boundary tests, worker-boundary job tests, test state, and Cricket's test CLI.

## Commands

\`\`\`sh
pnpm cricket init app .
pnpm cricket init agents .
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate status api/index.js
pnpm cricket new domain project api/domains
pnpm test
\`\`\`

After scaffolding a domain, make sure the app's \`domains\` value points at the domain root, add table migrations in \`api/migrations/\` when the domain persists data, and regenerate OpenAPI when HTTP contracts changed.
`,
  '.agents/skills/cricket-jobs/SKILL.md': `---
name: cricket-jobs
description: Build, review, or test Cricket jobs. Use when working with defineJob, redisQueue, retry, jobFailure, cronSchedule, createCricketJobs, startCricketWorker, worker entrypoints, job ledgers, scheduled work, delayed work, or background processing in a Cricket app.
---

# Cricket Jobs Skill

Use this when work leaves the request path but should keep Cricket's contract shape.

## Shape

- Put jobs in \`api/domains/<domain>/<domain>.jobs.js\` when the work belongs to one domain.
- Use \`defineJob\` with validated \`input\`, optional \`context\`, queue metadata, retry policy, failure handlers, state metadata, and a plain \`run\`.
- Keep product truth in app tables and services. Redis coordinates hot execution: queues, wakeups, leases, attempts, delayed availability, schedules, and progress.
- Add \`cricket_jobs\` with \`createJobLedgerTable\` in an app migration when the app uses a Cricket database. Treat it as execution history, not product state.

## Producers And Workers

- Use \`createCricketJobs\` when code only needs to enqueue work.
- Use \`startCricketWorker\` in \`api/workers/\` entrypoints that execute jobs, then call \`worker.run()\`.
- Job \`run\` functions receive \`input\`, \`context\`, \`services\`, \`logger\`, \`trace\`, \`lifecycle\`, \`jobs\`, and \`progress\`. They should not receive Redis clients.
- Enqueue with \`runAt\` or \`delayMs\` for one-off delayed work.

## Scheduling

- Use \`cronSchedule\` on the job contract for recurring work.
- Keep cron, timezone, enablement, and due-slot input next to the job.
- Do not add separate app cron sidecars for Cricket jobs.
- Test schedules with a fixed clock, \`worker.schedules.tick()\`, and \`worker.drain()\`.

## Failure And Retry

- Use \`retry\` to decide whether Cricket should try again.
- Use \`jobFailure({ retrying, exhausted })\` when product records need to follow retry decisions.
- Failure handlers receive app capabilities plus \`error\`, \`failure\`, \`envelope\`, and \`attempt\`. Keep them focused on product state sync.
- If failure handlers throw, Cricket logs that handler failure and keeps the original job failure as the important error.
`,
  '.agents/skills/cricket-observability/SKILL.md': `---
name: cricket-observability
description: Work with Cricket logging, tracing, lifecycle state, test state, inspect output, request/job observability, or the cricket trace CLI. Use when adding, reviewing, debugging, or testing observability in a Cricket app.
---

# Cricket Observability Skill

Use this when a change touches how a Cricket app explains itself.

## Logger

- Use the Cricket logger shape passed through setup, services, rules, middleware, handlers, jobs, workers, startup, shutdown, and errors.
- Prefer structured metadata over formatted strings.
- Do not log secrets. Cricket redacts common secret-shaped keys, but app code should still avoid putting sensitive values in logs.
- Use child metadata for stable facts such as \`requestId\`, job identity, route identity, account IDs, or operation names.

## Trace

- Use \`trace.span(name, metadata, fn)\` around meaningful work, especially service calls, external calls, and job steps.
- Keep span names stable and domain-readable.
- Do not turn tracing into logging. Spans should explain timing and nesting.
- Use \`pnpm cricket trace\` with newline-delimited JSON logs when debugging one request timeline.

## Lifecycle

- Read \`lifecycle\` from setup, services, middleware, context, handlers, jobs, workers, and shutdown hooks.
- Use lifecycle state for readiness and shutdown decisions. Product health checks still decide whether the app is ready for traffic.
- Do not invent separate lifecycle globals.

## Debugging Flow

1. Run \`pnpm cricket inspect api/index.js\` to confirm loaded domains, routes, jobs, services, and observability posture.
2. Reproduce through HTTP or the worker boundary.
3. Use test state or Cricket logs to inspect request/job events, logs, spans, timings, and failures.
4. Add spans or metadata only where they improve diagnosis for the next operator.
`,
  '.agents/skills/cricket-testing/SKILL.md': `---
name: cricket-testing
description: Write or review tests in a Cricket app. Use when testing HTTP endpoints, validation, rules, serializers, normalizers, jobs, schedules, retries, ledgers, observability, Cricket test state, or the cricket test CLI.
---

# Cricket Testing Skill

Use this when adding or changing Cricket tests.

## Principles

- Test user-visible behavior through the boundary that consumes it.
- Use HTTP tests for endpoints. Use the worker boundary for jobs.
- Do not mock Cricket internals. Mock only external services, time, or randomness.
- Prefer deterministic state transitions over sleeps, polling, or timing guesses.
- Assert outcomes: status codes, response shapes, validation errors, persisted rows, job events, traces, ledger rows, and product state.

## HTTP Tests

- Use \`createTestRuntime(app)\` to get a real Cricket runtime and local HTTP client.
- Drive requests with \`api.get\`, \`api.post\`, \`api.patch\`, and related helpers.
- Inspect \`testState.request(requestId)\`, \`testState.trace(requestId)\`, logs, lifecycle events, and timings when they matter to behavior.
- Keep app database setup explicit. The test runtime does not reset product state for you.

## Job Tests

- Start jobs with \`startCricketWorker(app, { jobs, queues: { test: true } })\`.
- Use fixed clocks for delayed and scheduled work.
- Call \`worker.schedules.tick()\` to materialize due cron slots, then \`worker.drain()\` to execute ready work.
- Assert product state, job runtime events, traces, progress, retries, failure handlers, and ledger rows when relevant.

## CLI

\`\`\`sh
pnpm cricket test
pnpm cricket test api/domains/projects/projects.test.js --grep "creates"
pnpm cricket test --json
pnpm cricket test --output cricket-test-report.json
\`\`\`

Use \`pnpm test\` for the app's normal suite when the repo already defines it.
`
};

async function upsertAgentGuidance(root, {
  force = false
} = {}) {
  let filePath = path.join(root, 'AGENTS.md');
  let guidance = createAgentGuidanceContent();
  let exists = await pathExists(filePath);

  if (!exists) {
    await fs.writeFile(filePath, guidance);
    return {
      status: 'created',
      filePath
    };
  }

  let content = await fs.readFile(filePath, 'utf8');

  if (content.includes(agentGuidanceStart) && !force)
    return {
      status: 'skipped',
      filePath
    };

  await fs.writeFile(filePath, replaceMarkedSection(content, guidance));
  return {
    status: 'updated',
    filePath
  };
}

/**
 * Scaffold project-local agent guidance for Cricket apps.
 *
 * @param {object} [options]
 * @param {string} [options.root='.'] - Project root.
 * @param {boolean} [options.force=false] - Overwrite existing files when true.
 * @returns {Promise<{root: string, created: string[], skipped: string[], updated: string[]}>}
 */
export async function scaffoldAgentFiles({
  root = '.',
  force = false
} = {}) {
  let created = [];
  let skipped = [];
  let updated = [];
  let buckets = {
    created,
    skipped,
    updated
  };

  trackScaffoldResult(await upsertAgentGuidance(root, {
    force
  }), buckets);

  for (let [relativePath, content] of Object.entries(agentFiles)) {
    let filePath = path.join(root, relativePath);
    let exists = await pathExists(filePath);

    if (exists && !force) {
      skipped.push(filePath);
      continue;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    created.push(filePath);
  }

  return {
    root,
    created,
    skipped,
    updated
  };
}

/**
 * Format the agent scaffold summary for terminal output.
 *
 * @param {{root: string, created: string[], skipped: string[], updated?: string[]}} result
 * @returns {string}
 */
export function formatAgentScaffoldResult(result) {
  let lines = [
    `Created Cricket agent guidance at ${result.root}`,
    '',
    'Files'
  ];

  for (let filePath of result.created)
    lines.push(`  + ${filePath}`);

  for (let filePath of result.updated ?? [])
    lines.push(`  ~ ${filePath}`);

  for (let filePath of result.skipped)
    lines.push(`  ! skipped existing ${filePath}`);

  lines.push(
    '',
    'Next',
    '  - AGENTS.md explains the Cricket domain split.',
    '  - .agents/skills/cricket/SKILL.md gives agents the framework workflow.',
    '  - Focused skills cover jobs, observability, and testing.',
    '  - Run `pnpm cricket inspect api/index.js` and `pnpm cricket docs api/index.js --out openapi.json`.'
  );

  return lines.join('\n');
}
