# Working on the docs

Edit guides in the JavaScript JSDoc next to the code they explain. Add a new guide with `@guide slug Page title` and put its slug in `site/navigation.js`. Use regular JSDoc on public exports for the JavaScript API reference. The site reads the export map in `package.json`, shows signatures from the implementation, and links to the exact source commit.

The quickstart pulls in [the runnable example](../examples/docs-start.js). The CLI page runs Cricket to get the usage text. Use [the project vision](../vision.md) for design decisions.

```sh
pnpm install
pnpm docs:dev
pnpm docs:build
pnpm docs:test
```

After changing source docs, refresh the GitHub copies and commit them with the source.

```sh
pnpm --filter cricket-docs generate --write-markdown
```

Restart the dev server after editing source comments. Generated site files and build output are ignored.

## Version and publish

Next builds from `main`. A published GitHub release builds from its exact tag, which must match the version in `package.json`. The release gets a `cricket-docs-<tag>.tar.gz` asset with its HTML, search index, and commit metadata. Keep that asset with the release. Cut a new version to change published docs.

The Docs workflow downloads those archives and puts them alongside Next. The homepage opens the latest stable release, or Next until the first stable release is ready. Prereleases are in the version picker. Each version has its own search index, and switching versions takes you to that version's homepage.

Set GitHub Pages to **GitHub Actions** and set the repository variable `CRICKET_DOCS_DEPLOY` to `true` to turn on deploys. The workflow uploads a site artifact on `main` even before deploys are enabled.

The default base path is `/cricket/`. To serve the site elsewhere, set the repository variable `CRICKET_DOCS_PATH` before the first release. Use the same path for local builds when testing that setup. Local builds go to `site/dist`, and the assembled site goes to `site/published`.

## Check search and version switching

```sh
pnpm --filter cricket-docs exec playwright-core install chromium
pnpm --filter cricket-docs test:browser
```
