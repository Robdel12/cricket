import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

import { fingerprint } from '../../scripts/archive.js';
import { manifest, root, site } from '../../scripts/generate.js';

let exec = promisify(execFile);
let generated = new Set(['node_modules', '.astro', 'dist', 'published']);
let mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wasm': 'application/wasm'
};

async function serve(directory, base) {
  let server = createServer(async (request, response) => {
    try {
      let pathname = new URL(request.url, 'http://docs.test').pathname;
      if (!pathname.startsWith(base)) return response.writeHead(404).end();
      let file = resolve(directory, decodeURIComponent(pathname.slice(base.length)));
      if (file !== directory && !file.startsWith(directory + sep)) return response.writeHead(404).end();
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      let body = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}${base}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('visitors can open the stable release, switch to Next, and search within each version', { timeout: 120000 }, async t => {
  let directory = await mkdtemp(join(tmpdir(), 'cricket-docs-test-'));
  let checkout = join(directory, 'checkout');
  let archives = join(directory, 'archives');
  let published = join(directory, 'published');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(checkout);
  for (let path of ['.gitignore', 'package.json', 'vision.md', 'bin', 'src', 'docs', 'examples', 'site']) {
    await cp(join(root, path), join(checkout, path), {
      recursive: true,
      filter: path => !generated.has(basename(path)) && path !== join(site, 'src/content/docs')
    });
  }
  for (let path of ['node_modules', 'site/node_modules']) {
    // Astro needs the workspace's relative dependency links inside the checkout.
    await exec('cp', ['-RP', join(root, path), join(checkout, path)]);
    await rm(join(checkout, path, '.astro'), { recursive: true, force: true });
  }

  let run = (program, args, env = {}) => exec(program, args, {
    cwd: checkout, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024
  });
  let git = (...args) => run('git', args);
  let commitChanges = (...args) => git('-c', 'user.name=Docs test', '-c', 'user.email=docs@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', ...args);
  await git('init', '--quiet');
  await git('add', '.');
  await commitChanges('-m', 'Release fixture');
  let commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  let tag = `v${(await manifest()).version}`;
  await git('tag', tag);
  let base = '/docs-check/';
  let env = { CRICKET_DOCS_PATH: base, CRICKET_DOCS_VERSION: tag };
  let build = overrides => run(process.execPath, ['site/scripts/build.js'], { ...env, ...overrides });
  let archive = (...args) => run(process.execPath, ['site/scripts/archive.js', ...args]);

  await build();
  let metadata = JSON.parse(await readFile(join(checkout, 'site/dist/version.json'), 'utf8'));
  assert.deepEqual([metadata.version, metadata.commit, metadata.dirty], [tag, commit, false]);
  let frozen = await fingerprint(join(checkout, 'site/dist'));
  await archive('pack', 'site/dist', join(archives, `cricket-docs-${tag}.tar.gz`));

  let source = join(checkout, 'src/app.js');
  let original = await readFile(source, 'utf8');
  let sentence = 'Next-only quickstart note.';
  assert.ok(original.includes("You'll need Node"));
  await writeFile(source, original.replace("You'll need Node", `${sentence} You'll need Node`));
  await assert.rejects(build(), /Release docs require a clean checkout/);
  await writeFile(source, original);
  await commitChanges('--allow-empty', '-m', 'After the tag');
  await assert.rejects(build(), /Release tag must point to this exact checkout/);
  await writeFile(source, original.replace("You'll need Node", `${sentence} You'll need Node`));
  await build({ CRICKET_DOCS_VERSION: 'next' });
  await archive('assemble', 'site/dist', archives, published);
  assert.equal(await fingerprint(join(published, tag)), frozen);

  let server = await serve(published, base);
  t.after(server.close);
  let browser = await chromium.launch();
  t.after(() => browser.close());
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10000);
  let search = async () => {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Search' });
    await dialog.getByPlaceholder('Search', { exact: true }).fill('definePluginSchema');
    let result = dialog.getByRole('link', { name: /definePluginSchema/ }).first();
    await result.waitFor();
    return result;
  };
  await page.goto(server.url);
  await page.waitForURL(`${server.url}${tag}/`);
  let picker = page.getByRole('combobox', { name: 'Version' });
  await picker.waitFor();
  assert.equal(await picker.inputValue(), base + tag + '/');

  await page.getByRole('link', { name: 'Build your first route' }).click();
  let main = page.getByRole('main');
  await main.getByRole('heading', { name: 'Your first route' }).waitFor();
  assert.equal(await main.getByText(sentence, { exact: false }).count(), 0);
  assert.ok(await main.getByText('Hey, Cricket!', { exact: false }).count());
  await main.getByText(`pnpm add github:Robdel12/cricket#${tag}`, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  let releaseResult = await search();
  assert.ok((await releaseResult.getAttribute('href')).startsWith(base + tag + '/api/'));
  await page.getByRole('button', { name: 'Cancel' }).click();

  await picker.selectOption(base + 'next/');
  await page.waitForURL(server.url + 'next/');
  await page.getByRole('link', { name: 'Build your first route' }).click();
  await main.getByText(sentence, { exact: false }).waitFor();
  await main.getByText('pnpm add github:Robdel12/cricket', { exact: true }).waitFor();

  let result = await search();
  assert.match(await result.getAttribute('href'), /^\/docs-check\/next\/api\//);
  await result.click();
  await main.getByRole('heading', { name: 'definePluginSchema' }).waitFor();
  assert.match(await main.getByRole('link', { name: 'View source' }).first().getAttribute('href'), /github\.com\/Robdel12\/cricket\/blob\/[a-f0-9]{40}\/src\//);
});
