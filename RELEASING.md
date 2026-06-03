# Releasing neonctl

`neonctl` is published to npm via a two-stage hardened pipeline:

| Stage   | Where                                              | What it does                                                                                               |
| ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Stage 1 | this repo                                          | Bump version, open release PR, tag the merge, post handoff instructions.                                   |
| Stage 2 | `databricks/secure-public-registry-releases-eng`\* | Check out the tag, build, scan the artifact, publish via npm OIDC, attach native binaries to a GH release. |

\* Stage 2 publishes from the central `secure-public-registry-releases-eng` repo because its runner pool has the egress + OIDC trust relationship npm requires for [Trusted Publishing](https://docs.npmjs.com/trusted-publishers).

> **External contributors:** Stage 2 lives in an internal repo that isn't publicly reachable. If you need a release cut from an outside contribution, open a GitHub issue and a maintainer will run Stage 2.

## Prerequisites (one time)

- Be an **admin or maintain** collaborator on `neondatabase/neonctl` (gates Stage 1).
- Have write access to `databricks/secure-public-registry-releases-eng` (gates Stage 2 dispatch).

## Cutting a release

### 1. Dispatch Stage 1

```bash
# Use patch, minor, or major for the bump input.
gh workflow run prepare-release.yml \
  --repo neondatabase/neonctl \
  --ref main \
  -f bump=patch
```

Inputs:

- `bump` — `patch` | `minor` | `major`. Ignored if `version` is set.
- `version` — full custom version (e.g. `2.23.0-beta.1`); overrides `bump`. Use this to cut a prerelease.
- `ref` — branch to release from. Defaults to `main`. Raw SHAs are rejected.

The workflow opens a **draft** PR titled `chore: release neonctl@vX.Y.Z`.

### 2. Review and merge the release PR

- Click **Ready for review** to take the PR out of draft — GitHub won't let you merge a draft PR.
- Approve the PR.
- Wait for required checks.
- Click **Squash and merge** manually in the UI. **Do not enable auto-merge.**

> Why manual merge? GitHub Actions suppresses downstream `on: push` workflows for pushes caused by `GITHUB_TOKEN` (including auto-merge enabled from a workflow). A human clicking merge attributes the push to that user, so `post-release.yml` fires.

Do not edit the PR title or add `[skip ci]` markers — `post-release.yml` parses the commit subject for the version token.

### 3. `post-release.yml` runs automatically

On the squash-merge push, it:

1. Parses `neonctl@vX.Y.Z` from the commit subject.
2. Creates and pushes the `vX.Y.Z` git tag on the merge commit.
3. Comments on the merged PR with the Stage 2 dispatch command.

### 4. Dispatch Stage 2 (npm publish)

Copy the command from the PR comment, or:

```bash
# Dry run first:
gh workflow run release-neondatabase-neonctl.yml \
  --repo databricks/secure-public-registry-releases-eng \
  --ref main \
  -f ref=vX.Y.Z \
  -f dry-run=true

# Real publish:
gh workflow run release-neondatabase-neonctl.yml \
  --repo databricks/secure-public-registry-releases-eng \
  --ref main \
  -f ref=vX.Y.Z \
  -f dry-run=false
```

Stage 2 scans the tarball, then publishes to npm and attaches the native binaries (linux x64/arm64, macOS x64, Windows x64) to the GitHub release.

### 5. Verify

- npm: <https://www.npmjs.com/package/neonctl>
- GitHub release: `https://github.com/neondatabase/neonctl/releases/tag/vX.Y.Z`

## Recovery

- **Stage 1 PR not yet merged** — close it, fix on `main`, re-dispatch `prepare-release.yml`.
- **Tag created, Stage 2 not yet run** — delete the bad tag with `git push origin :refs/tags/vX.Y.Z`, then open the original `post-release.yml` run in the Actions tab and click **Re-run all jobs**.
- **Stage 2 published to npm** — npm versions are immutable. Cut a new patch release rather than reverting.
