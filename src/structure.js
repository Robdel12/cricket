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

Cricket owns the architecture. Your app owns the behavior.

- \`api/index.js\` is the normal Node entrypoint and visible Cricket app wiring.
- \`api/domains/\` contains product API domains.
- \`api/middleware/\` contains request middleware such as auth extraction, request IDs, rate limits, raw webhooks, CORS, and frontend fallbacks.
- \`api/services/\` contains narrow app-wide capabilities that are not owned by one domain.
- \`api/workers/\` contains background worker entrypoints that start Cricket workers.
- \`api/migrations/\` contains app-owned database migrations for \`cricket migrate\`.
- \`api/dev/\` contains local-only developer support code. It is not product architecture and must not be required by production runtime.

First-class means scaffolded, documented, inspectable, and agent-readable. It does not mean Cricket owns auth policy, table design, product data policy, local tooling, or deployment.

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
app-owned cron sidecars. Test schedules through the worker boundary with a fixed
clock and \`worker.schedules.tick()\`.

Use \`jobFailure({ retrying, exhausted })\` when product records need to follow
retry decisions. The handlers run after Cricket has scheduled a retry or marked
the envelope failed, and they receive app capabilities instead of Redis objects.

Use \`createCricketJobs\` in producers that only enqueue work. Use
\`startCricketWorker\` in \`api/workers/\` entrypoints that execute work, then
\`worker.run()\` for the Cricket-owned job loop. Deploy checks and product
health remain app-owned.
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
  '.agents/skills/cricket-api/SKILL.md': `---
name: cricket-api
description: Work in a Cricket Node API app with predictable domain files, validations, normalizers, serializers, jobs, app middleware/services/workers/migrations, Zod contracts, Knex services, and OpenAPI generation.
---

# Cricket API Skill

Use this when changing a Cricket API app.

## Orientation

Start with \`pnpm cricket inspect api/index.js\`, then read \`api/index.js\` and the domain files for the feature you are changing.

## App Folders

- Cricket owns the architecture, HTTP runtime, job runtime, logger, trace, and read-only runtime lifecycle. The app owns product behavior, auth policy, data work, worker entrypoints, product health, and deployment.
- \`api/middleware/\` is for request middleware, not domain authorization.
- \`api/services/\` is for narrow app-wide capabilities not owned by one domain.
- \`api/workers/\` is for background worker entrypoints that start Cricket workers.
- \`api/migrations/\` is app-owned migration history for the app's Cricket database contract.
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

## Jobs

Use \`defineJob\` when work should leave the request path and still keep Cricket's contract shape: validated input, immutable envelopes, retry policy, structured logs, traces, services, lifecycle, jobs, and progress.

Redis coordinates hot execution: queues, wakeups, leases, attempts, delayed availability, schedule materialization, and progress. App-owned tables keep product truth. The \`cricket_jobs\` table is a Cricket execution ledger for debugging and operator visibility, not the domain state model.

Use \`cronSchedule\` for recurring work. Keep schedules in \`*.jobs.js\`, drive them through \`startCricketWorker\`, and test them with fixed clocks plus \`worker.schedules.tick()\`. Do not add app-owned cron sidecars for Cricket jobs.

Use \`jobFailure({ retrying, exhausted })\` to sync product records after Cricket has made the retry decision. Do not inspect Redis from job code or failure handlers.

Use \`createCricketJobs\` for producer entrypoints that enqueue work without starting a worker. Use \`startCricketWorker\` from \`api/workers/\` to execute work, then \`worker.run()\` for the Cricket-owned job loop. Keep readiness checks and deployment behavior explicit in the app.

## Change Flow

1. Update the schema at the boundary that changed.
2. Put request/source input schemas in \`*.validations.js\` and import them explicitly.
3. Normalize third-party/source payloads in \`*.normalizers.js\`.
4. Shape API output in \`*.serializers.js\`.
5. Keep data and integration work in services.
6. Put auth, existence, and ownership checks in rules.
7. Put asynchronous contracts in \`*.jobs.js\` when the behavior runs outside the request path.
8. Keep endpoint handlers and job handlers focused on composition.
9. Generate OpenAPI and check the contract diff when HTTP contracts changed.
10. Add or update the domain-local \`*.test.js\`. Test HTTP behavior through HTTP, and test job behavior through the Cricket worker boundary.

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

After scaffolding a domain, make sure the app's \`domains\` value points at the domain root, add table migrations in \`api/migrations/\` when the domain persists data, and regenerate OpenAPI when HTTP contracts changed. If you add Cricket jobs with a database-backed app, add the \`cricket_jobs\` ledger migration deliberately instead of relying on worker startup.
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
    '  - .agents/skills/cricket-api/SKILL.md gives agents a project-local workflow.',
    '  - Run `pnpm cricket inspect api/index.js` and `pnpm cricket docs api/index.js --out openapi.json`.'
  );

  return lines.join('\n');
}
