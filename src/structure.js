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
- \`api/workers/\` contains background worker entrypoints that call services.
- \`api/migrations/\` contains app-owned database migrations for \`cricket migrate\`.
- \`api/dev/\` contains local-only developer support code. It is not product architecture and must not be required by production runtime.

First-class means scaffolded, documented, inspectable, and easy for agents to follow. It does not mean Cricket secretly owns auth policy, table design, queues, local tooling, or deployment.

## Domain Shape

- \`*.model.js\` owns durable row fields and public/private visibility.
- \`*.validations.js\` owns reusable request, source, and service input schemas.
- \`*.normalizers.js\` owns pure source-boundary projections for third-party, webhook, queue, import, or legacy payloads.
- \`*.serializers.js\` owns response projections and validates output contracts.
- \`*.service.js\` owns data and integration operations.
- \`*.rules.js\` owns auth, existence, ownership, and business preconditions.
- \`*.routes.js\` owns endpoint contracts.
- \`*.test.js\` tests endpoint behavior through HTTP.

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
description: Work in a Cricket Node API app with predictable domain files, validations, normalizers, serializers, app middleware/services/workers/migrations, Zod contracts, Knex services, and OpenAPI generation.
---

# Cricket API Skill

Use this when changing a Cricket API app.

## Orientation

Start with \`pnpm cricket inspect api/index.js\`, then read \`api/index.js\` and the domain files for the feature you are changing.

## App Folders

- Cricket owns the architecture and HTTP runtime. The app owns product behavior, auth policy, data work, queues, and deployment.
- \`api/middleware/\` is for request middleware, not domain authorization.
- \`api/services/\` is for narrow app-wide capabilities not owned by one domain.
- \`api/workers/\` is for background worker entrypoints that call services.
- \`api/migrations/\` is app-owned migration history for the app's Cricket database contract.
- \`api/dev/\` is for local-only development support. If code touches product behavior, move that behavior into a real service, worker, migration, or domain.

## Change Flow

1. Update the schema at the boundary that changed.
2. Put request/source input schemas in \`*.validations.js\` and import them explicitly.
3. Normalize third-party/source payloads in \`*.normalizers.js\`.
4. Shape API output in \`*.serializers.js\`.
5. Keep data and integration work in services.
6. Put auth, existence, and ownership checks in rules.
7. Keep endpoint handlers focused on composition.
8. Generate OpenAPI and check the contract diff.
9. Add or update the domain-local \`*.test.js\` and test through HTTP for endpoint behavior.

## Commands

\`\`\`sh
pnpm cricket init app .
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket migrate status api/index.js
pnpm cricket new domain project api/domains
pnpm test
\`\`\`

After scaffolding a domain, make sure the app's \`domains\` value points at the domain root, add the table migration in \`api/migrations/\` if this domain persists data, then regenerate OpenAPI.
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
