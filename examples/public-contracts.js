import {
  defineCricketApp, defineEndpoint, defineRule, defineSerializer, ok, unauthenticated, withHeaders, z
} from '../src/index.js';

let requireUser = defineRule('report.requireUser', ({ user }) => {
  if (!user) throw unauthenticated('Sign in to read reports');
});

let showReport = defineEndpoint({
  method: 'get',
  path: '/reports/:id',
  summary: 'Read a report',
  auth: [{ bearer: [] }],
  params: z.object({ id: z.string() }),
  headers: z.object({ 'x-client-version': z.string().optional() }),
  rules: [requireUser],
  responses: {
    200: {
      schema: z.object({ id: z.string(), title: z.string(), internalNote: z.string() }),
      serializer: defineSerializer({
        name: 'report.public',
        output: z.object({ id: z.string(), title: z.string() }),
        serialize: ({ id, title }) => ({ id, title })
      }),
      headers: { 'Cache-Control': { schema: z.string(), example: 'private, no-store' } },
      example: { id: 'report-1', title: 'Race results' }
    },
    401: {
      description: 'A user credential is required',
      schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
    }
  },
  handler: ({ input }) => withHeaders(ok({ id: input.params.id, title: 'Race results', internalNote: 'For staff' }), {
    'Cache-Control': 'private, no-store'
  })
});

// Resolve user credentials in middleware or request context.
// The rule above checks access; auth metadata only documents it.
export let app = defineCricketApp({
  name: 'Public contract example',
  version: '1.0.0',
  authMethods: { bearer: { type: 'http', scheme: 'bearer' } },
  domains: [{ name: 'report', endpoints: [showReport] }]
});
