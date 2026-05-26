/**
 * `neon launch` config — Next.js + Drizzle + Vercel + Neon Postgres.
 *
 * Run from this directory:
 *
 *   neon launch                   # local dev (no Vercel deploy)
 *   neon launch --preview         # preview deploy to Vercel
 *   neon launch --prod            # production deploy
 *
 * Required env (set in your shell or a non-committed dotenv loader):
 *   NEON_API_KEY        — from https://console.neon.tech/app/settings/api-keys
 *   NEON_PROJECT_ID     — from your project's settings page
 *   VERCEL_TOKEN        — only for --preview / --prod
 *   VERCEL_PROJECT_ID   — auto-resolved by `neon launch` on first run
 *
 * The launcher writes resolved Vercel ids back to `.neon-launch.env` so
 * subsequent runs skip the lookup. Commit `.neon-launch.env` only if your
 * team shares the same Vercel project.
 */
import {
  localCommand,
  postgres,
  stack,
  vercelDeployment,
} from 'neonctl/config';

export default stack({
  spec: (_, { gitBranch, flags }) => {
    const db = postgres({
      spec: () => ({
        // Per-branch Neon branch named after the git branch — the launcher
        // reuses it across runs, or forks from the project's default
        // branch on first run.
        name: gitBranch || 'main',
        compute: { minCu: 0.25, maxCu: 1 },
      }),
    });

    // `--prod` and `--preview` are boolean flags; the launcher exposes
    // them on `ctx.flags`. Both `--prod` and `--prod=true` arrive as
    // `true`; `--no-prod` and `--prod=false` arrive as `false`.
    const prod = flags.prod === true;
    const preview = flags.preview === true;

    // Apply schema migrations to the per-branch Neon branch BEFORE
    // anything that serves traffic. `onExit: 0` makes the launcher wait
    // for `db:migrate` to finish before starting dependents.
    const migrate = localCommand({
      dependsOn: { db },
      spec: ({ db }) => ({
        command: 'npm run db:migrate',
        env: { DATABASE_URL: db.connectionString },
        readiness: { onExit: 0 },
      }),
    });

    if (prod || preview) {
      const web = vercelDeployment({
        // `migrate` listed for ordering: Vercel must deploy against an
        // already-migrated branch or the running app would hit an
        // unmigrated schema on first request.
        dependsOn: { db, migrate },
        spec: ({ db }) => ({
          project: 'neon-launch-vercel-demo',
          production: prod,
          env: {
            DATABASE_URL: db.connectionString({ pooled: true }),
          },
        }),
      });
      return { db, migrate, web };
    }

    // Local dev — run `next dev` with the migrated branch's connection.
    const dev = localCommand({
      // Same ordering trick as the Vercel path: migrate must finish
      // before dev starts so the dev server boots against a ready DB.
      dependsOn: { db, migrate },
      spec: ({ db }) => ({
        command: 'npm run dev',
        env: { DATABASE_URL: db.connectionString },
        readiness: { httpGet: { url: 'http://localhost:3000' } },
      }),
    });
    return { db, migrate, dev };
  },
});
