import Koa from 'koa';
import Router from '@koa/router';
import koaBodyParser from 'koa-bodyparser';

import {
  isMainModule,
  resolveCricketApp
} from '../app.js';
import {
  createServices
} from '../domain.js';
import { toHttpError } from '../errors.js';
import { normalizeLogger } from '../logger.js';
import { generateOpenApi } from '../openapi.js';

function defaultContext(ctx) {
  let user = ctx.state.user;

  if (!user && ctx.state.user_id)
    user = { id: ctx.state.user_id };

  let userId = user?.id ?? user?.userId ?? ctx.state.user_id;

  return {
    ctx,
    state: {},
    user,
    userId
  };
}

function parseCookieHeader(header) {
  if (!header)
    return {};

  return Object.fromEntries(
    String(header)
      .split(';')
      .map(cookie => cookie.trim())
      .filter(Boolean)
      .map(cookie => {
        let separatorIndex = cookie.indexOf('=');
        let name = separatorIndex === -1 ? cookie : cookie.slice(0, separatorIndex);
        let value = separatorIndex === -1 ? '' : cookie.slice(separatorIndex + 1);

        return [
          decodeURIComponent(name),
          decodeURIComponent(value)
        ];
      })
  );
}

function toCricketRequest(ctx) {
  return {
    body: ctx.request.body,
    cookies: parseCookieHeader(ctx.headers.cookie),
    file: ctx.file,
    files: ctx.files,
    headers: ctx.headers,
    host: ctx.host,
    method: ctx.method,
    origin: `${ctx.protocol}://${ctx.host}`,
    params: ctx.params,
    path: ctx.path,
    protocol: ctx.protocol,
    query: ctx.request.query,
    rawBody: ctx.request.rawBody
  };
}

function readRawRequestBody(ctx, {
  encoding = 'utf8'
} = {}) {
  return new Promise((resolve, reject) => {
    let chunks = [];

    ctx.req.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ctx.req.on('end', () => {
      let body = Buffer.concat(chunks);
      resolve(encoding === false ? body : body.toString(encoding));
    });

    ctx.req.on('error', reject);
  });
}

function methodFor(endpoint) {
  return endpoint.method.toLowerCase();
}

function applyResponseCookies(ctx, cookies = []) {
  for (let cookie of cookies) {
    ctx.cookies.set(cookie.name, cookie.value, cookie.options);
  }
}

function applyResponseCleanup(ctx, response) {
  if (typeof response.onClose !== 'function')
    return;

  let closed = false;
  let close = () => {
    if (closed)
      return;

    closed = true;
    void response.onClose();
  };

  ctx.req.on('close', close);
  ctx.req.on('error', close);
  response.body?.on?.('close', close);
  response.body?.on?.('error', close);
}

async function resolveContext(ctx, context) {
  let baseContext = defaultContext(ctx);

  if (!context)
    return baseContext;

  return {
    ...baseContext,
    ...(await context(ctx) ?? {})
  };
}

async function respondWithError(ctx, error, onError) {
  let response = toHttpError(error);

  ctx.status = response.status;
  ctx.body = response.body;

  if (response.status >= 500)
    ctx.app.emit('error', error, ctx);

  if (onError)
    await onError(error, ctx);
}

/**
 * Wraps a Cricket endpoint in a Koa middleware function.
 *
 * @param {object} endpoint - Cricket endpoint contract with `handle()`, `method`, and `path`.
 * @param {object} [options]
 * @param {Function} [options.context] - Optional async context factory that can extend the default Cricket context.
 * @param {Function} [options.onError] - Optional error hook called after an endpoint failure is converted to an HTTP response.
 * @returns {Function} Koa middleware that translates the Koa request/response shape into Cricket's request contract.
 */
