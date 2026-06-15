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
  formatAppScaffoldResult,
  formatAgentScaffoldResult,
  formatScaffoldResult,
  scaffoldApp,
  scaffoldAgentFiles,
  scaffoldDomain
} from '../src/structure.js';

function hasFlag(args, flag) {
  return args.includes(flag);
}

function withoutFlags(args) {
  return args.filter(arg => !arg.startsWith('--'));
}

function optionValue(args, name) {
  let index = args.indexOf(name);

  if (index === -1)
    return undefined;

  return args[index + 1];
}

function usage() {
  return `Usage:
  cricket new domain <name> [root] [--force]
  cricket init app [root] [--force]
  cricket init agents [root] [--force]
  cricket inspect <appModule>
  cricket docs <appModule> [--out openapi.json]

Examples:
  cricket init app .
  cricket new domain project api/domains
  cricket init agents .
  cricket inspect api/index.js
  cricket docs api/index.js --out openapi.json`;
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

  if (command === 'inspect')
    return await runInspect(argv);

  if (command === 'docs')
    return await runDocs(argv);

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
