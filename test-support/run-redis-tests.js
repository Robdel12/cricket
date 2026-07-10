import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

let exec = promisify(execFile);
let activeContainer;
let activeProcess;
let pendingContainer;
let stopping;

async function stopContainer() {
  activeProcess?.kill('SIGTERM');

  let name = activeContainer ?? pendingContainer;
  if (!name)
    return;

  activeContainer = undefined;
  pendingContainer = undefined;
  await exec('docker', ['rm', '--force', name]).catch(() => {});
}

function stopOnSignal(code) {
  return () => {
    stopping ??= stopContainer().finally(() => process.exit(code));
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
    activeProcess = child;

    child.once('error', error => {
      if (activeProcess === child)
        activeProcess = undefined;

      reject(error);
    });
    child.once('exit', code => {
      if (activeProcess === child)
        activeProcess = undefined;

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

    function inspect(chunk) {
      let text = chunk.toString('utf8');
      output += text;
      process.stderr.write(text);

      if (output.includes('Ready to accept connections'))
        resolve();
    }

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', reject);
    child.once('exit', code => {
      reject(new Error(`Redis container exited before readiness with ${code}`));
    });
  });
}

function createContainer(name) {
  return new Promise((resolve, reject) => {
    let deadline = AbortSignal.timeout(120_000);
    let child = spawn('docker', [
      'create',
      '--name', name,
      '--publish', '127.0.0.1::6379',
      'redis:7-alpine',
      'redis-server',
      '--save', '',
      '--appendonly', 'no'
    ], {
      signal: deadline,
      stdio: ['ignore', 'ignore', 'inherit']
    });
    activeProcess = child;

    child.once('error', reject);
    child.once('exit', code => {
      if (activeProcess === child)
        activeProcess = undefined;

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
    activeProcess = logs;

    await waitForRedis(logs);
    logs.kill('SIGTERM');

    if (activeProcess === logs)
      activeProcess = undefined;

    let { stdout } = await exec('docker', ['port', name, '6379/tcp']);
    let port = stdout.trim().split(':').at(-1);

    await runTests(`redis://127.0.0.1:${port}`);
  } finally {
    await stopContainer();
  }
}

await runWithDocker();
