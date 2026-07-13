#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import {
  fileURLToPath,
  pathToFileURL
} from 'node:url';

import {
  createAppMap,
  createOpenApiFromContract,
  formatAppMap,
  loadAppContract,
  outputOpenApi
} from '../src/app-contract.js';
import {
  formatTrace,
  traceLogs
} from '../src/log-trace.js';
import {
  formatMigrationResult,
  runMigrationCommand
} from '../src/persistence/migrations.js';
import {
  runTestCommand
} from '../src/test/cli.js';
import {
  domainScaffoldFileTypes,
  formatAppScaffoldResult,
  formatAgentScaffoldResult,
  formatProjectScaffoldResult,
  formatScaffoldResult,
  scaffoldApp,
  scaffoldAgentFiles,
  scaffoldDomain,
  scaffoldProject
} from '../src/structure.js';

function hasFlag(args, flag) {
  return args.includes(flag);
}

let valueFlags = new Set([
  '--env',
  '--out',
  '--with'
]);

function withoutFlags(args) {
  let positional = [];

  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index];

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (valueFlags.has(arg))
      index += 1;
  }

  return positional;
}

function optionValue(args, name) {
  let index = args.indexOf(name);

  if (index === -1)
    return undefined;

  let value = args[index + 1];

  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value`);

  return value;
}

function usage() {
  return `Usage:
  cricket new domain <name> [root] --with <types|all> [--force]
  cricket init [root] [--force]
  cricket init app [root] [--force]
  cricket init agents [root] [--force]
  cricket inspect <appModule>
  cricket check <appModule>
  cricket docs <appModule> [--out openapi.json]
  cricket migrate latest <appModule> [--env name]
  cricket migrate rollback <appModule> [--all] [--env name]
  cricket migrate status <appModule> [--env name]
  cricket migrate list <appModule> [--env name]
  cricket migrate current-version <appModule> [--env name]
  cricket migrate make <appModule> <name> [--env name]
  cricket test [targets...] [--grep text] [--reporter cricket|spec|dot|tap] [--json] [--output report.json] [--coverage]
  cricket trace <requestId>

Domain types:
  ${domainScaffoldFileTypes.join(', ')}
  serializers requires model in the selection or existing domain

Examples:
  cricket init .
  cricket new domain project api/domains --with model,validations,serializers,service,rules,routes,test
  cricket check api/index.js
  cricket inspect api/index.js
  cricket docs api/index.js --out openapi.json
  cricket migrate latest api/index.js
  cricket test
  cricket test test/http-runtime.test.js --grep "deprecated"`;
}

/**
 * Run the `cricket new domain` command and print the scaffold summary.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after the scaffold completes and output is written.
 */
async function runNewDomain(args) {
  let positional = withoutFlags(args);
  let [, , name, root = '.'] = positional;

  if (!name)
    throw new Error('Domain name is required');

  let result = await scaffoldDomain({
    root,
    name,
    types: optionValue(args, '--with')?.split(',').map(type => type.trim()).filter(Boolean),
    force: hasFlag(args, '--force')
  });

  console.log(formatScaffoldResult(result));
}

/**
 * Run the `cricket init app` command and print the scaffold summary.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after the app shell is written.
 */
async function runInitApp(args) {
  let positional = withoutFlags(args);
  let [, , root = '.'] = positional;

  let result = await scaffoldApp({
    root,
    force: hasFlag(args, '--force')
  });

  console.log(formatAppScaffoldResult(result));
}

/**
 * Run the `cricket init agents` command and print the scaffold summary.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after guidance files are written.
 */
async function runInitAgents(args) {
  let positional = withoutFlags(args);
  let [, , root = '.'] = positional;

  let result = await scaffoldAgentFiles({
    root,
    force: hasFlag(args, '--force')
  });

  console.log(formatAgentScaffoldResult(result));
}

/**
 * Run the canonical Cricket project initialization command.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after app and agent scaffolds are written.
 */
async function runInit(args) {
  let [, root = '.'] = withoutFlags(args);
  let result = await scaffoldProject({
    root,
    force: hasFlag(args, '--force')
  });

  console.log(formatProjectScaffoldResult(result));
}

/**
 * Run the `cricket inspect` command and print a compact app map.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after the app module is inspected.
 */
async function runInspect(args) {
  let [, modulePath] = args;

  if (!modulePath)
    throw new Error('App module is required');

  let contract = await loadAppContract(modulePath);

  console.log(formatAppMap(createAppMap(contract)));
}

/**
 * Validate and print the architecture posture of a Cricket app.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves when the app contract is valid.
 */
async function runCheck(args) {
  let [, modulePath] = args;

  if (!modulePath)
    throw new Error('App module is required');

  let contract = await loadAppContract(modulePath);

  if (contract.architecture === 'manual') {
    console.warn('Cricket architecture is valid with a warning: manual mode is migration tech debt. Move product contracts into domains and remove the escape hatch.');
    return;
  }

  console.log(`Cricket architecture check passed: ${contract.domains.length} domain${contract.domains.length === 1 ? '' : 's'} loaded.`);
}

/**
 * Run the `cricket docs` command and print or write OpenAPI JSON.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after OpenAPI output is produced.
 */
async function runDocs(args) {
  let [, modulePath] = withoutFlags(args);

  if (!modulePath)
    throw new Error('App module is required');

  let contract = await loadAppContract(modulePath);
  let document = createOpenApiFromContract(contract);
  let output = await outputOpenApi(document, {
    out: optionValue(args, '--out')
  });

  console.log(output);
}

async function readStdin() {
  let chunks = [];

  for await (let chunk of process.stdin)
    chunks.push(chunk);

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run the `cricket trace` command and reconstruct one request from JSON logs.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after trace output is written.
 */
async function runTrace(args) {
  let [, requestId] = args;

  if (!requestId)
    throw new Error('Request id is required');

  let input = await readStdin();
  let logs = traceLogs(input, requestId);

  console.log(formatTrace(logs, requestId));
}

/**
 * Run a Knex migration command through the Cricket app database contract.
 *
 * @param {string[]} args - Raw CLI arguments after `cricket`.
 * @returns {Promise<void>} Resolves after the migration command is printed.
 */
async function runMigrate(args) {
  let positional = withoutFlags(args);
  let [, command, appModule, name] = positional;

  if (!command)
    throw new Error('Migrate command is required');

  if (!appModule)
    throw new Error('App module is required');

  let result = await runMigrationCommand({
    command,
    appModule,
    name,
    environment: optionValue(args, '--env'),
    all: hasFlag(args, '--all')
  });

  console.log(formatMigrationResult(result));
}

/**
 * Dispatch the Cricket CLI entrypoint from argv.
 *
 * @param {string[]} [argv=process.argv.slice(2)] - Arguments passed to the CLI.
 * @returns {Promise<void>} Resolves after the selected command runs.
 */
export async function runCli(argv = process.argv.slice(2)) {
  let [command, subcommand] = argv;

  if (command === 'new' && subcommand === 'domain')
    return await runNewDomain(argv);

  if (command === 'init' && subcommand === 'app')
    return await runInitApp(argv);

  if (command === 'init' && subcommand === 'agents')
    return await runInitAgents(argv);

  if (command === 'init')
    return await runInit(argv);

  if (command === 'inspect')
    return await runInspect(argv);

  if (command === 'check')
    return await runCheck(argv);

  if (command === 'docs')
    return await runDocs(argv);

  if (command === 'migrate')
    return await runMigrate(argv);

  if (command === 'test')
    return await runTestCommand(argv.slice(1));

  if (command === 'trace')
    return await runTrace(argv);

  console.log(usage());
  process.exitCode = command ? 1 : 0;
}

function isDirectRun() {
  if (!process.argv[1])
    return false;

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectRun()) {
  try {
    await runCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
