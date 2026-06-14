import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let execFileAsync = promisify(execFile);

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cricket-'));
}

async function assertDirectoryExists(directoryPath) {
  assert.ok(await fs.stat(directoryPath).then(stat => stat.isDirectory()));
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
      path.join(root, '.codex', 'skills', 'cricket-api', 'SKILL.md'),
      'utf8'
    );

    assert.match(agents, /Cricket App Guidance/);
    assert.match(agents, /App Shape/);
    assert.match(agents, /Domain Shape/);
    assert.match(agents, /\*\.normalizers\.js/);
    assert.match(agents, /api\/middleware/);
    assert.match(agents, /api\/services/);
    assert.match(agents, /api\/workers/);
    assert.match(agents, /api\/migrations/);
    assert.match(agents, /api\/dev/);
    assert.match(agents, /\*\.test\.js/);
    assert.match(skill, /name: cricket-api/);
    assert.match(skill, /OpenAPI generation/);
    assert.match(skill, /normalizers/);
    assert.match(skill, /api\/middleware/);
    assert.match(skill, /api\/workers/);
    assert.match(skill, /api\/dev/);
    assert.match(skill, /domain-local `\*\.test\.js`/);
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
    assert.match(result.stdout, /Domains/);
    assert.match(result.stdout, /build/);
    assert.match(result.stdout, /validations: BuildCreateInput/);
    assert.match(result.stdout, /normalizers: normalizeBuildImport/);
    assert.match(result.stdout, /serializers: serializeBuildPublic/);
    assert.match(result.stdout, /POST\s+\/api\/builds auth/);
    assert.match(result.stdout, /Build -> build/);
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
  });
});
