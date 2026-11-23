import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, fingerprint, pack } from '../scripts/archive.js';

async function fixture(t, version, path = '/cricket/') {
  let directory = await mkdtemp(join(tmpdir(), 'cricket-docs-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'version.json'), JSON.stringify({ schemaVersion: 1, version, packageVersion: version.slice(1), path, base: `${path}${version}/`, commit: 'a'.repeat(40), dirty: false }));
  await writeFile(join(directory, 'index.html'), `Docs for ${version}`);
  return directory;
}

test('publication retains frozen releases, prefers stable versions and refuses replacements', async t => {
  let next = await fixture(t, 'next');
  let release = await fixture(t, 'v1.2.0');
  let preview = await fixture(t, 'v2.0.0-rc.1');
  let archives = join(next, 'archives');
  let output = join(next, 'published');
  await mkdir(archives);
  await pack(release, join(archives, 'cricket-docs-v1.2.0.tar.gz'));
  await pack(preview, join(archives, 'cricket-docs-v2.0.0-rc.1.tar.gz'));
  // Keep build inputs separate from the publishing destination.
  let nextBuild = await fixture(t, 'next');
  await assemble({ next: nextBuild, archives, output });
  let frozen = await fingerprint(join(output, 'v1.2.0'));
  let index = JSON.parse(await readFile(join(output, 'versions.json'), 'utf8'));
  assert.equal(index.latest, 'v1.2.0');
  assert.deepEqual(index.versions.map(entry => entry.version), ['next', 'v2.0.0-rc.1', 'v1.2.0']);
  await writeFile(join(nextBuild, 'index.html'), 'A new guide');
  await assemble({ next: nextBuild, archives, output });
  assert.equal(await fingerprint(join(output, 'v1.2.0')), frozen);
  assert.equal(await readFile(join(output, 'next/index.html'), 'utf8'), 'A new guide');
  await rm(join(archives, 'cricket-docs-v1.2.0.tar.gz'));
  await assemble({ next: nextBuild, archives, output });
  assert.equal(await fingerprint(join(output, 'v1.2.0')), frozen);
  assert.ok(JSON.parse(await readFile(join(output, 'versions.json'), 'utf8')).versions.some(entry => entry.version === 'v1.2.0'));
  await writeFile(join(release, 'index.html'), 'Changed release');
  await pack(release, join(archives, 'cricket-docs-v1.2.0.tar.gz'));
  await assert.rejects(assemble({ next: nextBuild, archives, output }), /Refusing to replace immutable docs/);
  assert.equal(await fingerprint(join(output, 'v1.2.0')), frozen);
});

test('a site cannot silently change its hosting path or publish dirty release output', async t => {
  let next = await fixture(t, 'next');
  let release = await fixture(t, 'v1.0.0', '/different/');
  let archives = await fixture(t, 'next');
  await pack(release, join(archives, 'cricket-docs-v1.0.0.tar.gz'));
  await assert.rejects(assemble({ next, archives, output: join(archives, 'out') }), /Cannot mix docs URL bases/);
  let value = JSON.parse(await readFile(join(release, 'version.json'), 'utf8'));
  await writeFile(join(release, 'version.json'), JSON.stringify({ ...value, dirty: true }));
  await assert.rejects(pack(release, join(archives, 'dirty.tar.gz')), /Only clean/);
});

test('archive comparisons distinguish paths from file contents', async t => {
  let first = await fixture(t, 'v1.0.0');
  let second = await fixture(t, 'v1.0.0');
  await writeFile(join(first, 'a'), 'bc');
  await writeFile(join(second, 'ab'), 'c');
  assert.notEqual(await fingerprint(first), await fingerprint(second));
});
