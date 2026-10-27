import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import request from 'supertest';

import {
  createCricketLogger,
  createCricketRuntime,
  defineEndpoint,
  defineJob,
  redisQueue,
  startCricketWorker,
  z
} from '../src/index.js';
import { defineManualTestApp } from '../test-support/app.js';

function captureLogger(options = {}) {
  let events = [];
  let config = { format: 'pretty', color: false, ...options, write: event => events.push(event) };
  return { events, config, logger: createCricketLogger(config) };
}

describe('human-readable Cricket logs', () => {
  it('prints readable metadata without dropping nested values, errors, or correlation IDs', () => {
    let { logger, events } = captureLogger({ service: 'Radar Worker' });
    let details = { stations: ['KTLX', 'KOUN'], nested: { token: 'secret-value', enabled: false } };
    details.self = details;
    logger.child({ jobRunId: 'jobrun_full-id', requestId: 'jobrun_full-id' })
      .error('radar.failed', {
        jobName: 'radar.refresh',
        count: 0,
        cached: false,
        empty: null,
        error: new Error('Radar unavailable'),
        details
      });

    let [output] = events;
    assert.match(output, /^\d{2}:\d{2}:\d{2}\.\d{3}Z ERROR \[Radar Worker\] radar.failed · radar.refresh\n/);
    assert.match(output, /jobRunId=jobrun_full-id/);
    assert.doesNotMatch(output, /requestId=/);
    assert.match(output, /count=0  cached=false  empty=null/);
    assert.match(output, /message: 'Radar unavailable'/);
    assert.match(output, /stations: \[ 'KTLX', 'KOUN' \]/);
    assert.match(output, /token: '\[Redacted\]'/);
    assert.match(output, /self: '\[Circular\]'/);
    assert.doesNotMatch(output, /secret-value|\x1b\[/);
    assert.equal(details.nested.token, 'secret-value');
  });

  it('keeps long strings and arrays available in indented details', () => {
    let { logger, events } = captureLogger();
    logger.info('import.finished', {
      envelopeId: 'envelope_'.repeat(20),
      rows: Array.from({ length: 105 }, (_, index) => `row-${index}`),
      note: 'line one\nline two'
    });
    assert.ok(events[0].includes('envelope_'.repeat(20)));
    assert.match(events[0], /row-104/);
    assert.doesNotMatch(events[0], /more items/);
    assert.match(events[0], /line one\\nline two/);
  });

  it('inherits explicit color settings and keeps JSON free of terminal styling', () => {
    let colored = captureLogger({ color: true });
    colored.logger.child({ requestId: 'req_color' }).warn('server.slow');
    assert.match(colored.events[0], /\x1b\[33mWARN/);
    assert.match(stripVTControlCharacters(colored.events[0]), /WARN  server.slow\n  requestId=req_color/);

    let plain = captureLogger({ color: false });
    plain.logger.child({ requestId: 'req_plain' }).warn('server.slow');
    assert.doesNotMatch(plain.events[0], /\x1b\[/);

    let json = captureLogger({ format: 'json', color: true });
    json.logger.child({ requestId: 'req_json' }).info('server.started', { token: 'secret-value' });
    let envelope = JSON.parse(json.events[0]);
    assert.equal(envelope.requestId, 'req_json');
    assert.equal(envelope.metadata.requestId, 'req_json');
    assert.equal(envelope.metadata.token, '[Redacted]');
    assert.doesNotMatch(json.events[0], /\x1b/);
  });

  it('detects terminal color and honors NO_COLOR, including an empty value', () => {
    let script = `
      import { createCricketLogger } from './src/logger.js';
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      createCricketLogger({ format: 'pretty' }).info('server.started');
    `;
    let environment = { ...process.env };
    delete environment.NO_COLOR;
    delete environment.FORCE_COLOR;
    let terminal = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: environment, encoding: 'utf8'
    });
    assert.match(terminal, /\x1b\[36mINFO/);
    let plain = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...environment, NO_COLOR: '' }, encoding: 'utf8'
    });
    assert.doesNotMatch(plain, /\x1b\[/);
    assert.match(plain, /INFO  server.started/);
  });

  it('shows the HTTP method, path, status, route, and full request ID through the runtime', async () => {
    let { config, events } = captureLogger({ service: 'Radar API' });
    let endpoint = defineEndpoint({
      method: 'get',
      path: '/stations',
      operationId: 'listStations',
      handler() { return { stations: [] }; }
    });
    let runtime = await createCricketRuntime(defineManualTestApp({
      logger: config,
      endpoints: [endpoint],
      observability: { requestId: () => 'req_stations_full' }
    }));
    try {
      let response = await request(runtime.app).get('/stations?token=private-query');
      assert.equal(response.status, 200);
      let started = events.find(event => event.includes('http.request.started'));
      let finished = events.find(event => event.includes('http.response.finished'));
      assert.match(started, /http.request.started · GET \/stations/);
      assert.match(finished.split('\n')[0], /http.response.finished · GET \/stations · listStations · 200/);
      assert.match(finished, /requestId=req_stations_full/);
      assert.doesNotMatch(events.join('\n'), /private-query/);
    } finally {
      await runtime.cleanup();
    }
  });

  it('summarizes real job spans while keeping unique context and failure evidence', async () => {
    let { config, events } = captureLogger({ service: 'Radar Worker' });
    let job = defineJob({
      name: 'radar.refresh',
      input: z.object({}),
      queue: redisQueue({ name: 'radar-live' }),
      async run({ logger, trace }) {
        logger.info('radar.counts', { warning_count: 0, source_cached: true });
        await trace.child({ station: 'KTLX' }).span('radar.fetch', () => {
          throw new Error('Upstream radar unavailable');
        });
      }
    });
    let worker = await startCricketWorker(defineManualTestApp({ logger: config }), {
      jobs: [job],
      queues: { test: true }
    });
    try {
      await worker.jobs.enqueue(job, {});
      await assert.rejects(worker.drain(), /Upstream radar unavailable/);
      let counts = events.find(event => event.includes('radar.counts'));
      assert.match(counts, /radar.counts · radar.refresh/);
      assert.match(counts, /warning_count=0  source_cached=true/);
      assert.ok(counts.indexOf('warning_count') < counts.indexOf('jobRunId'));
      let span = events.find(event => event.includes('trace.span.finished') && event.includes('radar.fetch'));
      assert.match(span.split('\n')[0], /trace.span.finished · radar.refresh · radar.fetch · [\d.]+ms · error/);
      assert.equal(span.match(/jobRunId/g).length, 1);
      assert.equal(span.match(/queueName/g).length, 1);
      assert.match(span, /station: 'KTLX'/);
      assert.match(span, /name: 'Error'/);
      assert.doesNotMatch(span, /undefined/);
      let failed = events.find(event => event.includes('job.failed'));
      assert.match(failed, /ERROR \[Radar Worker\] job.failed · radar.refresh/);
      assert.match(failed, /Upstream radar unavailable/);
    } finally {
      await worker.cleanup();
    }
  });
});
