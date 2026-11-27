import semver from 'semver';

export function settings(environment = process.env) {
  let version = environment.CRICKET_DOCS_VERSION ?? 'next';
  if (version !== 'next' && (!version.startsWith('v') || semver.valid(version) !== version.slice(1)))
    throw new Error('CRICKET_DOCS_VERSION must be next or a release tag such as v0.1.0.');

  let path = environment.CRICKET_DOCS_PATH ?? '/cricket/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(path))
    throw new Error('CRICKET_DOCS_PATH must be an absolute directory path, such as /cricket/.');

  return { version, path, base: `${path}${version}/` };
}

/** The package spec readers install: the repo for Next, or that release from npm. */
export function installSource(version) {
  return version === 'next' ? 'github:Robdel12/cricket' : `@robdel12/cricket@${version.slice(1)}`;
}
