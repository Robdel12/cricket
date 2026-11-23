import { execFile } from 'node:child_process';
import { glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { guideOrder } from '../navigation.js';
import { settings } from './settings.js';
import { publicApi, sourceGuides } from './source.js';

let exec = promisify(execFile);
export let root = fileURLToPath(new URL('../../', import.meta.url));
export let site = join(root, 'site');
let repository = 'https://github.com/Robdel12/cricket';
let read = path => readFile(join(root, path), 'utf8');
export let manifest = async () => JSON.parse(await read('package.json'));
export let git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();

async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function anchor(heading) {
  return heading.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function code(language, body) {
  return `\`\`\`${language}\n${body.trim()}\n\`\`\``;
}

function apiSlug(key) {
  return key === '.' ? 'root' : key.slice(2);
}

function apiBody(entry, sourceLink) {
  let { name, parameters, options, dependency, source, description } = entry;
  let declaration = source.getSourceFile();
  let line = declaration.getLineAndCharacterOfPosition(source.getStart()).line + 1;
  let link = sourceLink(relative(root, declaration.fileName), `L${line}`);
  let parts = [`## ${name}`, description];
  if (parameters) parts.push(code('js', `${name}(${parameters.join(', ')})`));
  if (dependency) parts.push(`Re-exported from \`${dependency}\`.`);
  if (options?.length) parts.push(options.map(({ name, optional, description }) =>
    `- \`${name}\`${optional ? ' (optional)' : ''} — ${description.replaceAll('\n', ' ')}`).join('\n'));
  parts.push(`[View source](${link})`);
  return parts.join('\n\n');
}

export async function generate({ base, commit, version }) {
  let files = [];
  for await (let path of glob(['src/**/*.js', 'bin/*.js'], { cwd: root }))
    files.push([path, await read(path)]);
  let guides = sourceGuides(files);
  let required = ['overview', 'cli', 'api', ...guideOrder];
  for (let key of required) if (!guides.has(key)) throw new Error(`Missing source guide ${key}.`);
  for (let key of guides.keys()) if (!required.includes(key)) throw new Error(`Add guide ${key} to site/navigation.js.`);

  let { name, exports } = await manifest();
  let modules = publicApi(root, exports);
  let output = join(site, 'src/content/docs');
  let sourceLink = (path, hash) => `${repository}/blob/${commit}/${path}${hash ? '#' + hash : ''}`;
  let guideAnchors = new Map(guideOrder.map(key => [anchor(guides.get(key).title), `guides/${key}/`]));

  function siteLinks(body) {
    return body.replace(/\]\(([^)]+)\)/g, (link, href) => {
      let [file, hash] = href.split('#');
      if (file === 'api.md') return `](${base}api/)`;
      if (file === 'guide.md' && guideAnchors.has(hash)) return `](${base}${guideAnchors.get(hash)})`;
      if (file === '../vision.md') return `](${base}contributing/vision/)`;
      if (file.startsWith('../')) return `](${sourceLink(file.slice(3), hash)})`;
      return link;
    });
  }

  async function page(path, frontmatter, body) {
    await write(join(output, `${path}.md`), `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${body.trim()}\n`);
  }

  await rm(output, { recursive: true, force: true });
  let overview = guides.get('overview');
  await page('index', {
    title: overview.title,
    template: 'splash',
    hero: {
      tagline: 'Build a Node API with explicit contracts, thin routes, and plain JavaScript.',
      actions: [
        { text: 'Build your first route', link: base + 'guides/getting-started/', variant: 'primary' },
        { text: 'Browse the API', link: base + 'api/', variant: 'secondary' }
      ]
    }
  }, siteLinks(overview.body));
  await page('404', { title: 'Page not found', pagefind: false },
    `Start at the [Cricket docs homepage](${base}) or use search to find what you need.`);

  let example = code('js', await read('examples/docs-start.js'));
  let installFrom = 'github:Robdel12/cricket';
  let guideBody = (body, source) => body
    .replace('<!-- quickstart install -->', () => code('sh', `pnpm init --init-type module\npnpm add ${source}`))
    .replace('<!-- quickstart example -->', () => example);
  let portableGuide = `# Using Cricket\n\n${overview.body}\n`;
  for (let key of guideOrder) {
    let { title, body } = guides.get(key);
    let markdownBody = guideBody(body, installFrom).replace(/^(#{2,5}) /gm, '#$1 ');
    portableGuide += `\n## ${title}\n\n${markdownBody}\n`;
    let siteBody = guideBody(body, version === 'next' ? installFrom : `${installFrom}#${version}`);
    await page(`guides/${key}`, { title }, siteLinks(siteBody));
  }

  let cli = guides.get('cli');
  let { stdout } = await exec(process.execPath, [join(root, 'bin/cricket.js')], { cwd: root });
  await page('cli', { title: cli.title }, `${siteLinks(cli.body)}\n\n${code('text', stdout)}`);

  let api = guides.get('api');
  let portableApi = `# ${api.title}\n\n${api.body}\n`;
  let imports = [];
  for (let [key, entries] of modules) {
    let specifier = name + key.slice(1);
    let slug = apiSlug(key);
    imports.push(`- [\`${specifier}\`](${base}api/${slug}/)`);
    await page(`api/${slug}`, { title: specifier }, entries.map(entry => apiBody(entry, sourceLink)).join('\n\n'));

    portableApi += `\n## ${specifier}\n\n| Export | Use |\n| --- | --- |\n`;
    for (let { name, description } of entries)
      portableApi += `| \`${name}\` | ${description.split('\n\n')[0].replaceAll('\n', ' ').replaceAll('|', '\\|')} |\n`;
  }
  await page('api', { title: api.title }, `${siteLinks(api.body)}\n\n${imports.join('\n')}`);

  for (let [file, slug] of [['docs/documentation.md', 'documentation'], ['vision.md', 'vision']]) {
    let [heading, ...body] = (await read(file)).split('\n');
    await page(`contributing/${slug}`, { title: heading.replace(/^# /, '') }, siteLinks(body.join('\n')));
  }

  return { guide: portableGuide, api: portableApi };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let { base, version } = settings();
  let documents = await generate({ base, commit: await git('rev-parse', 'HEAD'), version });
  let banner = '<!-- Generated from source JSDoc. Run pnpm --filter cricket-docs generate --write-markdown. -->\n';
  for (let [name, body] of Object.entries(documents)) {
    let file = `docs/${name}.md`;
    if (process.argv.includes('--write-markdown')) await write(join(root, file), banner + body);
    if (process.argv.includes('--check-markdown') && await read(file) !== banner + body)
      throw new Error(`${file} is stale. Run pnpm --filter cricket-docs generate --write-markdown.`);
  }
}
