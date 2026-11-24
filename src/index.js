/**
 * @guide overview Cricket
 *
 * Cricket is a small Node framework for building APIs. Give each route a contract for what goes in and what comes out. Put data work in services, and group the files that change together in a domain.
 *
 * When you're ready to split your app into files, see [Organize your app](guide.md#organize-your-app).
 */
export {
  defineCricketApp,
  resolveCricketApp
} from './app.js';

/**
 * @guide api JavaScript API
 *
 * Pick the import path you want to use. Each page lists the exports for that path, with their signatures and links to the source for this version.
 *
 * For examples you can build on, start with [Using Cricket](guide.md#your-first-route). To describe your own HTTP API, see [Generate OpenAPI](guide.md#generate-openapi).
 */
export {
  defineCricketPlugin,
  definePluginSchema
} from './plugin.js';

export {
  badRequest,
  cricketError,
  forbidden,
  normalizerContractFailed,
  notFound,
  responseContractFailed,
  serializerContractFailed,
  tooManyRequests,
  toHttpError,
  unauthenticated,
  validationFailed
} from './errors.js';

/** Build Zod schemas for Cricket contracts. */
export {
  z
} from 'zod';

/** Create a native XState chart to pass to `defineMachine`. */
export { createMachine } from 'xstate';
/** Describe supported chart versions and how to migrate saved checkpoints. */
export { machineVersions } from 'xstate';
export { defineMachine } from './machine.js';

export {
  defineEndpoint,
  deprecateEndpoint
} from './endpoint.js';

export {
  defineApiVersions
} from './api-version.js';

export {
  created,
  ok,
  redirect,
  respond,
  withCookies,
  withResponseBody,
  withError,
  withHeaders,
  withResponseHeaders,
  withResponseCleanup
} from './response.js';

export {
  defineModel
} from './model.js';

export {
  field,
  fieldSensitive
} from './field.js';

export {
  collectEndpoints,
  collectModels,
  createServices,
  domainFileTypes,
  loadDomains
} from './domain.js';

export {
  createKnexRepository
} from './persistence/knex.js';

export {
  createCricketRuntime,
  startCricketApp
} from './http/runtime.js';

export {
  generateOpenApi
} from './openapi.js';

export {
  createCricketLogger,
  normalizeLogger,
  resolveLogger
} from './logger.js';

export {
  defineNormalizer
} from './normalizer.js';

export {
  defineSerializer,
  camelCaseKeys,
  composeSerializers,
  mapKeys,
  pickFields,
  renameFields
} from './serializer.js';

export {
  applyRules,
  defineRule
} from './rule.js';

export {
  concurrency,
  cronSchedule,
  createCricketJobs,
  createJobLedgerTable,
  createLocalQueueDriver,
  defineJob,
  jobFailure,
  localQueue,
  planCronSchedule,
  redisQueue,
  retry,
  startCricketWorker,
  state
} from './jobs/index.js';
