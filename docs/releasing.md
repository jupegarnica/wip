# Releasing wip

[← Back to the README](../README.md)

wip is published as one npm package, `@garndev/wip` (a JavaScript bundle for Node 22.13 or later, no
dependencies), by `.github/workflows/release.yml`, which also makes a GitHub Release with the CHANGELOG notes and
no assets. The root package `@garndev/wip-dev` is private and never published. The workflow builds no binaries:
`bun scripts/build.ts --targets …` still builds them locally (see [CLAUDE.md](../CLAUDE.md)).

Nothing here runs without the maintainer: pushing a tag is the maintainer's step. The `npm-publish` environment
has no required reviewers today, so GitHub does not pause the job; add them in the environment settings to gate
a publish.

## Versions and tags

- SemVer from `0.1.0`. While `0.x`: a minor bump for any database migration or breaking CLI change, a patch for
  fixes. A migration also gets an **Upgrade notes** entry in the CHANGELOG.
- The version lives in the root `package.json`; the build copies it into the npm package. The tag is `v<version>`;
  the release fails when they differ, when `CHANGELOG.md` has no `## <version>` section (an exact match:
  `## 0.1.0` or `## 0.1.0 (<date>)`, never `## 0.1.0-rc.1`), and when that heading still says `unreleased` (a dry
  run only warns).
- The tag is annotated and unsigned: `git tag -a v<version> -m "wip <version>"`. A signed tag (`git tag -s`) is
  optional and needs a GPG key the maintainer has configured (`user.signingkey`, `tag.gpgSign`); without one, use
  the annotated tag.
- Dist-tags: a stable version (`X.Y.Z`) goes to `latest`; a prerelease (`X.Y.Z-rc.N`, `-beta.N`) goes to `next` and
  its GitHub Release is marked as a prerelease.
- A bad release: `npm deprecate @garndev/wip@X.Y.Z "<reason>"`, move `latest` back
  (`npm dist-tag add @garndev/wip@<good> latest`), then publish a fixed patch. Unpublish only within npm's 72 hours
  and only for a release that is broken for everyone.

## What the release workflow does

Triggered by a pushed tag `v*`, or by hand (`workflow_dispatch`), which is always a dry run: a real release only
starts from a tag.

| Job              | Runs on                           | What                                                                                                                                                                                                                          |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`        | ubuntu                            | reads the version, checks the tag and the CHANGELOG section, picks `latest` or `next`                                                                                                                                         |
| `test`           | `ci.yml`, Ubuntu, Node 22         | typecheck, lint and `bun test`; packs the npm package and runs `npm publish --dry-run`; e2e against it on Node 22. The full matrix (Ubuntu 22/24/26, macOS 24, Windows 24) is the manual `test.yml`                           |
| `publish`        | ubuntu, environment `npm-publish` | `npm publish <the tested tarball> --access public --tag <latest\|next>` with the `NPM_TOKEN` secret (`--dry-run` in a dry run, in environment `npm-publish-dry-run`); `needs: [version, test]`: a red test blocks the publish |
| `github-release` | ubuntu, `contents: write`         | notes from the CHANGELOG section; `gh release create v<version>` with the notes and no assets (only printed in a dry run); a second run does nothing                                                                          |

Actions are pinned by commit SHA. Permissions default to `contents: read`; `github-release` adds `contents: write`.

The automatic testing is Ubuntu only and Node 22 only: `ci.yml` runs typecheck, lint, `bun test` and the package e2e
suite there for every pull request and for a release. The full
matrix (Ubuntu 22/24/26, macOS 24, Windows 24) runs only in `test.yml`, which is manual (`workflow_dispatch`). The
Windows suite is still red (path separators, the launcher spawn, the PowerShell recycle bin, SIGTERM in `wip web`):
the manual `Test` run shows that red and nothing gates on it.

## One-time setup (before the first release)

1. On npmjs.com, Access Tokens > Generate New Token > **Granular Access Token**:
   - name it `wip-ci` and give it the shortest expiration that covers your release cadence;
   - permissions: **Read and write**, on the **`@garndev` scope** (a scope token covers a package that does not
     exist yet; org access alone does not grant publishing);
   - **Bypass 2FA: on**. With a token, `npm publish` cannot answer an interactive 2FA challenge, so without this
     switch CI fails with `EOTP`;
   - no IP allowlist: GitHub runners have no fixed address.

2. Store the token as the `NPM_TOKEN` repository secret:

   ```sh
   gh secret set NPM_TOKEN        # paste the token at the prompt
   ```

3. In GitHub, Settings > Environments: `npm-publish` is referenced by the workflow and exists with no protection
   rules, so a run goes straight through and the pushed tag is the only gate. Adding the maintainer as required
   reviewer is optional (required reviewers on a private repository need a paid plan); with reviewers the job
   pauses for an approval. `npm-publish-dry-run` needs no reviewer; GitHub creates it on first use.

4. Rotate the token before it expires and update the secret; revoking it makes every release fail with `E401`.

## Trusted publishing (if the repository becomes public)

The token exists because the repository is private: npm attests provenance and trusted publishers only for public
builds. If `jupegarnica/wip` becomes public, switch over:

1. On npmjs.com, package settings: add a trusted publisher (GitHub Actions, repository `jupegarnica/wip`, workflow
   `release.yml`, environment `npm-publish`) and set "Require two-factor authentication and disallow tokens".
2. In `.github/workflows/release.yml`, add `id-token: write` to the `publish` job permissions, put `--provenance`
   back in `flags`, and remove `NODE_AUTH_TOKEN`.
3. Delete the `NPM_TOKEN` secret and revoke the token.

## Release checklist

1. The CHANGELOG section `X.Y.Z (unreleased)` lists the changes and, when the schema changes, an Upgrade notes
   entry.
2. Bump `version` in the root `package.json`, change the CHANGELOG heading to `## X.Y.Z (YYYY-MM-DD)`, commit
   `chore(release): X.Y.Z`.
3. Tag and push (the maintainer runs it):

   ```sh
   git tag -a vX.Y.Z -m "wip X.Y.Z" && git push origin vX.Y.Z
   ```

   The pushed tag is the release: `release.yml` runs the tests (`ci.yml`: typecheck, lint, `bun test`, and the e2e
   suite against the packed npm package) and then publishes the npm package and the GitHub Release. A red test
   blocks the publish. Running the workflow by hand (`workflow_dispatch`) is still a dry run, if you want to check
   something without publishing.
4. If `publish` waits on the `npm-publish` environment, approve it: that happens only when the environment has
   required reviewers, and today it has none.
5. Check the npm page and the GitHub Release: the CHANGELOG notes, and no assets.
6. On your own machine, from a throwaway prefix:

   ```sh
   npm i -g --prefix /tmp/wip-verify @garndev/wip@X.Y.Z
   /tmp/wip-verify/bin/wip --version
   ```

7. Open the next `## X.Y.(Z+1) (unreleased)` section in the CHANGELOG.

## First release

`0.2.0` was the first publish of `@garndev/wip` and went through the workflow like any other: the granular token is
scoped to `@garndev`, so the package does not have to exist beforehand. `0.2.1` was the first release with binaries
in the GitHub Release; from now on a Release carries the notes only, and no workflow builds binaries.
