import { defineCricketApp, defineEndpoint } from '@robdel12/cricket';
import { createTestRuntime } from '@robdel12/cricket/test';

let state = { message: 'Before maintenance' };
let app = defineCricketApp({
  domains: [{
    name: 'message',
    endpoints: [defineEndpoint({
      method: 'get',
      path: '/message',
      handler: () => state
    })]
  }],
  logger() {}
});
let harness = await createTestRuntime(app);

try {
  let hold = harness.runtime.requests.pause();
  await hold.idle();
  state = { message: 'After maintenance' };
  hold.resume();

  console.log(harness.origin, (await harness.api.get('/message')).body);
} finally {
  await harness.cleanup();
}
