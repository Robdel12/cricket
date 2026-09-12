import {
  defineCricketApp, defineEndpoint, defineRule, ok, unauthenticated, withHeaders, z
} from '../src/index.js';

let requireUser = defineRule('report.requireUser', ({ user }) => {
  if (!user) throw unauthenticated('Sign in to read reports');
});

let showReport = defineEndpoint({
  method: 'get',
  path: '/reports/:id',
  summary: 'Read a report',
  security: [{ bearer: [] }],
  params: z.object({ id: z.string() }),
  headers: z.object({ 'x-client-version': z.string().optional() }),
  rules: [requireUser],
  responses: {
    200: {
      schema: z.object({ id: z.string(), title: z.string() }),
      headers: { 'Cache-Control': { schema: z.string(), example: 'private, no-store' } },
      example: { id: 'report-1', title: 'Race results' }
    },
    401: {
      description: 'A user credential is required',
      schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
    }
  },
  handler: ({ input }) => withHeaders(ok({ id: input.params.id, title: 'Race results' }), {
    'Cache-Control': 'private, no-store'
  })
});

// A real application resolves user credentials in its middleware/context.
// Security declarations describe the contract; the rule above enforces access.
export let app = defineCricketApp({
  name: 'Public contract example',
  version: '1.0.0',
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  domains: [{ name: 'report', endpoints: [showReport] }]
});
