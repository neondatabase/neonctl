# neon-launch-vercel

Reference config for `neon launch` against a Next.js + Drizzle + Vercel + Neon Postgres stack.

The interesting file is [`neon.ts`](./neon.ts). It declares three resources:

- `db` — a Neon Postgres branch, named after the current git branch.
- `migrate` — runs `npm run db:migrate` against `db` and exits.
- `dev` — runs `npm run dev` with `DATABASE_URL` wired to `db.connectionString`, waits for `http://localhost:3000` to answer.

Two unknown CLI flags drive the topology:

| Invocation              | What it provisions                                                   |
| ----------------------- | -------------------------------------------------------------------- |
| `neon launch`           | `db` → `migrate` → `dev`. Foreground until you Ctrl-C.               |
| `neon launch --preview` | `db` → a Vercel **preview** deploy scoped to the current git branch. |
| `neon launch --prod`    | `db` → a Vercel **production** deploy.                               |

Branch policy lives in your `neon.ts`, not in flags the CLI invents.

## Setup

You'll need an existing Next.js + Drizzle app in this directory (not included — drop your own in here, or `npx create-next-app@latest`). Then:

```bash
export NEON_API_KEY=...        # https://console.neon.tech/app/settings/api-keys
export NEON_PROJECT_ID=...     # from your Neon project settings
export VERCEL_TOKEN=...        # only for --preview / --prod

cd examples/neon-launch-vercel
neon launch
```

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

The detached-HEAD `pull_request` checkout requires `--branch "${{ github.head_ref }}"`; the launcher reads the branch from there.
