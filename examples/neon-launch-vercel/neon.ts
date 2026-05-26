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

    if (prod || preview) {
      const web = vercelDeployment({
        dependsOn: { db },
        spec: ({ db }) => ({
          project: 'neon-launch-vercel-demo',
          production: prod,
          env: {
            DATABASE_URL: db.connectionString({ pooled: true }),
          },
        }),
      });
      return { db, web };
    }

    // Local dev — run drizzle migrations against the per-branch Neon
    // branch, then start `next dev` with the same connection string.
    const migrate = localCommand({
      dependsOn: { db },
      spec: ({ db }) => ({
        command: 'npm run db:migrate',
        env: { DATABASE_URL: db.connectionString },
        readiness: { onExit: 0 },
      }),
    });
    const dev = localCommand({
      // `migrate` appears in dependsOn purely for ordering — its outputs
      // aren't read (local commands have no outputs in v1). The launcher
      // waits for migrate's onExit readiness before starting dev.
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
