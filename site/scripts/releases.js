import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { archiveName, fingerprint, unpack } from './archive.js';
import { settings } from './settings.js';

let exec = promisify(execFile);
let gh = async (...args) => (await exec('gh', args, { maxBuffer: 10 * 1024 * 1024 })).stdout;
let [command, directory, tag] = process.argv.slice(2);
if (!directory || !['download', 'upload'].includes(command) || (command === 'upload' && !tag))
  throw new Error('Usage: releases.js download <directory> | upload <directory> <tag>');

directory = resolve(directory);
await mkdir(directory, { recursive: true });
if (command === 'download') {
  let pages = JSON.parse(await gh('api', '--paginate', '--slurp', 'repos/{owner}/{repo}/releases?per_page=100'));
  for (let release of pages.flat().filter(release => !release.draft)) {
    let name = archiveName(release.tag_name);
    if (!release.assets.some(asset => asset.name === name)) continue;
    await gh('release', 'download', release.tag_name, '--pattern', name, '--dir', directory);
  }
} else {
  settings({ CRICKET_DOCS_VERSION: tag });
  let name = archiveName(tag);
  let local = join(directory, name);
  let release = JSON.parse(await gh('release', 'view', tag, '--json', 'assets'));
  if (!release.assets.some(asset => asset.name === name)) {
    await gh('release', 'upload', tag, local);
  } else {
    // A deploy retry can reuse the release asset if it contains the same files.
    let temporary = await mkdtemp(join(tmpdir(), 'cricket-docs-verify-'));
    try {
      await gh('release', 'download', tag, '--pattern', name, '--dir', temporary);
      let localBuild = join(temporary, 'local');
      let remoteBuild = join(temporary, 'remote');
      await unpack(local, localBuild);
      await unpack(join(temporary, name), remoteBuild);
      if (await fingerprint(localBuild) !== await fingerprint(remoteBuild))
        throw new Error(`Release docs ${tag} already exist with different content.`);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
