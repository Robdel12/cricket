import { execFile } from 'node:child_process';
import { glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { guideOrder } from '../navigation.js';
import { installSource, settings } from './settings.js';
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

// Search results and link previews quote the description, so each page uses
// its own intro: prose before the first heading, trimmed to a snippet.
export function describe(markdown) {
  let intro = markdown.replace(/```[\s\S]*?```/g, '').trim().split(/^#/m)[0];
  let prose = intro.split(/\n\s*\n/).map(block => block.trim())
    .filter(block => block && !/^(#|-|\*|\||<|```|\d+\.)/.test(block))
    .map(block => block.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').replace(/\s+/g, ' '));
  let text = '';
  for (let block of prose) if (text.length < 120) text = `${text} ${block}`.trim();
  if (text.length <= 160) return text;
  return text.slice(0, text.lastIndexOf(' ', 157)).replace(/[,;:.]$/, '') + '…';
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
  // Pages under Contribute, keyed by the source file other docs link to.
  let contributing = new Map([['docs/documentation.md', 'documentation'], ['docs/releasing.md', 'releasing'], ['vision.md', 'vision']]);
  let guideAnchors = new Map(guideOrder.map(key => [anchor(guides.get(key).title), `guides/${key}/`]));

  function siteLinks(body) {
    return body.replace(/\]\(([^)]+)\)/g, (link, href) => {
      let [file, hash] = href.split('#');
      if (file === 'api.md') return `](${base}api/)`;
      if (file === 'guide.md' && guideAnchors.has(hash)) return `](${base}${guideAnchors.get(hash)})`;
      let contributingPage = contributing.get(file === '../vision.md' ? 'vision.md' : `docs/${file}`);
      if (contributingPage) return `](${base}contributing/${contributingPage}/${hash ? '#' + hash : ''})`;
      if (file.startsWith('../')) return `](${sourceLink(file.slice(3), hash)})`;
      return link;
    });
  }

  async function page(path, frontmatter, body) {
    frontmatter = { description: describe(body), ...frontmatter };
    await write(join(output, `${path}.md`), `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${body.trim()}\n`);
  }

  await rm(output, { recursive: true, force: true });
  let overview = guides.get('overview');
  let headline = 'Node APIs that explain themselves.';
  let summary = describe(overview.body);
  await page('index', {
    title: headline,
    description: summary,
    template: 'splash',
    // The tab and search result lead with the name; social cards use the headline.
    head: [
      { tag: 'title', content: `${overview.title}: ${headline}` },
      { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
      { tag: 'script', attrs: { type: 'application/ld+json' }, content: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        name: overview.title,
        description: summary,
        codeRepository: repository,
        programmingLanguage: 'JavaScript',
        runtimePlatform: 'Node.js',
        license: 'https://opensource.org/licenses/MIT'
      }) }
    ],
    hero: {
      title: headline,
      tagline: 'Cricket is a functional, domain-first framework for Node. Every route declares what it takes and what it returns, every definition is frozen, and your whole app reads straight from the folders.',
      actions: [
        { text: 'Build your first route', link: base + 'guides/getting-started/', variant: 'primary' },
        { text: 'Browse the API', link: base + 'api/', variant: 'secondary' }
      ]
    }
  }, siteLinks(overview.body));
  await page('404', { title: 'Page not found', pagefind: false, head: [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }] },
    `Start at the [Cricket docs homepage](${base}) or use search to find what you need.`);

  // Guides quote real, tested files with <!-- example path [tab title] -->.
  let includePattern = /<!-- example (\S+)(?: (\S+))? -->/g;
  let includePaths = new Set([...guides.values()].flatMap(({ body }) => [...body.matchAll(includePattern)].map(match => match[1])));
  let examples = new Map(await Promise.all([...includePaths].map(async path => [path, await read(path)])));
  let exampleBlock = (path, title = path) => code(`${path.split('.').at(-1)} title="${title}"`, examples.get(path));
  let guideBody = (body, source) => body
    .replace('<!-- quickstart install -->', () => code('sh', `pnpm init --init-type module\npnpm add ${source}`))
    .replace(includePattern, (_, path, title) => exampleBlock(path, title));
  let portableGuide = `# Using Cricket\n\n${overview.body}\n`;
  for (let key of guideOrder) {
    let { title, body } = guides.get(key);
    let markdownBody = guideBody(body, installSource('next')).replace(/^(#{2,5}) /gm, '#$1 ');
    portableGuide += `\n## ${title}\n\n${markdownBody}\n`;
    let siteBody = guideBody(body, installSource(version));
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
    let description = describe(`Everything ${specifier} exports: ${entries.map(entry => entry.name).join(', ')}.`);
    await page(`api/${slug}`, { title: specifier, description }, entries.map(entry => apiBody(entry, sourceLink)).join('\n\n'));

    portableApi += `\n## ${specifier}\n\n| Export | Use |\n| --- | --- |\n`;
    for (let { name, description } of entries)
      portableApi += `| \`${name}\` | ${description.split('\n\n')[0].replaceAll('\n', ' ').replaceAll('|', '\\|')} |\n`;
  }
  await page('api', { title: api.title }, `${siteLinks(api.body)}\n\n${imports.join('\n')}`);

  for (let [file, slug] of contributing) {
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
