import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { generate, git, manifest, site } from './generate.js';
import { checkLinks } from './links.js';
import { settings } from './settings.js';

let exec = promisify(execFile);
let { version, path, base } = settings();
let commit = await git('rev-parse', 'HEAD');
let dirty = Boolean(await git('status', '--porcelain', '--untracked-files=normal'));
let { version: packageVersion } = await manifest();

if (version !== 'next') {
  if (version !== `v${packageVersion}`) throw new Error(`${version} does not match package version ${packageVersion}.`);
  if (dirty) throw new Error('Release docs require a clean checkout.');
  if (await git('rev-parse', `refs/tags/${version}^{commit}`) !== commit)
    throw new Error('Release tag must point to this exact checkout.');
}

await generate({ base, commit, version });
let { stdout, stderr } = await exec(process.execPath, [join(site, 'node_modules/astro/bin/astro.mjs'), 'build'], {
  cwd: site, maxBuffer: 10 * 1024 * 1024
});
process.stdout.write(stdout);
process.stderr.write(stderr);

let output = join(site, 'dist');
await checkLinks(output, base);
await writeFile(join(output, 'version.json'), JSON.stringify({
  schemaVersion: 1, version, packageVersion, commit, dirty, path, base
}, null, 2) + '\n');
console.log(`Built ${version} from ${commit}${dirty ? ' (working tree)' : ''}.`);
