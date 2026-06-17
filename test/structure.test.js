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
      database: ${database},
      endpoints: [],
      models: []
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
  it('scaffolds the standard domain files', async () => {
    let root = await tempRoot();

    let result = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project-board',
      root
    ]);

    assert.match(result.stdout, /Created projectBoard domain/);
    assert.match(result.stdout, /project-board\.model\.js/);
    assert.match(result.stdout, /Next/);

    let files = await fs.readdir(path.join(root, 'project-board'));

    assert.deepEqual(files.sort(), [
      'project-board.model.js',
      'project-board.normalizers.js',
      'project-board.routes.js',
      'project-board.rules.js',
      'project-board.serializers.js',
      'project-board.service.js',
      'project-board.test.js',
      'project-board.validations.js'
    ]);

    let routes = await fs.readFile(
      path.join(root, 'project-board', 'project-board.routes.js'),
      'utf8'
    );

    assert.match(routes, /export let projectBoardEndpoints = \[/);
    assert.doesNotMatch(routes, /defineEndpoint/);

    let service = await fs.readFile(
      path.join(root, 'project-board', 'project-board.service.js'),
      'utf8'
    );

    assert.match(service, /export function createProjectBoardService/);
    assert.doesNotMatch(service, /createKnexRepository/);

    let rules = await fs.readFile(
      path.join(root, 'project-board', 'project-board.rules.js'),
      'utf8'
    );

    let model = await fs.readFile(
      path.join(root, 'project-board', 'project-board.model.js'),
      'utf8'
    );

    assert.match(model, /table: 'project_board'/);
    assert.match(model, /field\.public/);
    assert.doesNotMatch(model, /sensitive: false/);

    let validations = await fs.readFile(
      path.join(root, 'project-board', 'project-board.validations.js'),
      'utf8'
    );

    assert.match(validations, /ProjectBoardCreateInput/);

  });

  it('does not overwrite existing domain files unless forced', async () => {
    let root = await tempRoot();
    let modelPath = path.join(root, 'project', 'project.model.js');

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root
    ]);

    await fs.writeFile(modelPath, 'custom model\n');

    let skipped = await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root
    ]);

    assert.match(skipped.stdout, /skipped existing/);
    assert.equal(await fs.readFile(modelPath, 'utf8'), 'custom model\n');

    await execFileAsync(process.execPath, [
      'bin/cricket.js',
      'new',
      'domain',
      'project',
      root,
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
    let skill = await fs.readFile(
      path.join(root, '.agents', 'skills', 'cricket-api', 'SKILL.md'),
      'utf8'
    );

    assert.match(agents, /cricket-agent-guidance/);
    assert.match(agents, /Cricket App Guidance/);
    assert.match(agents, /App Shape/);
    assert.match(agents, /Domain Shape/);
    assert.match(agents, /\*\.normalizers\.js/);
    assert.match(agents, /api\/middleware/);
    assert.match(agents, /api\/services/);
    assert.match(agents, /api\/workers/);
    assert.match(agents, /api\/migrations/);
    assert.match(agents, /api\/dev/);
    assert.match(agents, /lifecycle/);
    assert.match(agents, /\*\.test\.js/);
    assert.match(skill, /name: cricket-api/);
    assert.match(skill, /OpenAPI generation/);
    assert.match(skill, /normalizers/);
    assert.match(skill, /api\/middleware/);
    assert.match(skill, /api\/workers/);
    assert.match(skill, /api\/dev/);
    assert.match(skill, /read-only runtime lifecycle/);
    assert.match(skill, /domain-local `\*\.test\.js`/);
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
    assert.match(result.stdout, /serializers: serializeBuildPublic/);
    assert.match(result.stdout, /Build fields: id public\/safe, user_id private\/sensitive/);
    assert.match(result.stdout, /POST\s+\/api\/builds \(postBuilds\)/);
    assert.match(result.stdout, /rules: requireUser, isNamedBuild/);
    assert.match(result.stdout, /GET\s+\/api\/builds\/:buildId \(getBuildsBuildId\)/);
    assert.match(result.stdout, /Build -> build/);
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
        observability: {
          requestId() {
            return 'req_test';
          },
          observe() {}
        },
        endpoints: [],
        models: []
      });
    `);
    await fs.writeFile(disabledAppPath, `
      import { defineCricketApp } from '${cricketUrl}';

      export let app = defineCricketApp({
        observability: {
          observe: []
        },
        endpoints: [],
        models: []
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
        },
        endpoints: [],
        models: []
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
