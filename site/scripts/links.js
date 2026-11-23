import { access, glob, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'parse5';

export async function checkLinks(directory, base) {
  let pages = new Map();
  for await (let path of glob('**/*.html', { cwd: directory })) {
    let ids = new Set();
    let links = [];
    function visit(node) {
      for (let { name, value } of node.attrs ?? []) {
        if (name === 'id') ids.add(value);
        if (['href', 'src'].includes(name)) links.push(value);
      }
      for (let child of node.childNodes ?? []) visit(child);
    }
    visit(parse(await readFile(join(directory, path), 'utf8')));
    pages.set(path, { ids, links });
  }
  for (let [path, { links }] of pages) {
    for (let href of links) {
      let url = new URL(href, `https://docs.invalid${base}${path}`);
      if (url.origin !== 'https://docs.invalid') continue;
      if (url.pathname === new URL('..', `https://docs.invalid${base}`).pathname) continue;
      if (!url.pathname.startsWith(base)) throw new Error(`Docs link leaves version in ${path}: ${href}`);
      let target = decodeURIComponent(url.pathname.slice(base.length));
      if (!target || target.endsWith('/')) target += 'index.html';
      let page = pages.get(target);
      if (!page) {
        try { await access(join(directory, target)); }
        catch { throw new Error(`Broken docs link in ${path}: ${href}`); }
      }
      if (page && url.hash && !page.ids.has(decodeURIComponent(url.hash.slice(1))))
        throw new Error(`Missing docs anchor in ${path}: ${href}`);
    }
  }
}