export function createKoaHandler(endpoint, {
  context,
  onError
} = {}) {
  return async ctx => {
    try {
      let response = await endpoint.handle(
        toCricketRequest(ctx),
        await resolveContext(ctx, context)
      );

      ctx.status = response.status;

      if (response.cookies)
        applyResponseCookies(ctx, response.cookies);

      if (response.headers) {
        for (let [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            ctx.set(name, value);
        }
      }

      if (response.redirect) {
        ctx.redirect(response.redirect);
        ctx.status = response.status;
      }

      applyResponseCleanup(ctx, response);

      if (response.body !== undefined)
        ctx.body = response.body;
    } catch (error) {
      await respondWithError(ctx, error, onError);
    }
  };
}

/**
 * Adapt an existing Koa-shaped service into a Cricket endpoint handler.
 *
 * This is intentionally a bridge, not a new service abstraction. It lets apps
 * move route contracts into Cricket before rewriting older services to return
 * plain Cricket responses directly.
 *
 * @param {(ctx: any) => any|Promise<any>} service
 * @returns {(context: {ctx: any}) => Promise<{status: number, body: any}>}
 */
export function fromKoaService(service) {
  return async ({ ctx }) => {
    await service(ctx);

    return {
      status: ctx.status || 200,
      body: ctx.body
    };
  };
}

/**
 * Read a request body before any JSON/body parser runs, then delegate onward.
 *
 * Use this for signed webhooks where the signature must be verified against the
 * exact raw payload, such as Stripe, GitHub, or Slack webhooks.
 *
 * @param {object} [options]
 * @param {string|false} [options.encoding='utf8'] - Pass false to keep a Buffer.
 * @returns {Function} Koa middleware.
 */
export function createKoaRawBodyMiddleware({
  encoding = 'utf8'
} = {}) {
  return async (ctx, next) => {
    ctx.request.rawBody = await readRawRequestBody(ctx, {
      encoding
    });

    await next();
  };
}

/**
 * Builds a Koa router from Cricket endpoints while keeping HTTP/framework wiring at the edge.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.endpoints=[]] - Endpoint contracts with `method`, `path`, and `handle()`.
 * @param {string} [options.prefix] - Optional router prefix applied to every route.
 * @param {Function} [options.context] - Optional async context factory shared by all handlers.
 * @param {Function} [options.onError] - Optional error hook shared by all handlers.
 * @returns {Router} Configured Koa router with one route per Cricket endpoint.
 */
export function createKoaRouter({
  endpoints = [],
  prefix,
  context,
  onError
} = {}) {
  let router = new Router({
    ...(prefix ? { prefix } : {})
  });

  for (let endpoint of endpoints) {
    let method = methodFor(endpoint);

    if (typeof router[method] !== 'function')
      throw new Error(`Unsupported Koa route method: ${endpoint.method}`);

    router[method](
      endpoint.path,
      ...(endpoint.rawBody ? [createKoaRawBodyMiddleware(
        endpoint.rawBody === true ? undefined : endpoint.rawBody
      )] : []),
      ...(endpoint.middleware ?? []),
      createKoaHandler(endpoint, {
        context,
        onError
      })
    );
  }

  return router;
}

function installBodyParser(app, bodyParser) {
  if (bodyParser === false)
    return;

  app.use(koaBodyParser(
    bodyParser === true ? undefined : bodyParser
  ));
}

function installMiddleware(app, middleware = []) {
  for (let item of middleware)
    app.use(item);
}

function splitRawBodyEndpoints(endpoints) {
  return {
    rawBodyEndpoints: endpoints.filter(endpoint => endpoint.rawBody),
    parsedEndpoints: endpoints.filter(endpoint => !endpoint.rawBody)
  };
}

/**
 * Exposes a prebuilt OpenAPI document, or generates one from Cricket endpoint/model contracts.
 *
 * @param {object} [options]
 * @param {object} [options.document] - Static OpenAPI document to serve when callers want to bypass generation.
 * @param {Array<object>} [options.endpoints=[]] - Endpoint contracts used for OpenAPI generation.
 * @param {Array<object>} [options.models=[]] - Model contracts used to populate component schemas.
 * @param {string} [options.title] - OpenAPI info title used when generating a document.
 * @param {string} [options.version] - OpenAPI info version used when generating a document.
 * @param {string} [options.description] - Optional OpenAPI info description.
 * @param {Array<object>} [options.servers] - Optional OpenAPI servers list.
 * @param {string} [options.pathPrefix] - Optional prefix applied to generated paths.
 * @returns {Function} Koa middleware that writes the OpenAPI JSON document to `ctx.body`.
 */
export function createKoaOpenApiHandler({
  document,
  endpoints = [],
  models = [],
  title,
  version,
  description,
  servers,
  pathPrefix
} = {}) {
  return async ctx => {
    ctx.body = document ?? generateOpenApi({
      title,
      version,
      description,
      servers,
      pathPrefix,
      endpoints,
      models
    });
  };
}

/**
 * Mount an OpenAPI JSON route as Koa middleware.
 *
 * @param {object} [options]
 * @param {string} [options.path='/openapi.json'] - Route path for the document.
 * @returns {Function} Koa middleware that serves the document and falls through otherwise.
 */
export function createKoaOpenApiRoute({
  path = '/openapi.json',
  ...options
} = {}) {
  let handler = createKoaOpenApiHandler(options);

  return async (ctx, next) => {
    if (ctx.path === path)
      return await handler(ctx);

    return await next();
  };
}

function normalizeOpenApiOptions(openApi, {
  endpoints,
  prefix
}) {
  if (!openApi)
    return undefined;

  return {
    endpoints,
    pathPrefix: prefix,
    ...(openApi === true ? {} : openApi)
  };
}

/**
 * Creates the full Koa app wiring for Cricket: body parsing, route registration, and error handling.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.endpoints=[]] - Cricket endpoint contracts to mount.
 * @param {string} [options.prefix] - Optional router prefix.
 * @param {Function} [options.context] - Optional async context factory shared by endpoint handlers.
 * @param {Function} [options.onError] - Optional error hook shared by endpoint handlers.
 * @param {boolean|object} [options.bodyParser=true] - `true` enables the default body parser, `false` disables it, and an object passes custom parser options through.
 * @param {boolean|object} [options.openApi] - Optional OpenAPI route config. Pass an object to set `path`, `title`, `version`, `models`, and other document options.
 * @param {Koa} [options.app=new Koa()] - Existing Koa app instance to extend.
 * @returns {Koa} The configured Koa app instance.
 */
export function createKoaApp({
  endpoints = [],
  prefix,
  context,
  onError,
  bodyParser = true,
  openApi,
  middleware = [],
  afterRoutes = [],
  app = new Koa()
} = {}) {
  let {
    rawBodyEndpoints,
    parsedEndpoints
  } = splitRawBodyEndpoints(endpoints);
  let rawBodyRouter = createKoaRouter({
    endpoints: rawBodyEndpoints,
    prefix,
    context,
    onError
  });
  let router = createKoaRouter({
    endpoints: parsedEndpoints,
    prefix,
    context,
    onError
  });

  installMiddleware(app, middleware);
  app.use(rawBodyRouter.routes());
  app.use(rawBodyRouter.allowedMethods());
  installBodyParser(app, bodyParser);

  let openApiOptions = normalizeOpenApiOptions(openApi, {
    endpoints,
    prefix
  });

  if (openApiOptions)
    app.use(createKoaOpenApiRoute(openApiOptions));

  app.use(router.routes());
  app.use(router.allowedMethods());
  installMiddleware(app, afterRoutes);

  return app;
}

function normalizeSetupResult(result) {
  if (!result)
    return {
      dependencies: {},
      services: {},
      cleanup: undefined
    };

  if (result.dependencies || result.services || result.cleanup)
    return {
      dependencies: result.dependencies ?? {},
      services: result.services ?? {},
      cleanup: result.cleanup
    };

  return {
    dependencies: result,
    services: {},
    cleanup: undefined
  };
}

function openApiOptionsFor(cricketApp) {
  if (cricketApp.openApi === false)
    return false;

  let options = {
    title: cricketApp.name,
    version: cricketApp.version,
    description: cricketApp.description,
    models: cricketApp.models,
    path: '/openapi.json'
  };

  if (cricketApp.openApi === true)
    return options;

  return {
    ...options,
    ...cricketApp.openApi
  };
}

/**
 * Build the Koa runtime for a Cricket app contract.
 *
 * @param {object} cricketApp - App contract returned by `defineCricketApp`.
 * @returns {Promise<{app: Koa, dependencies: object, services: object, cleanup: Function|undefined}>}
 */
export async function createCricketKoaRuntime(cricketApp, {
  baseUrl,
  logger: runtimeLogger
} = {}) {
  let appContract = await resolveCricketApp(cricketApp, {
    baseUrl
  });
  let logger = normalizeLogger(runtimeLogger ?? appContract.logger ?? console);
  let setup = normalizeSetupResult(
    appContract.setup ? await appContract.setup({
      app: appContract,
      logger
    }) : undefined
  );
  let domainServices = createServices(appContract.domains, {
    ...setup.dependencies,
    logger
  });
  let defaultServices = {
    ...domainServices,
    ...setup.services
  };
  let services = defaultServices;

  if (typeof appContract.services === 'function') {
    services = await appContract.services({
      app: appContract,
      dependencies: setup.dependencies,
      domainServices,
      logger,
      services: defaultServices
    });
  } else if (appContract.services) {
    services = appContract.services;
  }
  let baseContext = {
    ...setup.dependencies,
    logger
  };
  let runtimeContext = extra => ({
    ...baseContext,
    services,
    ...extra
  });

  let app = createKoaApp({
    app: appContract.koaApp,
    endpoints: appContract.endpoints,
    prefix: appContract.prefix,
    middleware: appContract.middleware,
    afterRoutes: appContract.afterRoutes,
    bodyParser: appContract.bodyParser,
    onError: async (error, ctx) => {
      logger.error('request.failed', {
        error,
        method: ctx.method,
        path: ctx.path
      });

      if (appContract.onError)
        await appContract.onError(error, ctx);
    },
    openApi: openApiOptionsFor(appContract),
    async context(ctx) {
      if (!appContract.context)
        return runtimeContext();

      return runtimeContext(await appContract.context({
        app: appContract,
        ctx,
        dependencies: setup.dependencies,
        logger,
        services
      }));
    }
  });

  return {
    app,
    contract: appContract,
    dependencies: setup.dependencies,
    logger,
    services,
    cleanup: setup.cleanup
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error)
        reject(error);
      else
        resolve();
    });
  });
}

/**
 * Start a Cricket app as the current Node process entrypoint.
 *
 * Pass `main: import.meta.url` from your app entrypoint to make the same module
 * safe for both `node api/index.js` and `cricket inspect api/index.js`.
 *
 * @param {object} cricketApp - App contract returned by `defineCricketApp`.
 * @param {object} [options]
 * @returns {Promise<object|undefined>} Runtime controls when started.
 */
export async function startCricketApp(cricketApp, {
  port = 3000,
  host,
  main,
  logger
} = {}) {
  if (main && !isMainModule(main))
    return undefined;

  let runtime = await createCricketKoaRuntime(cricketApp, {
    baseUrl: main,
    logger
  });
  let server = runtime.app.listen(port, host, () => {
    runtime.logger.info('server.started', {
      app: runtime.contract.name ?? 'Cricket app',
      port,
      url: `http://localhost:${port}`
    });
  });

  async function stop(signal) {
    if (signal && runtime.contract.onShutdown)
      await runtime.contract.onShutdown({
        signal,
        ...runtime
      });

    await closeServer(server);

    if (runtime.cleanup)
      await runtime.cleanup();
  }

  let shutdown = async signal => {
    await stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  return {
    ...runtime,
    server,
    stop
  };
}
