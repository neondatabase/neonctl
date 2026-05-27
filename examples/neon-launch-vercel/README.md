# neon-launch-vercel

Reference config for `neon launch` against a Next.js + Drizzle + Vercel + Neon Postgres stack.

> **From-source until release.** This example imports `neonctl/config`, a
> subpath export added in the PR that introduces `neon launch`. The
> example's `package.json` resolves `neonctl` to `file:../../dist` so
> that `npm install` symlinks the local build output (you must
> `bun install && bun run build` in the neonctl repo root first — the
> `dist/` directory IS the publishable package shape, with `cli.js` at
> its root and a copy of `package.json` carrying the `bin` entries).
> Once a released version with `./config` exposed ships to npm, the
> `file:` reference will be replaced with a pinned `^X.Y.Z` and a
> top-level `npm install neonctl` will work.

The interesting file is [`neon.ts`](./neon.ts). It declares three resources:

- `db` — a Neon Postgres branch, named after the current git branch.
- `migrate` — runs `npm run db:migrate` against `db` and exits.
- `dev` — runs `npm run dev` with `DATABASE_URL` wired to `db.connectionString`, waits for `http://localhost:3000` to answer.

Two unknown CLI flags drive the topology:

| Invocation              | What it provisions                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `neon launch`           | `db` → `migrate` → `dev`. Foreground until you Ctrl-C.                                                                             |
| `neon launch --preview` | `db` → `migrate` → a Vercel **preview** deployment. Env vars upserted with `target: ['preview']` scoped to the current git branch. |
| `neon launch --prod`    | `db` → `migrate` → a Vercel **production** deployment. Env vars upserted with `target: ['production']`.                            |

`migrate` runs in every flow so the Neon branch is at the right schema before any code reads it (Vercel deploys against an unmigrated branch would crash on first request).

The deploy URLs returned are the deployment's own immutable `<id>.vercel.app` host (production deploys may have their canonical custom domain alias auto-assigned). The Vercel dashboard's "per-branch preview" aliases (`<project>-git-<branch>.vercel.app`) are a property of **git-connected** Vercel projects; this example uses Vercel's file-upload deployment API so those aliases won't appear unless you've also wired your repo to the Vercel project on the dashboard side.

## Setup

Prerequisites:

1. **Node 22+** (`node --version`). `neon launch` uses `jiti`'s native TS support, which requires Node 22.
2. **A git repo or an explicit `--branch` flag.** The example reads `ctx.gitBranch` to name the per-PR Neon branch. If you copy this example outside a git tree, either run `git init && git checkout -b dev` first, or always pass `--branch <name>`.
3. **A Next.js + Drizzle app alongside this config.** This directory is config-only — `neon.ts` + `package.json` (carrying `"neonctl": "file:../../dist"`) are the only files that matter for the launcher; the migrations and dev server come from your own app. `create-next-app .` would overwrite the shipped `package.json` and drop the neonctl devDep, so scaffold in a sibling directory and copy the launcher files over:

   ```bash
   # scaffold your Next.js app in a sibling temp dir (any name)
   cd /tmp
   npx create-next-app@latest neon-launch-demo --typescript --no-eslint --no-tailwind --app --no-src-dir --no-import-alias
   cd neon-launch-demo
   npm install drizzle-orm drizzle-kit pg

   # bring the launcher config + devDep over (merging package.json by hand)
   cp <neonctl-checkout>/examples/neon-launch-vercel/neon.ts .
   # add "neonctl": "file:<neonctl-checkout>/dist" to your package.json's devDependencies
   # add the scripts below to your package.json
   ```

   Required `package.json` additions:

   ```json
   "scripts": {
     "dev": "next dev",
     "db:migrate": "drizzle-kit migrate"
   },
   "devDependencies": {
     "neonctl": "file:/absolute/path/to/neonctl/dist"
   }
   ```

   …plus the minimal `drizzle.config.ts` / `schema.ts` from the [Drizzle quickstart](https://orm.drizzle.team/docs/get-started-postgresql). The migration step can be any one-shot that exits 0 — `psql -f schema.sql`, a custom `node` script, anything; we use Drizzle here because it's the most common choice.

4. **A Vercel project** (only for `--preview` / `--prod`). Create one at <https://vercel.com/new>, then **edit the `vercelProject` constant in `neon.ts`** (currently `'CHANGE-ME-IN-NEON-TS'`) to match its name. `VERCEL_PROJECT_ID` is a _cache_ of the resolved id, not a bypass — the launcher still reads `vercelProject` and validates it against the cache before skipping the API lookup.

Then, from the scaffolded `neon-launch-demo` directory (the cwd where you ran `cp neon.ts .` above) — NOT from the original `examples/neon-launch-vercel` checkout, whose `file:../../dist` path only resolves inside the neonctl repo:

```bash
npm install                    # picks up neonctl from `file:../../dist` (local build output)

export NEON_API_KEY=...        # https://console.neon.tech/app/settings/api-keys
export NEON_PROJECT_ID=...     # from your Neon project settings
export VERCEL_TOKEN=...        # only for --preview / --prod

npx neonctl launch             # or: ./node_modules/.bin/neonctl launch
```

`.neon-launch.env` (where the launcher persists resolved Vercel ids and the like) is written at your git repo root, not next to this `neon.ts`. Commit it if your team shares the same Vercel project; otherwise add it to `.gitignore`.

Branch policy: the Neon branch name is derived from your current git branch (slugified). Want to deploy a hotfix branch from CI? Pass `--branch hotfix-123 --preview` — the launcher uses that name for the Neon branch AND for Vercel's preview env-var scoping.

## Heads-up: dotenv files and `DATABASE_URL`

`drizzle-kit` and Next.js auto-load `.env.local` / `.env` via their own dotenv plumbing. If you commit a `DATABASE_URL` to one of those files it will override the one `neon launch` injects on the child process. Let the launcher own `DATABASE_URL`; keep `.env*` files for other config.

## CI (GitHub Actions)

> The example's `"neonctl": "file:../../dist"` only resolves inside the
> neonctl checkout — `npm ci` in your own repo cannot follow that path.
> Replace the `file:` reference with a pinned `neonctl@^X.Y.Z` (once
> released) before checking this workflow into your repo.

```yaml
name: preview
on: pull_request
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npx neonctl launch --preview --branch "${{ github.head_ref }}"
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
          NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          # VERCEL_TEAM_ID:  ${{ secrets.VERCEL_TEAM_ID }}  # only for team projects
```

`neonctl` must be a `devDependency` in your repo so `npx neonctl` resolves under `node_modules/.bin`. If it isn't, swap `npx neonctl` for `npx neonctl@latest` (slower per-job cold start, but no install required).

The detached-HEAD `pull_request` checkout requires `--branch "${{ github.head_ref }}"`; the launcher reads the branch from there.
