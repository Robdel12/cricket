import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

let exec = promisify(execFile);
let activeContainer;
let activeProcess;
let pendingContainer;
let stopping;

function trackProcess(child) {
  let tracked = {
    child,
    closed: new Promise(resolve => child.once('close', resolve))
  };
  activeProcess = tracked;
  tracked.closed.then(() => {
    if (activeProcess === tracked)
      activeProcess = undefined;
  });
}

async function stopActiveProcess() {
  let tracked = activeProcess;
  if (!tracked)
    return;

  tracked.child.kill('SIGTERM');
  await tracked.closed;
}

async function stopContainer() {
  await stopActiveProcess();

  let name = activeContainer ?? pendingContainer;
  if (!name)
    return;

  activeContainer = undefined;
  pendingContainer = undefined;
  await exec('docker', ['rm', '--force', name]);
}

function stopOnSignal(code) {
  return () => {
    stopping ??= stopContainer()
      .catch(error => process.stderr.write(`Redis test cleanup failed: ${error.message}\n`))
      .finally(() => process.exit(code));
  };
}

process.once('SIGINT', stopOnSignal(130));
process.once('SIGTERM', stopOnSignal(143));

function runTests(url) {
  return new Promise((resolve, reject) => {
    let child = spawn(process.execPath, [
      '--test',
      'integration/jobs-redis.integration.js'
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CRICKET_TEST_REDIS_URL: url
      },
      stdio: 'inherit'
    });
    trackProcess(child);

    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0)
        resolve();
      else
        reject(new Error(`Redis integration tests exited with ${code}`));
    });
  });
}

function waitForRedis(child) {
  return new Promise((resolve, reject) => {
    let output = '';

    function cleanup() {
      child.stdout.off('data', inspect);
      child.stderr.off('data', inspect);
      child.off('error', onError);
      child.off('exit', onExit);
    }

    function finish(callback, value) {
      cleanup();
      callback(value);
    }

    function inspect(chunk) {
      let text = chunk.toString('utf8');
      output += text;
      process.stderr.write(text);

      if (output.includes('Ready to accept connections'))
        finish(resolve);
    }

    function onError(error) {
      finish(reject, error);
    }

    function onExit(code) {
      finish(reject, new Error(`Redis container exited before readiness with ${code}`));
    }

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function createContainer(name) {
  return new Promise((resolve, reject) => {
    let deadline = AbortSignal.timeout(120_000);
    let child = spawn('docker', [
      'create',
      '--name', name,
      '--publish', '127.0.0.1::6379',
      'redis:7.4.5-alpine@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08',
      'redis-server',
      '--save', '',
      '--appendonly', 'no'
    ], {
      signal: deadline,
      stdio: ['ignore', 'ignore', 'inherit']
    });
    trackProcess(child);

    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0)
        resolve();
      else
        reject(new Error(`Redis container creation exited with ${code}`));
    });
  });
}

async function runWithDocker() {
  let name = `cricket-redis-${randomUUID()}`;
  pendingContainer = name;
  let failure;

  try {
    await createContainer(name);
    activeContainer = name;
    pendingContainer = undefined;

    await exec('docker', ['start', name], {
      timeout: 30_000
    });

    let logs = spawn('docker', [
      'logs',
      '--follow',
      name
    ], {
      signal: AbortSignal.timeout(30_000),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    trackProcess(logs);

    await waitForRedis(logs);
    await stopActiveProcess();

    let { stdout } = await exec('docker', ['port', name, '6379/tcp']);
    let port = stdout.trim().split(':').at(-1);

    await runTests(`redis://127.0.0.1:${port}`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await stopContainer();
    } catch (cleanupError) {
      if (!failure)
        throw cleanupError;

      process.stderr.write(`Redis test cleanup failed: ${cleanupError.message}\n`);
    }
  }
}

await runWithDocker();
