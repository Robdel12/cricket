import { defineCricketApp, defineEndpoint } from '../src/index.js';

let events = defineEndpoint({
  method: 'get',
  path: '/events',
  fetchResponses: {
    200: {
      description: 'Server-sent events',
      contentTypes: ['text/event-stream']
    }
  },
  fetch(request, { request: cricketRequest }) {
    let body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: connected\ndata: ${cricketRequest.id}\n\n`));
        controller.close();
      }
    });

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' }
    });
  }
});

export let app = defineCricketApp({
  name: 'Fetch endpoint example',
  domains: [{ name: 'events', endpoints: [events] }]
});
