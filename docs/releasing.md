# Releasing wip

wip is published as one npm package, `@garndev/wip` (a JavaScript bundle for Node 22.13 or later, no
dependencies), by `.github/workflows/release.yml`, which also makes a GitHub Release with the CHANGELOG notes and no
assets. The root package `@garndev/wip-dev` is private and never published. The standalone binaries are not built or
released by CI: `bun scripts/build.ts --targets …` builds them locally (see the README, Development), and
`docs/future-improvements.md` ("Binaries in the release") describes how to add them back to the release.

Nothing here runs without the maintainer: pushing a tag, approving the `npm-publish` environment and making the repo
public are the maintainer's steps.

## Versions and tags

- SemVer from `0.1.0`. While `0.x`: a minor bump for any database migration or breaking CLI change, a patch for
  fixes. A migration also gets an **Upgrade notes** entry in the CHANGELOG.
- The version lives in the root `package.json`; the build copies it into the npm package. The tag is `v<version>`;
  the release fails when they differ, when `CHANGELOG.md` has no `## <version>` section (an exact match:
  `## 0.1.0` or `## 0.1.0 (<date>)`, never `## 0.1.0-rc.1`), and when that heading still says `unreleased` (a dry
  run only warns).
- Dist-tags: a stable version (`X.Y.Z`) goes to `latest`; a prerelease (`X.Y.Z-rc.N`, `-beta.N`) goes to `next` and
  its GitHub Release is marked as a prerelease.
- A bad release: `npm deprecate @garndev/wip@X.Y.Z "<reason>"`, move `latest` back
  (`npm dist-tag add @garndev/wip@<good> latest`), then publish a fixed patch. Unpublish only within npm's 72 hours
  and only for a release that is broken for everyone.

## What the release workflow does

Triggered by a pushed tag `v*`, or by hand (`workflow_dispatch`) with `dry_run` (default `true`; a real release only
starts from a tag).

| Job              | Runs on                                       | What                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`        | ubuntu                                        | reads the version, checks the tag and the CHANGELOG section, picks `latest` or `next`                                                                                                                |
| `test`           | `ci.yml`                                      | typecheck, lint, `bun test` on 3 OSes; packs the npm package, `npm publish --dry-run`; e2e against it on Node 22, 24, 26 (Linux) and 24 (macOS, Windows)                                             |
| `publish`        | ubuntu, environment `npm-publish`             | `npm publish <the tested tarball> --access public --provenance --tag <latest\|next>` (`--dry-run` in a dry run, in environment `npm-publish-dry-run`)                                                |
| `github-release` | ubuntu, `contents: write`                     | notes from the CHANGELOG section, `gh release create v<version>` with no assets (only printed in a dry run)                                                                                          |
| `verify`         | Node 22, 24, 26 (ubuntu), 24 (macOS, Windows) | not in a dry run: `npm i -g @garndev/wip@<version>` from the registry, `--version`, `npm audit signatures`, `init`, `check`, `state --json`, `web` `/health`, and no `ExperimentalWarning` on stderr |

Actions are pinned by commit SHA. Permissions default to `contents: read`; `publish` adds `id-token: write`
(trusted publishing and provenance), `github-release` adds `contents: write`.

## One-time setup (before the first release)

1. Make the repository public: npm provenance needs it.
2. In GitHub, Settings > Environments: create `npm-publish` with the maintainer as required reviewer. (`npm-publish-dry-run`
   needs no reviewer; GitHub creates it on first use.)
3. The first publish of `@garndev/wip` is done by hand, because npm configures a trusted publisher only for a package
   that exists. From a terminal logged in to npm with 2FA, on the release commit:

   ```sh
   bun install --frozen-lockfile
   bun scripts/build.ts --out dist --pack
   npm publish dist/garndev-wip-<version>.tgz --access public --tag next   # 0.1.0-rc.1 goes to next
   ```

4. On npmjs.com, package settings: add a trusted publisher (GitHub Actions, repository `jupegarnica/wip`, workflow
   `release.yml`, environment `npm-publish`) and set "Require two-factor authentication and disallow tokens". From then
   on only the workflow publishes; no token is stored anywhere.

## Release checklist

1. `ci.yml` is green on the release branch. The CHANGELOG section `X.Y.Z (unreleased)` lists the changes and, when
   the schema changes, an Upgrade notes entry.
2. Bump `version` in the root `package.json`, change the CHANGELOG heading to `## X.Y.Z (YYYY-MM-DD)`, commit
   `chore(release): X.Y.Z`.
3. Local dry run, on that commit:

   ```sh
   bun run typecheck && bun run lint && bun test
   bun scripts/build.ts --out dist --pack
   npm publish --dry-run dist/npm/wip      # lists LICENSE, README.md, bin/wip.mjs, dist/wip.mjs, package.json
   WIP_TEST_BIN=$PWD/dist/npm/wip/bin/wip.mjs bun test test/e2e
   WIP_PACK_DIR=$(mktemp -d) bun test test/e2e/pack.test.ts
   ```

4. Run `release.yml` by hand (Actions > Release > Run workflow) on the release branch with `dry_run` checked. Every
   job must pass; `verify` is skipped.
5. Tag and push (the maintainer runs it): `git tag -s vX.Y.Z -m "wip X.Y.Z" && git push origin vX.Y.Z`.
6. Approve the `npm-publish` environment when `publish` waits.
7. Check the `verify` job, the npm page (provenance badge) and the GitHub Release (notes).
8. On your own machine, from a throwaway prefix:

   ```sh
   npm i -g --prefix /tmp/wip-verify @garndev/wip@X.Y.Z
   /tmp/wip-verify/bin/wip --version
   ```

9. Open the next `## X.Y.(Z+1) (unreleased)` section in the CHANGELOG.

## First release

`0.1.0-rc.1` on `next` (published by hand, step 3 of the setup, then the trusted publisher), then `0.1.0` on `latest`
through the workflow.
