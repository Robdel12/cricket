/**
 * @guide overview Cricket
 *
 * Cricket is a small framework for building Node APIs. You give each route a contract for what comes in and what goes out, and Cricket checks both. Everything in between is plain JavaScript.
 *
 * There's no ORM, no classes to extend, and no magic wiring. Your app passes plain objects around, and you can read how it works from the files on disk.
 *
 * ## What you get
 *
 * - **Contracts at the edges.** Zod schemas check params, query, body, and responses. Bad input gets a clear 422 before your handler runs.
 * - **A predictable shape.** Each feature lives in a domain folder, and each file in it has one job. You'll know where code lives before you open anything.
 * - **Its own HTTP runtime.** No Express or Koa underneath. Cricket handles streaming, uploads, shutdown, and proxies for you.
 * - **The boring stuff, built in.** Logging, tracing, background jobs, state machines, migrations, OpenAPI, and a test harness all share the same app definition.
 * - **Agent-friendly by default.** `cricket init` writes guidance for coding agents, so they follow the same conventions you do.
 *
 * ## Where to start
 *
 * New here? You can [get a route running](guide.md#your-first-route) in a few minutes. Once you want more than one file, [organize your app](guide.md#organize-your-app) into domains. Curious why Cricket works this way? Read [the vision](../vision.md).
 */
export {
  defineCricketApp,
  resolveCricketApp
} from './app.js';

/**
 * @guide api JavaScript API
 *
 * Every export, grouped by import path. Each page shows the signature and links to the source for this version.
 *
 * New to Cricket? The [guides](guide.md#your-first-route) are a friendlier place to start.
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
