# Releasing Cricket

Releases go out through GitHub. You publish a GitHub release, CI checks it and stages it on npm, and then you approve it with 2FA. Nothing reaches npm without a person signing off, and there's no npm token sitting in the repo's secrets.

## How versions work

Cricket follows semver. While it's on `0.x`, a breaking change bumps the minor version (`0.1.0` to `0.2.0`) and everything else bumps the patch. Prereleases like `1.0.0-rc.1` publish under npm's `next` tag, so `pnpm add @robdel12/cricket` always installs the latest stable version.

## Cut a release

1. **Bump the version in a PR.** Run `pnpm version 0.2.0 --no-git-tag-version`, open a PR, and merge it into `main`.
2. **Publish a GitHub release.** Draft a release with a new tag that matches the version (`v0.2.0`), targeting `main`. Click **Generate release notes** and tidy them up. Tick **Set as a pre-release** for release candidates. Then publish it.
3. **Let CI do its thing.** Publishing the release kicks off two workflows:
   - **Release package** checks that the tag matches `package.json` and sits on `main`, runs every test, and stages the package on npm with provenance.
   - **Release documentation** builds that version's docs and attaches them to the release. The Docs workflow then deploys them, and the docs homepage switches to the newest stable version.
4. **Approve it on npm.** Run `npm stage list @robdel12/cricket` to find the staged version, then `npm stage approve <stage-id>`. You can also approve it from the **Staged Packages** tab on npmjs.com. Either way npm asks for your 2FA code.
5. **Check it landed.** `npm view @robdel12/cricket version` should show the new version, and its npm page should show a provenance badge linking back to the workflow run.

## When something goes wrong

- **The workflow fails before staging.** Nothing reached npm. Fix the problem, delete the release and its tag, and publish the release again.
- **You staged something you don't want.** Run `npm stage reject <stage-id>`. It never goes live.
- **A bad version went live.** Run `npm deprecate @robdel12/cricket@0.2.0 "Use 0.2.1 instead"` and ship a patch. Avoid `npm unpublish`. It breaks anyone who already installed that version.

Release docs are frozen once they're attached to a release. To change them, ship a new version.

## The first release

This is a one-time setup, because npm can only trust a workflow for a package that already exists.

1. **Turn on 2FA** for your npm account if it isn't already, and run `npm login`.
2. **Create the package.** Stage a throwaway version so the real one can still come from CI with provenance. From a clean checkout of `main`:

   ```sh
   npm version 0.0.0-bootstrap.0 --no-git-tag-version
   npm stage publish --tag bootstrap
   git checkout package.json
   ```

   Since the package doesn't exist yet, npm creates it with a placeholder `0.0.0-stage` version and holds the bootstrap version for review. Reject it with `npm stage reject <stage-id>`. If npm won't stage a brand-new package, run `npm publish --tag bootstrap` with the same throwaway version instead, then `npm deprecate @robdel12/cricket@0.0.0-bootstrap.0 "Not a real release"`.
3. **Trust the release workflow.** On npmjs.com, open the package's **Settings**, then **Trusted publishing**, and add a GitHub Actions publisher:
   - Owner: `Robdel12`
   - Repository: `cricket`
   - Workflow filename: `release.yml`
   - Environment: leave it empty
   - Allowed actions: keep the default, `npm stage publish` only

   The new publisher expires if it doesn't publish within 2 days, so do the next step right away. If it does expire, delete it and add it again.
4. **Cut the release** using the steps above.
5. **Lock it down.** Once CI has published, go to **Settings**, then **Publishing access**, and pick **Require two-factor authentication and disallow tokens**. From then on, the only way to ship is a GitHub release plus your approval.
