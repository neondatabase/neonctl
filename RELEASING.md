# Releasing neonctl

`neonctl` ships to npm via a two-stage pipeline:

- **Stage 1 (this repo)** — `prepare-release.yml` bumps the version and opens a release PR; on merge, `post-release.yml` tags the commit and comments the Stage 2 command.
- **Stage 2 (`databricks/secure-public-registry-releases-eng`)** — checks out the tag, builds, scans the tarball, and publishes to npm via OIDC trusted publishing.

Stage 2 lives in the central repo because only its runners have the npm publish trust relationship. (External contributors: that repo is internal — open an issue and a maintainer will cut the release.)

## Prerequisites

- **admin** or **maintain** on `neondatabase/neonctl` (Stage 1).
- Write access to `databricks/secure-public-registry-releases-eng` (Stage 2).

## Cut a release

**1. Dispatch Stage 1:**

```bash
gh workflow run prepare-release.yml --repo neondatabase/neonctl --ref main -f bump=patch
```

`bump` is `patch` | `minor` | `major`. For a prerelease, pass `-f version=2.23.0-beta.1` instead. This opens a draft PR titled `chore: release neonctl@vX.Y.Z`.

**2. Merge it:** mark **Ready for review** (drafts can't be merged), approve, wait for checks, then **Squash and merge** by hand — not auto-merge (a human merge is what fires `post-release.yml`). Don't edit the PR title.

**3. `post-release.yml`** runs automatically: tags `vX.Y.Z` on the merge commit and comments the Stage 2 command.

**4. Dispatch Stage 2** (copy from the PR comment, or):

```bash
gh workflow run release-neondatabase-neonctl.yml \
  --repo databricks/secure-public-registry-releases-eng \
  --ref main -f ref=vX.Y.Z -f dry-run=true   # set dry-run=false to publish for real
```

**5. Verify** at <https://www.npmjs.com/package/neonctl>.

## Recovery

- **PR not merged yet** — close it, fix on `main`, re-dispatch `prepare-release.yml`.
- **Tag created, Stage 2 not run** — `git push origin :refs/tags/vX.Y.Z`, then re-run the `post-release.yml` run from the Actions tab.
- **Already published** — npm versions are immutable; cut a new patch rather than reverting.
