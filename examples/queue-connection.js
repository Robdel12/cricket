import { createCricketJobs } from '../src/jobs/index.js';

let producer = await createCricketJobs({
  queues: {
    redis: { url: process.env.REDIS_URL }
  }
});

try {
  // A command-transport fact for app-owned health checks. Worker progress,
  // blocking waits, ledger state, and capacity need their own app checks.
  console.log(await producer.driver.checkConnection());
} finally {
  await producer.cleanup();
}

console.log(await producer.driver.checkConnection());
