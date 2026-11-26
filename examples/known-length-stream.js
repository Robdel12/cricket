import { Readable } from 'node:stream';
import {
  defineCricketApp,
  defineEndpoint,
  ok,
  startCricketApp,
  withHeaders,
  withResponseCleanup,
  z
} from '@robdel12/cricket';

let content = Buffer.from('A file served through Cricket.\n');
export let app = defineCricketApp({
  name: 'Known-length stream example',
  domains: [{
    name: 'files',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/download',
      query: z.object({ format: z.enum(['text', 'binary']).default('binary') }),
      responses: {
        200: {
          schema: z.instanceof(Readable).meta({ jsonSchema: { type: 'string', format: 'binary' } }),
          contentTypes: ['text/plain', 'application/octet-stream']
        }
      },
      handler({ input }) {
        let stream = Readable.from([content]);
        return withResponseCleanup(withHeaders(ok(stream), {
          'Content-Type': input.query.format === 'text' ? 'text/plain' : 'application/octet-stream',
          'Content-Length': String(content.length),
          'Content-Disposition': 'attachment; filename="example.txt"'
        }), () => stream.destroy());
      }
    })]
  }]
});

await startCricketApp(app, { main: import.meta.url, port: process.env.PORT || 3000 });
