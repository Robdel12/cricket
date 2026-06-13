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
  'routes'
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

let templates = {
  model: modelTemplate,
  serializers: serializersTemplate,
  service: serviceTemplate,
  rules: rulesTemplate,
  routes: routesTemplate
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

let agentFiles = {
  'AGENTS.md': `# Cricket App Guidance

## Domain Shape

- \`*.model.js\` owns row and input schemas.
- \`*.serializers.js\` owns response projections.
- \`*.service.js\` owns data operations.
- \`*.rules.js\` owns auth, existence, ownership, and business guards.
- \`*.routes.js\` owns endpoint contracts.

The folder is the domain. Keep services boring, rules named, and routes thin.
Test endpoint behavior through HTTP.
`,
  '.codex/skills/cricket-api/SKILL.md': `---
name: cricket-api
description: Work in a Cricket Node API app with predictable domain files, Zod contracts, Koa adapters, Knex services, and OpenAPI generation.
---

# Cricket API Skill

Use this when changing a Cricket API app.

## Orientation

Start with \`pnpm cricket inspect src/app.js\`, then read \`src/app.js\` and the domain files for the feature you are changing.

## Change Flow

1. Update the schema at the boundary that changed.
2. Keep data work in services.
3. Put auth, existence, and ownership checks in rules.
4. Keep endpoint handlers focused on composition.
5. Generate OpenAPI and check the contract diff.
6. Test through HTTP for endpoint behavior.

## Commands

\`\`\`sh
pnpm cricket inspect src/app.js
pnpm cricket docs src/app.js --out openapi.json
pnpm cricket new domain project src/api
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
    '  - Run `pnpm cricket inspect src/app.js` and `pnpm cricket docs src/app.js --out openapi.json`.'
  );

  return lines.join('\n');
}
