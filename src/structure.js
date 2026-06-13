import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * File types generated for each scaffolded Cricket domain.
 */
export let domainFileTypes = [
  'model',
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
  return `import { z } from 'zod';

import { defineModel } from '@robdel12/cricket';

export let ${pascalName} = defineModel({
  name: '${pascalName}',
  table: '${tableName}',
  row: z.object({
    id: z.uuid()
  }),
  create: z.object({})
});
`;
}

function serializersTemplate({ pascalName }) {
  return `import { z } from 'zod';

import { pickFields } from '@robdel12/cricket';

export let ${pascalName}Public = z.object({
  id: z.uuid()
});

export let serialize${pascalName}Public = pickFields([
  'id'
]);
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
    `  - Add the ${result.domain.tableName} table or migration in your app.`,
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
  domains: './domains'
});

if (process.env.NODE_ENV !== 'test')
  await startCricketApp(app, { port: process.env.PORT || 3000 });
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
    '  - Point your app-owned Knex config at `api/migrations` if you use Knex.',
    '  - Run `pnpm cricket inspect api/index.js` and `pnpm cricket docs api/index.js --out openapi.json`.'
  );

  return lines.join('\n');
}

let agentFiles = {
  'AGENTS.md': `# Cricket App Guidance

## App Shape

- \`api/index.js\` is the normal Node entrypoint and visible Cricket app wiring.
- \`api/domains/\` contains product API domains.
- \`api/middleware/\` contains HTTP edge behavior such as auth extraction, uploads, rate limits, raw webhooks, CORS, and frontend fallbacks.
- \`api/services/\` contains app-wide services that are not owned by one domain.
- \`api/workers/\` contains background worker entrypoints that call services.
- \`api/migrations/\` contains app-owned database migrations. Point your own Knex config or command at this folder.
- \`api/dev/\` contains local-only developer support code. It is not product architecture and must not be required by production runtime.

## Domain Shape

- \`*.model.js\` owns row and input schemas.
- \`*.serializers.js\` owns response projections.
- \`*.service.js\` owns data operations.
- \`*.rules.js\` owns auth, existence, ownership, and business guards.
- \`*.routes.js\` owns endpoint contracts.
- \`*.test.js\` tests endpoint behavior through HTTP.

The folder is the domain. Keep services boring, rules named, and routes thin.
Keep HTTP edge behavior in \`middleware/\`, not in rules. Keep app-wide clients
and cross-domain helpers in \`services/\`, not in one random domain.
`,
  '.codex/skills/cricket-api/SKILL.md': `---
name: cricket-api
description: Work in a Cricket Node API app with predictable domain files, app middleware/services/workers/migrations, Zod contracts, Koa adapters, Knex services, and OpenAPI generation.
---

# Cricket API Skill

Use this when changing a Cricket API app.

## Orientation

Start with \`pnpm cricket inspect api/index.js\`, then read \`api/index.js\` and the domain files for the feature you are changing.

## App Folders

- \`api/middleware/\` is for HTTP edge concerns, not domain authorization.
- \`api/services/\` is for app-wide services not owned by one domain.
- \`api/workers/\` is for background worker entrypoints that call services.
- \`api/migrations/\` is app-owned. Configure Knex there from the app, not Cricket.
- \`api/dev/\` is for local-only development support. If code touches product behavior, move that behavior into a real service, worker, migration, or domain.

## Change Flow

1. Update the schema at the boundary that changed.
2. Keep data work in services.
3. Put auth, existence, and ownership checks in rules.
4. Keep endpoint handlers focused on composition.
5. Generate OpenAPI and check the contract diff.
6. Add or update the domain-local \`*.test.js\` and test through HTTP for endpoint behavior.

## Commands

\`\`\`sh
pnpm cricket init app .
pnpm cricket inspect api/index.js
pnpm cricket docs api/index.js --out openapi.json
pnpm cricket new domain project api/domains
pnpm test
\`\`\`

After scaffolding a domain, make sure the app's \`domains\` value points at the domain root, add the table or migration, then regenerate OpenAPI.
`
};

/**
 * Scaffold project-local agent guidance for Cricket apps.
 *
 * @param {object} [options]
 * @param {string} [options.root='.'] - Project root.
 * @param {boolean} [options.force=false] - Overwrite existing files when true.
 * @returns {Promise<{root: string, created: string[], skipped: string[]}>}
 */
export async function scaffoldAgentFiles({
  root = '.',
  force = false
} = {}) {
  let created = [];
  let skipped = [];

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
    skipped
  };
}

/**
 * Format the agent scaffold summary for terminal output.
 *
 * @param {{root: string, created: string[], skipped: string[]}} result
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

  for (let filePath of result.skipped)
    lines.push(`  ! skipped existing ${filePath}`);

  lines.push(
    '',
    'Next',
    '  - AGENTS.md explains the Cricket domain split.',
    '  - .codex/skills/cricket-api/SKILL.md gives Codex a project-local workflow.',
    '  - Run `pnpm cricket inspect api/index.js` and `pnpm cricket docs api/index.js --out openapi.json`.'
  );

  return lines.join('\n');
}
