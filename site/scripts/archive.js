import { createHash } from 'node:crypto';
import { access, cp, glob, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import * as tar from 'tar';

import { settings } from './settings.js';

async function metadata(directory) {
  let value = JSON.parse(await readFile(join(directory, 'version.json'), 'utf8'));
  if (typeof value.version !== 'string' || typeof value.path !== 'string' || typeof value.packageVersion !== 'string' || typeof value.dirty !== 'boolean')
    throw new Error(`Incomplete docs build metadata in ${directory}.`);
  let expected = settings({ CRICKET_DOCS_VERSION: value.version, CRICKET_DOCS_PATH: value.path });
  if (value.schemaVersion !== 1 || expected.base !== value.base || !/^[a-f0-9]{40}$/.test(value.commit))
    throw new Error(`Invalid docs build metadata in ${directory}.`);
  return value;
}

function requireRelease(value) {
  if (value.version === 'next' || value.dirty || value.version !== `v${value.packageVersion}`)
    throw new Error('Only clean, matching release builds can become release archives.');
}

async function buildFiles(directory) {
  let files = [];
  for (let entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Docs archives cannot contain symlinks.');
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

export function archiveName(version) {
  return `cricket-docs-${version}.tar.gz`;
}

export async function fingerprint(directory) {
  directory = resolve(directory);
  let files = await buildFiles(directory);
  let hash = createHash('sha256');
  for (let path of files.sort()) {
    let bytes = await readFile(path);
    hash.update(JSON.stringify([path.slice(directory.length + 1), bytes.length]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}
export async function pack(directory, output) {
  requireRelease(await metadata(directory));
  await buildFiles(directory);
  await mkdir(dirname(output), { recursive: true });
  await tar.c({ cwd: directory, file: output, gzip: true, portable: true, noMtime: true }, ['.']);
}
export async function unpack(archive, directory) {
  await mkdir(directory, { recursive: true });
  await tar.x({ file: archive, cwd: directory, strict: true, filter: (path, entry) => {
    if (path.startsWith('/') || path.split('/').includes('..') || !['File', 'Directory'].includes(entry.type))
      throw new Error(`Unsafe docs archive entry: ${path}`);
    return true;
  } });
  let value = await metadata(directory);
  requireRelease(value);
  return value;
}

export async function assemble({ next, archives, output }) {
  let current = await metadata(next);
  if (current.version !== 'next') throw new Error('The current build must be Next.');
  let staging = await mkdtemp(join(tmpdir(), 'cricket-docs-publish-'));
  try {
    let builds = new Map();
    function add(directory, value) {
      if (value.path !== current.path) throw new Error(`Cannot mix docs URL bases: ${value.path} and ${current.path}.`);
      if (builds.has(value.version)) throw new Error(`Duplicate docs version ${value.version}.`);
      builds.set(value.version, { directory, version: value.version, base: value.base, commit: value.commit });
    }
    add(next, current);
    for await (let file of glob('cricket-docs-v*.tar.gz', { cwd: archives })) {
      let directory = join(staging, file);
      let value = await unpack(join(archives, file), directory);
      if (file !== archiveName(value.version)) throw new Error(`Archive filename does not match ${value.version}.`);
      add(directory, value);
    }

    // A retained output may still have release versions missing from the local archive folder.
    for await (let path of glob('v*/version.json', { cwd: output })) {
      let directory = dirname(join(output, path));
      let value = await metadata(directory);
      requireRelease(value);
      if (path !== `${value.version}/version.json`) throw new Error(`Directory does not match ${value.version}.`);
      if (!builds.has(value.version)) add(directory, value);
    }

    let pending = [];
    for (let { version, directory } of builds.values()) {
      let destination = join(output, version);
      if (directory === destination) continue;
      let exists = await access(destination).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (exists && version !== 'next') {
        if (await fingerprint(destination) !== await fingerprint(directory))
          throw new Error(`Refusing to replace immutable docs ${version}.`);
      } else {
        pending.push({ version, directory, destination });
      }
    }
    await mkdir(output, { recursive: true });
    for (let { version, directory, destination } of pending) {
      let incoming = await mkdtemp(join(output, '.incoming-'));
      try {
        await cp(directory, incoming, { recursive: true });
        if (version === 'next') await rm(destination, { recursive: true, force: true });
        await rename(incoming, destination);
      } finally {
        await rm(incoming, { recursive: true, force: true });
      }
    }

    let [nextVersion, ...releases] = [...builds.values()].map(({ version, base, commit }) => ({ version, path: base, commit }));
    releases.sort((a, b) => semver.rcompare(a.version, b.version));
    let versions = [nextVersion, ...releases];
    let latest = releases.find(entry => !semver.prerelease(entry.version)) ?? versions[0];
    await writeFile(join(output, 'versions.json'), JSON.stringify({ schemaVersion: 1, latest: latest.version, versions }, null, 2) + '\n');
    let links = versions.map(entry => `<li><a href="${entry.path}">${entry.version === 'next' ? 'Next (unreleased)' : entry.version}</a></li>`).join('\n');
    await writeFile(join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cricket documentation</title><link rel="canonical" href="${latest.path}"><meta http-equiv="refresh" content="0;url=${latest.path}"><h1>Cricket documentation</h1><p><a href="${latest.path}">Read the ${latest.version} docs</a></p><ul>${links}</ul></html>\n`);
    await writeFile(join(output, '.nojekyll'), '');
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let [command, ...args] = process.argv.slice(2);
  if (command === 'pack' && args.length === 2) await pack(...args.map(path => resolve(path)));
  else if (command === 'assemble' && args.length === 3) await assemble({ next: resolve(args[0]), archives: resolve(args[1]), output: resolve(args[2]) });
  else throw new Error('Usage: archive.js pack <build> <archive> | assemble <next-build> <archives-dir> <output>');
}
