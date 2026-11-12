import {
  defineCricketApp,
  defineEndpoint,
  respond,
  withError,
  z
} from '../src/index.js';

export let app = defineCricketApp({
  name: 'Error reporting example',
  domains: [{
    name: 'provider',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/provider',
      operationId: 'provider.read',
      responses: { 503: z.object({ error: z.string() }) },
      handler() {
        let error = new Error('Example provider is offline');
        return withError(respond(503, { error: 'Try again later' }), error);
      }
    })]
  }],
  onError(error, { request, response, route, handled }) {
    // Replace this callback with sentryErrorHandler(Sentry) for Sentry reporting.
    console.error('provider.failure', {
      name: error.name,
      requestId: request.id,
      operation: route?.operationId,
      status: response.status,
      handled
    });
  }
});
