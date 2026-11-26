import { createCricketJobs } from '@robdel12/cricket/jobs';

let producer = await createCricketJobs({
  queues: {
    redis: { url: process.env.REDIS_URL }
  }
});

try {
  // This only tells you Redis answered a PING. Your health check still
  // decides what "healthy" means, like whether workers are making progress.
  console.log(await producer.driver.checkConnection());
} finally {
  await producer.cleanup();
}

console.log(await producer.driver.checkConnection());
