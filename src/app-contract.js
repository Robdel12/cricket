import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { routeIdentityFor } from './route-identity.js';
import { resolveCricketApp } from './app.js';
import { generateOpenApi } from './openapi.js';
import { normalizeDatabaseConfig } from './persistence/database.js';
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

function ruleKeysFor(module) {
  return Object.entries(module ?? {})
    .filter(([, value]) => typeof value === 'function')
    .map(([name, value]) => value.ruleName ?? name);
}

function modelSummaryFor(model) {
  return {
    name: model.name,
    fields: Object.entries(model.fieldMetadata ?? {}).map(([fieldName, metadata]) => ({
      name: fieldName,
      visibility: metadata.visibility,
      sensitive: metadata.sensitive
    })),
    publicFields: model.publicFields ?? [],
    privateFields: model.privateFields ?? [],
    views: model.viewNames ?? []
  };
}

function ruleNamesFor(endpoint) {
  return toArray(endpoint.rules).map(rule =>
    rule.ruleName ?? rule.name ?? 'anonymous'
  );
}

function jobSummaryFor(job) {
  return {
    name: job.name,
    queue: job.queue?.name,
    state: job.state?.mode,
    retry: job.retry?.type ?? 'none',
    concurrency: toArray(job.concurrency).map(policy => policy.type),
    schedule: job.schedule?.key
  };
}

function jobCountFor(domain) {
  return toArray(domain.jobs ?? domain.job).filter(job => job?.kind === 'cricket.job').length;
}

function observabilitySummaryFor(contract) {
  let config = contract.observability;
  let hasObserver = typeof config === 'function' || toArray(config?.observe).length > 0;
  let hasRequestId = typeof config?.requestId === 'function';

  return {
    events: hasObserver ? 'enabled' : 'disabled',
    replay: hasObserver ? 'terminal events' : 'disabled',
    requestIds: hasRequestId ? 'custom' : 'default'
  };
}

