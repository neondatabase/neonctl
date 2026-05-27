# neon-launch-vercel

Reference config for `neon launch` against a Next.js + Drizzle + Vercel + Neon Postgres stack.

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

Branch policy lives in your `neon.ts`, not in flags the CLI invents.

## Setup

You'll need an existing Next.js + Drizzle app in this directory (not included — drop your own in here, or `npx create-next-app@latest`). Then:

```bash
cd examples/neon-launch-vercel
npm install                    # installs `neonctl` so jiti can resolve `neonctl/config`

export NEON_API_KEY=...        # https://console.neon.tech/app/settings/api-keys
export NEON_PROJECT_ID=...     # from your Neon project settings
export VERCEL_TOKEN=...        # only for --preview / --prod

npx neon launch                # or: ./node_modules/.bin/neon launch
```

`.neon-launch.env` (where the launcher persists resolved Vercel ids and the like) is written at your git repo root, not next to this `neon.ts`. Commit it if your team shares the same Vercel project; otherwise add it to `.gitignore`.

## Heads-up: dotenv files and `DATABASE_URL`

`drizzle-kit` and Next.js auto-load `.env.local` / `.env` via their own dotenv plumbing. If you commit a `DATABASE_URL` to one of those files it will override the one `neon launch` injects on the child process. Let the launcher own `DATABASE_URL`; keep `.env*` files for other config.

## CI (GitHub Actions)

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
