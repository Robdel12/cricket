import { Readable } from 'node:stream';
import {
  defineCricketApp,
  defineEndpoint,
  ok,
  startCricketApp,
  withHeaders,
  withResponseCleanup,
  z
} from '../src/index.js';

let content = Buffer.from('A file served through Cricket.\n');
export let app = defineCricketApp({
  name: 'Known-length stream example',
  domains: [{
    name: 'files',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/download',
      responses: {
        200: {
          schema: z.instanceof(Readable).meta({ jsonSchema: { type: 'string', format: 'binary' } }),
          contentType: 'application/octet-stream'
        }
      },
      handler() {
        let stream = Readable.from([content]);
        return withResponseCleanup(withHeaders(ok(stream), {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(content.length),
          'Content-Disposition': 'attachment; filename="example.txt"'
        }), () => stream.destroy());
      }
    })]
  }]
});

await startCricketApp(app, { main: import.meta.url, port: process.env.PORT || 3000 });
