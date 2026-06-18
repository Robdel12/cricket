import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

let supportedReporters = new Set(['cricket', 'spec', 'dot', 'tap']);
let valueFlags = new Set(['--concurrency', '--grep', '--output', '--reporter']);
let ignoredDirectories = new Set([
  '.git',
  'coverage',
  'node_modules'
]);

function hasFlag(args, flag) {
  return args.includes(flag);
}

function optionValue(args, name) {
  let index = args.indexOf(name);

  if (index === -1)
    return undefined;

  let value = args[index + 1];

  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value`);

  return value;
}

function positionalArgs(args) {
  let positional = [];

  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index];

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (valueFlags.has(arg))
      index += 1;
  }

  return positional;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root) {
  if (!(await exists(root)))
    return [];

  let entries = await fs.readdir(root, {
    withFileTypes: true
  });
  let files = [];

  for (let entry of entries) {
    let fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...await walkFiles(fullPath));

      continue;
    }

    if (entry.isFile())
      files.push(fullPath);
  }

  return files;
}

async function collectFiles(cwd, roots) {
  let files = [];

  for (let root of roots)
    files.push(...await walkFiles(path.join(cwd, root)));

  return files;
}

function isTestFile(filePath) {
  return /\.test\.js$/.test(filePath);
}

/**
 * Discover Cricket's conventional test files.
 *
 * App/domain tests are preferred first, followed by the normal `test/` folder.
 * If neither exists, Cricket leaves discovery to Node by passing no files.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {Promise<string[]>}
 */
export async function discoverTestFiles(cwd = process.cwd()) {
  let files = (await collectFiles(cwd, ['api', 'src', 'test']))
    .filter(isTestFile);
  let seen = new Set();

  return files
    .map(filePath => path.relative(cwd, filePath))
    .filter(filePath => {
      if (seen.has(filePath))
        return false;

      seen.add(filePath);
      return true;
    })
    .sort();
}

function testStatus(line) {
  line = line.trimStart();

  if (/ # SKIP/.test(line))
    return 'skipped';

  if (/ # TODO/.test(line))
    return 'todo';

  return line.startsWith('ok ') ? 'passed' : 'failed';
}

function parseTapReport(tap, run) {
  let counts = {
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0
  };
  let tests = [];
  let pendingTest;

  for (let line of tap.split(/\r?\n/)) {
    let countMatch = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)/.exec(line);

    if (countMatch) {
      let [, name, value] = countMatch;
      let key = name === 'pass' ? 'passed' : name === 'fail' ? 'failed' : name;

      counts[key] = Number(value);
      continue;
    }

    let testMatch = /^\s*(ok|not ok) \d+ -? ?(.+?)(?: # (?:SKIP|TODO).*)?$/.exec(line);

    if (testMatch) {
      let [, , name] = testMatch;

      pendingTest = {
        name,
        status: testStatus(line)
      };
      continue;
    }

    let durationMatch = /^\s+duration_ms: ([0-9.]+)/.exec(line);

    if (durationMatch && pendingTest) {
      pendingTest.durationMs = Number(durationMatch[1]);
      continue;
    }

    let typeMatch = /^\s+type: '([^']+)'/.exec(line);

    if (typeMatch && pendingTest) {
      pendingTest.type = typeMatch[1];
      continue;
    }

    if (/^\s+\.\.\./.test(line) && pendingTest) {
      if (pendingTest.type !== 'suite') {
        tests.push({
          id: `test_${tests.length + 1}`,
          name: pendingTest.name,
          status: pendingTest.status,
          ...(pendingTest.durationMs === undefined ? {} : { durationMs: pendingTest.durationMs })
        });
      }

      pendingTest = undefined;
    }
  }

  return {
    version: 1,
    run,
    counts,
    tests,
    requests: [],
    spans: [],
    logs: []
  };
}

function runProcess(command, args, {
  cwd,
  stderr,
  stdout
}) {
  return new Promise(resolve => {
    let env = {
      ...process.env
    };

    delete env.NODE_TEST_CONTEXT;

    let child = spawn(command, args, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let stdoutChunks = [];
    let stderrChunks = [];

    child.stdout.on('data', chunk => {
      stdoutChunks.push(chunk);

      if (stdout)
        stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrChunks.push(chunk);

      if (stderr)
        stderr.write(chunk);
    });
    child.on('close', code => resolve({
      code,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8')
    }));
  });
}

async function readReportFile(reportPath) {
  try {
    let report = await fs.readFile(reportPath, 'utf8');

    await fs.rm(reportPath, {
      force: true
    });

    return report;
  } catch {
    return '';
  }
}

function nodeTestArgs({
  concurrency,
  coverage,
  grep,
  reporter,
  reportPath,
  targets
}) {
  let args = ['--test'];

  if (coverage)
    args.push('--experimental-test-coverage');

  if (grep)
    args.push(`--test-name-pattern=${grep}`);

  if (concurrency)
    args.push(`--test-concurrency=${concurrency}`);

  if (reporter) {
    args.push(`--test-reporter=${reporter}`);
    args.push('--test-reporter-destination=stdout');
  }

  if (reportPath) {
    args.push('--test-reporter=tap');
    args.push(`--test-reporter-destination=${reportPath}`);
  }

  args.push(...targets);

  return args;
}

/**
 * @typedef {object} CricketTestCommandReport
 * @property {1} version
 * @property {object} run - Run id and wall-clock timing.
 * @property {object} counts - Node test runner counts.
 * @property {object[]} tests - Parsed terminal test records.
 * @property {object[]} requests - Reserved for Cricket request records.
 * @property {object[]} spans - Reserved for Cricket trace spans.
 * @property {object[]} logs - Reserved for Cricket logs.
 */

/**
 * Run Cricket's Node test runner wrapper.
 *
 * @param {string[]} [args=[]] - Arguments after `cricket test`.
 * @param {object} [io]
 * @param {string} [io.cwd=process.cwd()]
 * @param {object} [io.stdout=process.stdout]
 * @param {object} [io.stderr=process.stderr]
 * @returns {Promise<CricketTestCommandReport>} Cricket test report.
 */
export async function runTestCommand(args = [], {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let json = hasFlag(args, '--json');
  let output = optionValue(args, '--output');
  let requestedReporter = optionValue(args, '--reporter') ?? 'cricket';
  let reporter = requestedReporter === 'cricket' ? 'spec' : requestedReporter;

  if (!supportedReporters.has(requestedReporter))
    throw new Error(`Unsupported test reporter ${requestedReporter}`);

  let targets = positionalArgs(args);

  if (!targets.length)
    targets = await discoverTestFiles(cwd);

  let startedAt = new Date().toISOString();
  let reportPath = path.join(os.tmpdir(), `cricket-test-${randomUUID()}.tap`);
  let result = await runProcess(process.execPath, nodeTestArgs({
    concurrency: optionValue(args, '--concurrency'),
    coverage: hasFlag(args, '--coverage'),
    grep: optionValue(args, '--grep'),
    reporter: json ? undefined : reporter,
    reportPath,
    targets
  }), {
    cwd,
    stderr,
    stdout: json ? undefined : stdout
  });
  let endedAt = new Date().toISOString();
  let tap = await readReportFile(reportPath);
  let report = parseTapReport(tap, {
    id: randomUUID(),
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt)
  });

  if (output)
    await fs.writeFile(path.resolve(cwd, output), `${JSON.stringify(report, null, 2)}\n`);

  if (json)
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  process.exitCode = result.code;
  return report;
}