function databaseSummaryFor(contract) {
  if (!contract.database)
    return {
      status: 'disabled'
    };

  let database = normalizeDatabaseConfig(contract.database);

  return {
    status: 'enabled',
    client: database.client,
    environment: database.environment
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

function routeLine(route) {
  return `${route.method.padEnd(6)} ${route.path}${route.deprecation ? ' DEPRECATED' : ''}`;
}

/**
 * Format the successor endpoint for human-readable inspect output.
 *
 * @param {string|{ method?: string, path?: string, operationId?: string }} replacement
 * @returns {string}
 */
function deprecationReplacementLine(replacement) {
  if (typeof replacement === 'string')
    return replacement;

  return [
    replacement.method,
    replacement.path,
    replacement.operationId
  ].filter(Boolean).join(' ');
}

function withPathPrefix(pathValue, prefix) {
  if (!prefix)
    return pathValue;

  return `${prefix.replace(/\/$/, '')}/${pathValue.replace(/^\//, '')}`;
}

function appContractFromResolvedApp(resolvedApp) {
  return {
    name: resolvedApp.name,
    version: resolvedApp.version,
    description: resolvedApp.description,
    prefix: resolvedApp.prefix,
    database: resolvedApp.database,
    observability: resolvedApp.observability,
    domains: resolvedApp.domains ?? [],
    endpoints: resolvedApp.endpoints ?? [],
    jobs: resolvedApp.jobs ?? [],
    models: resolvedApp.models ?? []
  };
}

/**
 * Load a side-effect-free Cricket app definition module.
 *
 * CLI commands use this when they need the full app contract, not just the
 * inspect/docs projection.
 *
 * @param {string} modulePath - App definition module path to import.
 * @returns {Promise<{app: object, modulePath: string, moduleUrl: string}>}
 */
export async function loadAppDefinition(modulePath) {
  let resolvedPath = path.resolve(modulePath);
  let moduleUrl = pathToFileURL(resolvedPath).href;
  let module = await import(moduleUrl);
  let app = module.app ?? module.default;

  if (!app)
    throw new Error('App module must export app = defineCricketApp(...)');

  return {
    app,
    modulePath: resolvedPath,
    moduleUrl
  };
}

/**
 * Load a Cricket app module from a CLI-supplied file path.
 *
 * @param {string} modulePath - App module path to import.
 * @returns {Promise<object>} Normalized app contract with domains, endpoints, and models.
 */
export async function loadAppContract(modulePath) {
  let definition = await loadAppDefinition(modulePath);
  let app = await resolveCricketApp(definition.app, {
    baseUrl: definition.moduleUrl
  });

  return appContractFromResolvedApp(app);
}

/**
 * Build a compact map of domains, models, services, and routes.
 *
 * @param {object} contract - Normalized app contract.
 * @returns {object} Plain app map for text output or future JSON output.
 */
export function createAppMap(contract) {
  let domains = toArray(contract.domains);
  let jobs = toArray(contract.jobs);
  let models = toArray(contract.models);
  let routes = toArray(contract.endpoints);

  return {
    name: contract.name,
    database: databaseSummaryFor(contract),
    observability: observabilitySummaryFor(contract),
    domains: domains.map((domain, index) => ({
      name: domainNameFor(domain, index),
      models: toArray(domain.models ?? domain.model).map(modelSummaryFor),
      validations: schemaKeysFor(domain.validations),
      normalizers: functionKeysFor(domain.normalizers),
      rules: ruleKeysFor(domain.rules),
      serializers: functionKeysFor(domain.serializers),
      endpoints: toArray(domain.endpoints ?? domain.endpoint).length,
      jobs: jobCountFor(domain),
      services: serviceKeysFor(domain)
    })),
    jobs: jobs.map(jobSummaryFor),
    models: models.map(model => ({
      name: model.name,
      table: model.table
    })),
    routes: routes.map(endpoint => ({
      ...routeIdentityFor(endpoint),
      path: withPathPrefix(endpoint.path, contract.prefix),
      deprecation: endpoint.deprecation,
      rules: ruleNamesFor(endpoint),
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

  lines.push(`Observability: request IDs ${appMap.observability.requestIds}, events ${appMap.observability.events}, replay ${appMap.observability.replay}`);
  lines.push(
    appMap.database.status === 'enabled'
      ? `Database: ${appMap.database.client ?? 'configured'}${appMap.database.environment ? ` (${appMap.database.environment})` : ''}`
      : 'Database: disabled'
  );

  lines.push('', 'Domains');
  for (let domain of appMap.domains) {
    lines.push(`  ${domain.name}`);
    lines.push(`    models: ${domain.models.map(model => model.name).join(', ') || 'none'}`);
    for (let model of domain.models) {
      lines.push(`      ${model.name} fields: ${model.fields.map(field =>
        `${field.name} ${field.visibility}/${field.sensitive ? 'sensitive' : 'safe'}`
      ).join(', ') || 'none'}`);
      lines.push(`      ${model.name} public: ${model.publicFields.join(', ') || 'none'}`);
      lines.push(`      ${model.name} private: ${model.privateFields.join(', ') || 'none'}`);
      lines.push(`      ${model.name} views: ${model.views.join(', ') || 'none'}`);
    }
    lines.push(`    validations: ${domain.validations.join(', ') || 'none'}`);
    lines.push(`    normalizers: ${domain.normalizers.join(', ') || 'none'}`);
    lines.push(`    rules: ${domain.rules.join(', ') || 'none'}`);
    lines.push(`    serializers: ${domain.serializers.join(', ') || 'none'}`);
    lines.push(`    endpoints: ${domain.endpoints}`);
    lines.push(`    jobs: ${domain.jobs}`);
    lines.push(`    services: ${domain.services.join(', ') || 'none'}`);
  }

  lines.push('', 'Jobs');
  for (let job of appMap.jobs) {
    lines.push(`  ${job.name}`);
    lines.push(`    queue: ${job.queue ?? 'none'}`);
    lines.push(`    state: ${job.state ?? 'none'}`);
    lines.push(`    retry: ${job.retry}`);
    lines.push(`    concurrency: ${job.concurrency.join(', ') || 'none'}`);
    lines.push(`    schedule: ${job.schedule ?? 'none'}`);
  }

  lines.push('', 'Routes');
  for (let route of appMap.routes) {
    lines.push(`  ${routeLine(route)} (${route.operationId})`);
    if (route.deprecation?.sunset)
      lines.push(`    sunset: ${route.deprecation.sunset}`);
    if (route.deprecation?.replacement)
      lines.push(`    replacement: ${deprecationReplacementLine(route.deprecation.replacement)}`);
    if (route.deprecation?.reason)
      lines.push(`    reason: ${route.deprecation.reason}`);
    lines.push(`    rules: ${route.rules.join(', ') || 'none'}`);
  }

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
