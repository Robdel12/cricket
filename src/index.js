/**
 * @guide overview Cricket
 *
 * Cricket is a Node API framework where the code is the documentation. Every route says what it takes and what it returns, Cricket checks both, and your app's folders tell you where everything lives.
 *
 * It ships its own HTTP runtime, plus logging, tracing, jobs, state machines, migrations, and a test harness. There's no ORM, no classes to extend, and no magic wiring.
 *
 * ## What you get
 *
 * - **Self-documenting.** Contracts aren't comments. Cricket checks them on every request and turns them into OpenAPI, `cricket inspect` output, and agent guidance, so the docs can't drift from the code.
 * - **Domain-first.** Each feature lives in one folder, and each file in it has one job. You'll know where code lives before you open anything.
 * - **Functional and immutable.** Plain functions, plain objects, and definitions that are frozen once they're built. Compose them however you like.
 * - **Built for agents.** Predictable files and explicit dependencies make Cricket apps safe to change, whether the next commit comes from you or a coding agent. `cricket init` writes the guidance for them.
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
