# Working on the docs

The docs live in the source, right next to the code they explain. Each guide is a `@guide slug Page title` comment block, and the JavaScript API pages come from the JSDoc on each export. Add a new guide by writing its block and adding the slug to `site/navigation.js`.

Quote real code with `<!-- example examples/some-file.js -->` instead of pasting it. The site shows the file with its name on a tab, and `test/examples.test.js` makes sure it still works. The quickstart pulls in [examples/docs-start.js](../examples/docs-start.js), and most guides quote the [projects example app](../examples/projects/).

Write the way you'd explain it to a friend: plain words, short sentences, no filler. The [vision](../vision.md) covers why Cricket works the way it does.

```sh
pnpm install
pnpm docs:dev
pnpm docs:build
pnpm docs:test
```

After you change a guide, refresh the GitHub copies and commit them with the source:

```sh
pnpm --filter cricket-docs generate --write-markdown
```

Each page's search description is its intro: the prose before the first heading. So open every guide with a sentence or two that says what the page is for. Link previews use `site/public/og.png`, so update that card if the headline changes.

Restart the dev server after editing source comments. If code blocks look unstyled after changing the code theme, delete `site/.astro` first.

## Versions and publishing

Next builds from `main`. A published GitHub release builds from its exact tag, which has to match the version in `package.json`. The release gets a `cricket-docs-<tag>.tar.gz` asset with its HTML, search index, and commit info. Keep that asset with the release. To change published docs, cut a new version.

The Docs workflow downloads those archives and puts them next to Next. The homepage opens the latest stable release, or Next until there is one. Prereleases show up in the version picker. Each version has its own search, and switching versions takes you to that version's homepage.

To turn on deploys, set GitHub Pages to **GitHub Actions** and set the repository variable `CRICKET_DOCS_DEPLOY` to `true`. The workflow uploads a site artifact on `main` even before that.

The site lives at `/cricket/` by default. To serve it somewhere else, set the repository variable `CRICKET_DOCS_PATH` before the first release, and use the same path for local builds when you test it. Local builds go to `site/dist`, and the assembled site goes to `site/published`.

## Check search and version switching

```sh
pnpm --filter cricket-docs exec playwright-core install chromium
pnpm --filter cricket-docs test:browser
```
