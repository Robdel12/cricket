import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectEndpoints,
  collectModels
} from './domain.js';
import { resolveCricketApp } from './app.js';
import { generateOpenApi } from './openapi.js';
import { isZodSchema } from './schema.js';

function toArray(value) {
  if (!value)
    return [];

  return Array.isArray(value) ? value : [value];
}

function serviceKeysFor(domain) {
  if (domain.services)
    return Object.keys(domain.services);

  if (domain.service && domain.name)
    return [domain.name];

  return [];
}

function functionKeysFor(module) {
  return Object.entries(module ?? {})
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name);
}

function schemaKeysFor(module) {
  return Object.entries(module ?? {})
    .filter(([, value]) => isZodSchema(value))
    .map(([name]) => name);
}

function modelSummaryFor(model) {
  return {
    name: model.name,
    publicFields: model.publicFields ?? [],
    privateFields: model.privateFields ?? [],
    views: model.viewNames ?? []
  };
}

function domainNameFor(domain, index) {
  if (domain.name)
    return domain.name;

  let model = toArray(domain.models ?? domain.model)[0];

  if (model?.name)
    return model.name.charAt(0).toLowerCase() + model.name.slice(1);

  return `domain${index + 1}`;
}

function operationLine(endpoint) {
  return `${endpoint.method.padEnd(6)} ${endpoint.path}`;
}

function withPathPrefix(pathValue, prefix) {
  if (!prefix)
    return pathValue;

  return `${prefix.replace(/\/$/, '')}/${pathValue.replace(/^\//, '')}`;
}

async function appContractFromModule(module, {
  baseUrl
} = {}) {
  let app = module.app ?? module.default;

  if (!app)
    throw new Error('App module must export app = defineCricketApp(...)');

  let resolvedApp = await resolveCricketApp(app, {
    baseUrl
  });

  return {
    name: resolvedApp.name,
    version: resolvedApp.version,
    description: resolvedApp.description,
    prefix: resolvedApp.prefix,
    domains: resolvedApp.domains ?? [],
    endpoints: resolvedApp.endpoints ?? [],
    models: resolvedApp.models ?? []
  };
}

/**
 * Load a Cricket app module from a CLI-supplied file path.
 *
 * @param {string} modulePath - App module path to import.
 * @returns {Promise<object>} Normalized app contract with domains, endpoints, and models.
 */
export async function loadAppContract(modulePath) {
  let resolvedPath = path.resolve(modulePath);
  let module = await import(pathToFileURL(resolvedPath).href);

  return await appContractFromModule(module, {
    baseUrl: pathToFileURL(resolvedPath).href
  });
}

/**
 * Build a compact map of domains, models, services, and routes.
 *
 * @param {object} contract - Normalized app contract.
 * @returns {object} Plain app map for text output or future JSON output.
 */
export function createAppMap(contract) {
  return {
    name: contract.name,
    domains: contract.domains.map((domain, index) => ({
      name: domainNameFor(domain, index),
      models: toArray(domain.models ?? domain.model).map(modelSummaryFor),
      validations: schemaKeysFor(domain.validations),
      normalizers: functionKeysFor(domain.normalizers),
      serializers: functionKeysFor(domain.serializers),
      endpoints: toArray(domain.endpoints ?? domain.endpoint).length,
      services: serviceKeysFor(domain)
    })),
    models: contract.models.map(model => ({
      name: model.name,
      table: model.table
    })),
    routes: contract.endpoints.map(endpoint => ({
      method: endpoint.method,
      path: withPathPrefix(endpoint.path, contract.prefix),
      summary: endpoint.summary,
      tags: endpoint.tags
    }))
  };
}

/**
 * Format a Cricket app map for humans and agents in the terminal.
 *
 * @param {object} appMap - Map returned by {@link createAppMap}.
 * @returns {string} Human-readable summary.
 */
export function formatAppMap(appMap) {
  let lines = [
    appMap.name ? `Cricket app: ${appMap.name}` : 'Cricket app'
  ];

  lines.push('', 'Domains');
  for (let domain of appMap.domains) {
    lines.push(`  ${domain.name}`);
    lines.push(`    models: ${domain.models.map(model => model.name).join(', ') || 'none'}`);
    for (let model of domain.models) {
      lines.push(`      ${model.name} public: ${model.publicFields.join(', ') || 'none'}`);
      lines.push(`      ${model.name} private: ${model.privateFields.join(', ') || 'none'}`);
      lines.push(`      ${model.name} views: ${model.views.join(', ') || 'none'}`);
    }
    lines.push(`    validations: ${domain.validations.join(', ') || 'none'}`);
    lines.push(`    normalizers: ${domain.normalizers.join(', ') || 'none'}`);
    lines.push(`    serializers: ${domain.serializers.join(', ') || 'none'}`);
    lines.push(`    endpoints: ${domain.endpoints}`);
    lines.push(`    services: ${domain.services.join(', ') || 'none'}`);
  }

  lines.push('', 'Routes');
  for (let route of appMap.routes)
    lines.push(`  ${operationLine(route)}`);

  lines.push('', 'Models');
  for (let model of appMap.models)
    lines.push(`  ${model.name} -> ${model.table}`);

  return lines.join('\n');
}

/**
 * Generate the OpenAPI document for an app contract.
 *
 * @param {object} contract - Normalized app contract.
 * @param {object} [options]
 * @returns {object} OpenAPI document.
 */
export function createOpenApiFromContract(contract, options = {}) {
  return generateOpenApi({
    title: contract.name,
    version: contract.version,
    description: contract.description,
    pathPrefix: contract.prefix,
    ...options,
    endpoints: contract.endpoints,
    models: contract.models
  });
}

/**
 * Write a generated OpenAPI document or return the JSON string for stdout.
 *
 * @param {object} document - OpenAPI document.
 * @param {object} [options]
 * @param {string} [options.out] - Destination file.
 * @returns {Promise<string>} Terminal message or JSON output.
 */
export async function outputOpenApi(document, {
  out
} = {}) {
  let json = `${JSON.stringify(document, null, 2)}\n`;

  if (!out)
    return json;

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, json);

  return `Wrote OpenAPI to ${out}`;
}
