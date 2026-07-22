import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import knex from 'knex';

let execFileAsync = promisify(execFile);

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-'));
}

async function assertDirectoryExists(directoryPath) {
  assert.ok(await fs.stat(directoryPath).then(stat => stat.isDirectory()));
}

async function writeSqliteAppFixture({
  databaseSource
} = {}) {
  let root = await tempRoot();
  let appPath = path.join(root, 'app.js');
  let databasePath = path.join(root, 'app.sqlite');
  let migrationsDir = path.join(root, 'api', 'migrations');
  let cricketUrl = pathToFileURL(path.resolve('src/index.js')).href;
  let database = databaseSource ?? `{
        client: 'sqlite3',
        connection: {
          filename: ${JSON.stringify(databasePath)}
        },
        useNullAsDefault: true
      }`;

  await fs.mkdir(migrationsDir, {
    recursive: true
  });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module'
  }));
  await fs.writeFile(appPath, `
    import { defineCricketApp } from '${cricketUrl}';

    export let app = defineCricketApp({
      domains: [],
      database: ${database},
    });
  `);

  return {
    appPath,
    databasePath,
    migrationsDir,
    root
  };
}

describe('Cricket CLI', () => {
  it('scaffolds deliberately selected domain files', async () => {
    let root = await tempRoot();

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project-board',
      root,
      '--with',
      'model,validations,serializers,service,rules,routes,jobs,test'
    ]);

    assert.match(result.stdout, /Created projectBoard domain/);
    assert.match(result.stdout, /schema\.model\.js/);
    assert.match(result.stdout, /Next/);

    let files = await fs.readdir(path.join(root, 'project-board'));

    assert.deepEqual(files.sort(), [
      'access.rules.js',
      'behavior.test.js',
      'domain.service.js',
      'http.routes.js',
      'input.validations.js',
      'output.serializers.js',
      'project-board.jobs.js',
      'schema.model.js'
    ]);

    let routes = await fs.readFile(
      path.join(root, 'project-board', 'http.routes.js'),
      'utf8'
    );

    assert.match(routes, /export let projectBoardEndpoints = \[/);
    assert.doesNotMatch(routes, /defineEndpoint/);

    let service = await fs.readFile(
      path.join(root, 'project-board', 'domain.service.js'),
      'utf8'
    );

    assert.match(service, /export function createProjectBoardService/);
    assert.doesNotMatch(service, /createKnexRepository/);

    let jobs = await fs.readFile(
      path.join(root, 'project-board', 'project-board.jobs.js'),
      'utf8'
    );

    assert.match(jobs, /export let projectBoardJobs = \[/);

    let model = await fs.readFile(
      path.join(root, 'project-board', 'schema.model.js'),
      'utf8'
    );

    assert.match(model, /table: 'project_board'/);
    assert.match(model, /field\.public/);
    assert.doesNotMatch(model, /sensitive: false/);

    let validations = await fs.readFile(
      path.join(root, 'project-board', 'input.validations.js'),
      'utf8'
    );

    assert.match(validations, /ProjectBoardCreateInput/);

    let test = await fs.readFile(
      path.join(root, 'project-board', 'behavior.test.js'),
      'utf8'
    );

    assert.match(test, /describe\('project-board behavior'/);
    assert.match(test, /it\.todo\('tests behavior through the HTTP or worker boundary'\)/);
  });

  it('requires a deliberate domain file selection', async () => {
    let root = await tempRoot();

    await assert.rejects(
      execFileAsync(process.execPath, [
        'bin/cricket.js',
        'new',
        'domain',
        'project',
        root
      ]),
      error => {
        assert.match(error.stderr, /Domain scaffold requires --with/);
        return true;
      }
    );
  });

  it('supports selecting every domain file deliberately', async () => {
    let root = await tempRoot();

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
      '--with',
      'all'
    ]);

    let files = await fs.readdir(path.join(root, 'project'));

    assert.deepEqual(files.sort(), [
      'access.rules.js',
      'behavior.test.js',
      'domain.service.js',
      'http.routes.js',
      'input.validations.js',
      'output.serializers.js',
      'project.jobs.js',
      'schema.model.js',
      'source.normalizers.js'
    ]);
  });

  it('rejects invalid domain file selections', async () => {
    let root = await tempRoot();
    let invalidSelections = [
      ['unknown', /Unknown domain file type unknown/],
      ['all,model', /all cannot be combined with other types/],
      ['serializers', /serializer scaffold requires --with model/]
    ];

    for (let [selection, expectedError] of invalidSelections) {
      await assert.rejects(
        execFileAsync(process.execPath, [
          'bin/cricket.js',
          'new',
          'domain',
          'project',
          root,
          '--with',
          selection
        ]),
        error => {
          assert.match(error.stderr, expectedError);
          return true;
        }
      );
    }
  });

  it('adds serializers to a domain with an existing model', async () => {
    let root = await tempRoot();

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
      '--with',
      'model'
    ]);
    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
      '--with',
      'serializers'
    ]);

    let files = await fs.readdir(path.join(root, 'project'));

    assert.deepEqual(files.sort(), [
      'output.serializers.js',
      'schema.model.js'
    ]);
  });

  it('does not overwrite existing domain files unless forced', async () => {
    let root = await tempRoot();
    let modelPath = path.join(root, 'project', 'schema.model.js');

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
      '--with',
      'model'
    ]);

    await fs.writeFile(modelPath, 'custom model\n');

    let skipped = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
      '--with',
      'model'
    ]);

    assert.match(skipped.stdout, /skipped existing/);
    assert.equal(await fs.readFile(modelPath, 'utf8'), 'custom model\n');

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
      '--with',
      'model',
      '--force'
    ]);

    assert.notEqual(await fs.readFile(modelPath, 'utf8'), 'custom model\n');
  });

  it('scaffolds Cricket agent guidance', async () => {
    let root = await tempRoot();

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'agents',
      root
    ]);

    assert.match(result.stdout, /Created Cricket agent guidance/);
    assert.match(result.stdout, /AGENTS\.md/);
    assert.match(result.stdout, /Next/);

    let agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    let cricketSkill = await fs.readFile(
      path.join(root, '.agents', 'skills', 'cricket', 'SKILL.md'),
      'utf8'
    );
    let jobsSkill = await fs.readFile(
      path.join(root, '.agents', 'skills', 'cricket-jobs', 'SKILL.md'),
      'utf8'
    );
    let observabilitySkill = await fs.readFile(
      path.join(root, '.agents', 'skills', 'cricket-observability', 'SKILL.md'),
      'utf8'
    );
    let testingSkill = await fs.readFile(
      path.join(root, '.agents', 'skills', 'cricket-testing', 'SKILL.md'),
      'utf8'
    );

    assert.match(agents, /cricket-agent-guidance/);
    assert.match(agents, /Cricket App Guidance/);
    assert.match(agents, /Domains are Cricket's required default architecture/);
    assert.match(agents, /manual mode as visible tech debt/);
    assert.match(agents, /pnpm cricket check api\/index\.js/);
    assert.match(agents, /App Shape/);
    assert.match(agents, /Domain Shape/);
    assert.match(agents, /Jobs/);
    assert.match(agents, /\*\.normalizers\.js/);
    assert.match(agents, /\*\.jobs\.js/);
    assert.match(agents, /api\/middleware/);
    assert.match(agents, /api\/services/);
    assert.match(agents, /api\/workers/);
    assert.match(agents, /api\/migrations/);
    assert.match(agents, /api\/dev/);
    assert.match(agents, /lifecycle/);
    assert.match(agents, /\{ dependencies, services, cleanup \}/);
    assert.match(agents, /Recovery receives evidence, time, logger, and trace/);
    assert.match(agents, /defineJob/);
    assert.match(agents, /cronSchedule/);
    assert.match(agents, /createCricketJobs/);
    assert.match(agents, /startCricketWorker/);
    assert.match(agents, /jobFailure/);
    assert.match(agents, /cricket_jobs/);
    assert.match(agents, /\*\.test\.js/);
    assert.match(agents, /worker boundary/);
    assert.match(agents, /API versioning is optional and endpoint-owned/);
    assert.match(agents, /defineApiVersions/);
    assert.match(cricketSkill, /name: cricket/);
    assert.match(cricketSkill, /Domain Files/);
    assert.match(cricketSkill, /normalizers/);
    assert.match(cricketSkill, /API versioning is endpoint-owned and opt-in/);
    assert.match(cricketSkill, /defineApiVersions/);
    assert.match(cricketSkill, /\*\.jobs\.js/);
    assert.match(cricketSkill, /OpenAPI/);
    assert.match(cricketSkill, /cricket-jobs/);
    assert.match(cricketSkill, /cricket-observability/);
    assert.match(cricketSkill, /cricket-testing/);
    assert.match(cricketSkill, /pnpm cricket init \./);
    assert.match(cricketSkill, /migration escape hatch and visible tech debt/);
    assert.match(cricketSkill, /--with model,validations,service,routes,test/);
    assert.match(jobsSkill, /name: cricket-jobs/);
    assert.match(jobsSkill, /defineJob/);
    assert.match(jobsSkill, /cronSchedule/);
    assert.match(jobsSkill, /createCricketJobs/);
    assert.match(jobsSkill, /startCricketWorker/);
    assert.match(jobsSkill, /jobFailure/);
    assert.match(jobsSkill, /cricket_jobs/);
    assert.match(jobsSkill, /Redis coordinates hot execution/);
    assert.match(jobsSkill, /jobs\.removeFinished\(ids\)/);
    assert.match(jobsSkill, /Never hard-code\s+Cricket Redis keys/);
    assert.match(agents, /jobs\.removeFinished\(ids\)/);
    assert.match(observabilitySkill, /name: cricket-observability/);
    assert.match(observabilitySkill, /cricket trace/);
    assert.match(observabilitySkill, /lifecycle/);
    assert.match(observabilitySkill, /trace\.span/);
    assert.match(observabilitySkill, /no-op startup trace/);
    assert.match(observabilitySkill, /Endpoint API version families/);
    assert.match(testingSkill, /name: cricket-testing/);
    assert.match(testingSkill, /createTestRuntime/);
    assert.match(testingSkill, /worker boundary/);
    assert.match(testingSkill, /worker\.schedules\.tick/);
  });

  it('augments existing agent guidance without duplicating Cricket notes', async () => {
    let root = await tempRoot();
    let agentsPath = path.join(root, 'AGENTS.md');

    await fs.writeFile(agentsPath, '# Existing Guidance\n\nKeep this note.\n');

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'agents',
      root
    ]);
    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'agents',
      root
    ]);

    let agents = await fs.readFile(agentsPath, 'utf8');

    assert.match(agents, /# Existing Guidance/);
    assert.match(agents, /Keep this note/);
    assert.equal(agents.split('Cricket App Guidance').length - 1, 1);
    assert.equal(agents.split('cricket-agent-guidance').length - 1, 2);
  });

  it('scaffolds the small Cricket app structure', async () => {
    let root = await tempRoot();

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'app',
      root
    ]);

    assert.match(result.stdout, /Created Cricket app structure/);
    assert.match(result.stdout, /api\/index\.js/);
    assert.match(result.stdout, /api\/domains/);
    assert.match(result.stdout, /api\/middleware/);
    assert.match(result.stdout, /api\/services/);
    assert.match(result.stdout, /api\/workers/);
    assert.match(result.stdout, /api\/migrations/);
    assert.match(result.stdout, /api\/dev/);

    let appEntry = await fs.readFile(path.join(root, 'api', 'index.js'), 'utf8');

    assert.match(appEntry, /defineCricketApp/);
    assert.match(appEntry, /logger: \{/);
    assert.match(appEntry, /service: 'cricket-api'/);
    assert.match(appEntry, /domains: '\.\/domains'/);
    await assertDirectoryExists(path.join(root, 'api', 'domains'));
    await assertDirectoryExists(path.join(root, 'api', 'middleware'));
    await assertDirectoryExists(path.join(root, 'api', 'services'));
    await assertDirectoryExists(path.join(root, 'api', 'workers'));
    await assertDirectoryExists(path.join(root, 'api', 'migrations'));
    await assertDirectoryExists(path.join(root, 'api', 'dev'));
  });

  it('initializes the structured app and agent contract together', async () => {
    let root = await tempRoot();

    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      type: 'module'
    }));

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      root
    ]);

    assert.match(result.stdout, /Created structured Cricket project/);
    assert.match(result.stdout, /Created Cricket app structure/);
    assert.match(result.stdout, /Created Cricket agent guidance/);
    assert.match(await fs.readFile(path.join(root, 'api', 'index.js'), 'utf8'), /domains: '\.\/domains'/);
    assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /Cricket App Guidance/);
    await assertDirectoryExists(path.join(root, '.agents', 'skills', 'cricket'));

    let packageScope = path.join(root, 'node_modules', '@robdel12');
    await fs.mkdir(packageScope, { recursive: true });
    await fs.symlink(path.resolve('.'), path.join(packageScope, 'cricket'));

    let checked = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'check',
      path.join(root, 'api', 'index.js')
    ]);
    let inspected = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'inspect',
      path.join(root, 'api', 'index.js')
    ]);

    assert.match(checked.stdout, /check passed: 0 domains loaded/);
    assert.match(inspected.stdout, /Architecture: domains \(recommended\)/);

    await fs.appendFile(path.join(root, 'AGENTS.md'), '\nKeep this project note.\n');
    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      root
    ]);

    let agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Keep this project note/);
    assert.equal(agents.split('Cricket App Guidance').length - 1, 1);
  });

  it('does not overwrite the app entry unless forced', async () => {
    let root = await tempRoot();
    let appPath = path.join(root, 'api', 'index.js');

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'app',
      root
    ]);

    await fs.writeFile(appPath, 'custom app\n');

    let skipped = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'app',
      root
    ]);

    assert.match(skipped.stdout, /skipped existing/);
    assert.equal(await fs.readFile(appPath, 'utf8'), 'custom app\n');

    let forced = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'init',
      'app',
      root,
      '--force'
    ]);

    assert.match(forced.stdout, /\+ .*api\/index\.js/);
    assert.match(forced.stdout, /skipped existing .*api\/domains/);
    assert.notEqual(await fs.readFile(appPath, 'utf8'), 'custom app\n');
  });

  it('inspects a real Cricket app module', async () => {
    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'inspect',
      'fixtures/folder-app/src/app.js'
    ]);

    assert.match(result.stdout, /Cricket app/);
    assert.match(result.stdout, /Observability: request IDs default, events disabled, replay disabled/);
    assert.match(result.stdout, /Domains/);
    assert.match(result.stdout, /build/);
    assert.match(result.stdout, /validations: BuildCreateInput/);
    assert.match(result.stdout, /normalizers: normalizeBuildImport/);
    assert.match(result.stdout, /rules: isNamedBuild, requireUser/);
    assert.match(result.stdout, /Architecture: domains \(recommended\)/);
    assert.match(result.stdout, /serializers: serializeBuildPublic/);
    assert.match(result.stdout, /Build fields: id public\/safe, user_id private\/sensitive/);
    assert.match(result.stdout, /POST\s+\/api\/builds \(postBuilds\)/);
    assert.match(result.stdout, /rules: requireUser, isNamedBuild/);
    assert.match(result.stdout, /GET\s+\/api\/builds\/:buildId \(getBuildsBuildId\)/);
    assert.match(result.stdout, /Build -> build/);
  });

  it('checks structured and explicit manual architecture through the CLI', async () => {
    let root = await tempRoot();
    let manualPath = path.join(root, 'manual.js');
    let flatPath = path.join(root, 'flat.js');
    let cricketUrl = pathToFileURL(path.resolve('src/index.js')).href;

    await fs.writeFile(manualPath, `
      import { defineCricketApp } from '${cricketUrl}';
      export let app = defineCricketApp({ architecture: 'manual' });
    `);
    await fs.writeFile(flatPath, `
      export let app = { endpoints: [] };
    `);

    let structured = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'check',
      'fixtures/folder-app/src/app.js'
    ]);
    let manual = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'inspect',
      manualPath
    ]);
    let manualCheck = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'check',
      manualPath
    ]);

    assert.match(structured.stdout, /check passed: 1 domain loaded/);
    assert.match(manual.stdout, /Architecture: manual \(migration escape hatch/);
    assert.match(manualCheck.stderr, /valid with a warning: manual mode is migration tech debt/);

    await assert.rejects(execFileAsync(process.execPath, [
      'bin/cricket.js',
      'check',
      flatPath
    ]), error => {
      assert.match(error.stderr, /requires domains/);
      return true;
    });
  });

  it('marks deprecated routes in inspect output', async () => {
    let root = await tempRoot();
    let appPath = path.join(root, 'app.js');
    let cricketUrl = pathToFileURL(path.resolve('src/index.js')).href;

    await fs.writeFile(appPath, `
      import {
        defineCricketApp,
        defineEndpoint,
        deprecateEndpoint,
        ok
      } from '${cricketUrl}';

      let checkShas = deprecateEndpoint(defineEndpoint({
        method: 'post',
        path: '/sdk/check-shas',
        handler() {
          return ok({ success: true });
        }
      }), {
        sunset: '2026-09-01',
        replacement: 'POST /sdk/screenshots/batch',
        reason: 'Use the batch screenshot upload flow instead.'
      });

      export let app = defineCricketApp({
        architecture: 'manual',
        endpoints: [checkShas],
        models: []
      });
    `);

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'inspect',
      appPath
    ]);

    assert.match(result.stdout, /POST\s+\/sdk\/check-shas DEPRECATED \(postSdkCheckShas\)/);
    assert.match(result.stdout, /sunset: 2026-09-01/);
    assert.match(result.stdout, /replacement: POST \/sdk\/screenshots\/batch/);
    assert.match(result.stdout, /reason: Use the batch screenshot upload flow instead\./);
  });

  it('runs through a symlinked package bin', async () => {
    let root = await tempRoot();
    let binLink = path.join(root, 'cricket');

    await fs.symlink(path.resolve('bin/cricket.js'), binLink);

    let result = await execFileAsync(process.execPath, [
      binLink,
      'inspect',
      'fixtures/folder-app/src/app.js'
    ]);

    assert.match(result.stdout, /Cricket app: Folder Build API/);
  });

  it('inspects app observability posture', async () => {
    let root = await tempRoot();
    let appPath = path.join(root, 'app.js');
    let disabledAppPath = path.join(root, 'disabled-app.js');
    let cricketUrl = pathToFileURL(path.resolve('src/index.js')).href;

    await fs.writeFile(appPath, `
      import { defineCricketApp } from '${cricketUrl}';

      export let app = defineCricketApp({
        domains: [],
        observability: {
          requestId() {
            return 'req_test';
          },
          observe() {}
        },
      });
    `);
    await fs.writeFile(disabledAppPath, `
      import { defineCricketApp } from '${cricketUrl}';

      export let app = defineCricketApp({
        domains: [],
        observability: {
          observe: []
        },
      });
    `);

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'inspect',
      appPath
    ]);
    let disabled = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'inspect',
      disabledAppPath
    ]);

    assert.match(result.stdout, /Observability: request IDs custom, events enabled, replay terminal events/);
    assert.match(disabled.stdout, /Observability: request IDs default, events disabled, replay disabled/);
  });

  it('writes OpenAPI docs for a real Cricket app module', async () => {
    let root = await tempRoot();
    let out = path.join(root, 'openapi.json');

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'docs',
      'fixtures/folder-app/src/app.js',
      '--out',
      out
    ]);

    assert.match(result.stdout, /Wrote OpenAPI/);

    let document = JSON.parse(await fs.readFile(out, 'utf8'));

    assert.equal(document.openapi, '3.1.0');
    assert.equal(document.info.title, 'Folder Build API');
    assert.ok(document.paths['/api/builds']);
    assert.ok(document.components.schemas.BuildPublic);
    assert.equal(document.components.schemas.BuildPublic.properties.user_id, undefined);
    assert.equal(document.components.schemas.BuildPublic.properties.id.cricket, undefined);
    assert.equal(document.components.schemas.BuildPublic.properties.id.sensitive, undefined);
  });

  it('writes OpenAPI docs for an explicit endpoint API version', async () => {
    let root = await tempRoot();
    let appPath = path.join(root, 'app.js');
    let out = path.join(root, 'openapi.json');
    let cricketUrl = pathToFileURL(path.resolve('src/index.js')).href;

    await fs.writeFile(appPath, `
      import {
        defineApiVersions,
        defineCricketApp,
        defineEndpoint,
        defineSerializer,
        z
      } from '${cricketUrl}';

      let CurrentResponse = z.object({ id: z.string() });
      let LegacyResponse = z.object({ session_id: z.string() });
      let serializeLegacy = defineSerializer({
        name: 'session.output.legacy',
        output: LegacyResponse,
        serialize(value) {
          return { session_id: value.id };
        }
      });
      let versions = defineApiVersions({
        name: 'tornadic.ios',
        header: 'Tornadic-Version',
        current: '2026-09-01',
        default: '2025-11-15',
        versions: {
          '2025-11-15': {},
          '2026-09-01': {}
        }
      });
      let endpoint = defineEndpoint({
        method: 'post',
        path: '/sessions',
        apiVersions: versions({
          '2025-11-15': {
            response: serializeLegacy
          }
        }),
        response: CurrentResponse,
        handler() {
          return { id: 'session_123' };
        }
      });

      export let app = defineCricketApp({
        architecture: 'manual',
        endpoints: [endpoint]
      });
    `);

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'docs',
      appPath,
      '--api-version',
      'tornadic.ios=2026-09-01',
      '--out',
      out
    ]);

    let document = JSON.parse(await fs.readFile(out, 'utf8'));
    let operation = document.paths['/sessions'].post;
    let header = operation.parameters.find(parameter =>
      parameter.name === 'Tornadic-Version'
    );

    assert.ok(operation.responses[201].content['application/json'].schema.properties.id);
    assert.equal(header.required, true);
    assert.deepEqual(header.schema.enum, ['2026-09-01']);
  });

  it('traces one request from Cricket JSON logs on stdin', async () => {
    let input = [
      'not json',
      JSON.stringify({
        time: '2026-06-15T10:00:00.000Z',
        level: 'info',
        event: 'http.request.started',
        requestId: 'req_keep',
        metadata: {
          request: {
            method: 'GET',
            path: '/api/builds'
          }
        }
      }),
      JSON.stringify({
        time: '2026-06-15T10:00:00.010Z',
        level: 'info',
        event: 'http.route.matched',
        requestId: 'req_skip'
      }),
      JSON.stringify({
        time: '2026-06-15T10:00:00.020Z',
        level: 'info',
        event: 'http.response.finished',
        requestId: 'req_keep',
        route: {
          operationId: 'getBuilds'
        },
        metadata: {
          response: {
            status: 200
          }
        }
      })
    ].join('\n');

    let stdout = execFileSync(process.execPath, [
      'bin/cricket.js',
      'trace',
      'req_keep'
    ], {
      encoding: 'utf8',
      input
    });

    assert.match(stdout, /Trace req_keep/);
    assert.match(stdout, /http\.request\.started GET \/api\/builds/);
    assert.match(stdout, /http\.response\.finished getBuilds status=200/);
    assert.doesNotMatch(stdout, /req_skip/);
  });

  it('renders nested span timelines from Cricket JSON logs on stdin', async () => {
    let input = [
      JSON.stringify({
        time: '2026-06-15T11:00:00.000Z',
        level: 'info',
        event: 'http.request.started',
        requestId: 'req_keep',
        metadata: {
          request: {
            method: 'POST',
            path: '/api/builds'
          }
        }
      }),
      JSON.stringify({
        time: '2026-06-15T11:00:00.010Z',
        level: 'info',
        event: 'trace.span.finished',
        requestId: 'req_keep',
        span: {
          id: 'span_root',
          name: 'prepare build',
          durationMs: 18,
          status: 'ok'
        }
      }),
      JSON.stringify({
        time: '2026-06-15T11:00:00.012Z',
        level: 'warn',
        event: 'trace.span.finished',
        requestId: 'req_keep',
        metadata: {
          span: {
            id: 'span_child',
            parentId: 'span_root',
            name: 'load fixture',
            durationMs: 6,
            status: 'error',
            error: {
              code: 'MISSING_FIXTURE'
            }
          }
        }
      }),
      JSON.stringify({
        time: '2026-06-15T11:00:00.020Z',
        level: 'info',
        event: 'http.response.finished',
        requestId: 'req_keep',
        route: {
          operationId: 'createBuild'
        },
        metadata: {
          response: {
            status: 201
          }
        }
      })
    ].join('\n');

    let stdout = execFileSync(process.execPath, [
      'bin/cricket.js',
      'trace',
      'req_keep'
    ], {
      encoding: 'utf8',
      input
    });

    assert.match(stdout, /Trace req_keep/);
    assert.match(stdout, /http\.request\.started POST \/api\/builds/);
    assert.match(stdout, /trace\.span\.finished prepare build 18ms status=ok/);
    assert.match(stdout, /\n\s{4}2026-06-15T11:00:00\.012Z WARN trace\.span\.finished load fixture 6ms status=error error=MISSING_FIXTURE/);
    assert.match(stdout, /http\.response\.finished createBuild status=201/);
  });

  it('runs database migrations from a Cricket app definition', async () => {
    let {
      appPath,
      databasePath,
      migrationsDir
    } = await writeSqliteAppFixture();

    await fs.writeFile(path.join(migrationsDir, '20260616000000_create_projects.js'), `
      export async function up(db) {
        await db.schema.createTable('projects', table => {
          table.increments('id');
          table.string('name').notNullable();
        });
        await db('projects').insert({ name: 'Launch Plan' });
      }

      export async function down(db) {
        await db.schema.dropTable('projects');
      }
    `);

    let latest = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'migrate',
      'latest',
      appPath
    ]);
    let db = knex({
      client: 'sqlite3',
      connection: {
        filename: databasePath
      },
      useNullAsDefault: true
    });

    try {
      assert.match(latest.stdout, /Migrations:/);
      assert.match(latest.stdout, /20260616000000_create_projects\.js/);
      assert.deepEqual(await db('projects').select('name'), [
        {
          name: 'Launch Plan'
        }
      ]);
    } finally {
      await db.destroy();
    }

    let list = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'migrate',
      'list',
      appPath
    ]);
    let version = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'migrate',
      'current-version',
      appPath
    ]);
    let rollback = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'migrate',
      'rollback',
      appPath
    ]);

    assert.match(list.stdout, /Completed:/);
    assert.match(list.stdout, /20260616000000_create_projects\.js/);
    assert.match(version.stdout, /Current version: 20260616000000/);
    assert.match(rollback.stdout, /Migrations run:/);
    assert.match(rollback.stdout, /20260616000000_create_projects\.js/);
  });

  it('runs database migrations against an explicit environment', async () => {
    let root = await tempRoot();
    let appPath = path.join(root, 'app.js');
    let developmentPath = path.join(root, 'development.sqlite');
    let testPath = path.join(root, 'test.sqlite');
    let migrationsDir = path.join(root, 'api', 'migrations');
    let cricketUrl = pathToFileURL(path.resolve('src/index.js')).href;

    await fs.mkdir(migrationsDir, {
      recursive: true
    });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      type: 'module'
    }));
    await fs.writeFile(appPath, `
      import { defineCricketApp } from '${cricketUrl}';

      export let app = defineCricketApp({
        domains: [],
        database: {
          defaultEnvironment: 'development',
          environments: {
            development: {
              client: 'sqlite3',
              connection: {
                filename: ${JSON.stringify(developmentPath)}
              },
              useNullAsDefault: true
            },
            test: {
              client: 'sqlite3',
              connection: {
                filename: ${JSON.stringify(testPath)}
              },
              useNullAsDefault: true
            }
          }
        }
      });
    `);
    await fs.writeFile(path.join(migrationsDir, '20260616000000_create_projects.js'), `
      export async function up(db) {
        await db.schema.createTable('projects', table => {
          table.increments('id');
          table.string('name').notNullable();
        });
      }

      export async function down(db) {
        await db.schema.dropTable('projects');
      }
    `);

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'migrate',
      'latest',
      appPath,
      '--env',
      'test'
    ]);
    let db = knex({
      client: 'sqlite3',
      connection: {
        filename: testPath
      },
      useNullAsDefault: true
    });

    try {
      assert.match(result.stdout, /20260616000000_create_projects\.js/);
      assert.deepEqual(await db.schema.hasTable('projects'), true);
    } finally {
      await db.destroy();
    }

    await assert.rejects(fs.stat(developmentPath), {
      code: 'ENOENT'
    });
  });

  it('creates migration files in the Cricket migrations directory by default', async () => {
    let {
      appPath,
      root
    } = await writeSqliteAppFixture();

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'migrate',
      'make',
      appPath,
      'create_builds'
    ]);

    assert.match(result.stdout, /api\/migrations/);

    let files = await fs.readdir(path.join(root, 'api', 'migrations'));

    assert.equal(files.length, 1);
    assert.match(files[0], /create_builds\.js$/);
  });
});
