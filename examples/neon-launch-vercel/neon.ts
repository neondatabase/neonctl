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
 *
 * Vercel project lookup: `spec.project` below resolves to a project the
 * launcher GETs via `/v9/projects/<name>` on first run. The resolved id +
 * name are persisted to `.neon-launch.env` so subsequent runs skip the
 * lookup — that's a cache: `VERCEL_PROJECT_ID` / `VERCEL_PROJECT_NAME`
 * only short-circuit the lookup when they match `spec.project`. The cache
 * does NOT bypass an unset / wrong `spec.project`; you must edit the
 * `project:` line below first.
 *
 * Commit `.neon-launch.env` only if your team shares the same Vercel project.
 */
import {
  localCommand,
  postgres,
  stack,
  vercelDeployment,
} from 'neonctl/config';

// Neon branch names accept [a-z0-9_-] but not '/' or other separators
// most git branches contain (`feature/foo`, `dependabot/npm_and_yarn/...`).
// Slugify on the way in so the launcher doesn't 4xx on a feature branch.
//
// Throws on empty input. Without this, an empty `ctx.gitBranch` (no git
// repo, no --branch, no env override) would slugify to '' and the
// launcher's `findBranchByName` would silently return the project's
// default Neon branch (typically the production branch named `main` or
// `production`) — and the launcher would run migrations + dev traffic
// against production data. Fail fast instead.
const slugifyBranch = (b: string) => {
  const slug = b.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  if (!slug) {
    throw new Error(
      '[neon-launch-vercel] No git branch detected and no --branch flag passed. ' +
        'Pass `--branch <name>` explicitly so the per-PR Neon branch does not collide ' +
        "with the project's default branch.",
    );
  }
  return slug;
};

export default stack({
  spec: (_, { gitBranch, flags }) => {
    const db = postgres({
      spec: () => ({
        // Per-branch Neon branch named after the git branch — the launcher
        // reuses it across runs, or forks from the project's default
        // branch on first run.
        name: slugifyBranch(gitBranch),
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
      // CHANGE-ME: replace with the Vercel project name (or id) you own,
      // then delete this guard. Without it a fresh `npx neonctl launch
      // --preview` would hit Vercel's /v9/projects 404 with no pointer
      // back to the line the user actually needs to edit.
      const vercelProject = 'CHANGE-ME-IN-NEON-TS';
      if (vercelProject === 'CHANGE-ME-IN-NEON-TS') {
        throw new Error(
          '[neon-launch-vercel] examples/neon-launch-vercel/neon.ts: edit `vercelProject` ' +
            'to the name of a Vercel project you own (create one at vercel.com/new), ' +
            'then delete this guard.',
        );
      }
      const web = vercelDeployment({
        // `migrate` listed for ordering: Vercel must deploy against an
        // already-migrated branch or the running app would hit an
        // unmigrated schema on first request.
        dependsOn: { db, migrate },
        spec: ({ db }) => ({
          project: vercelProject,
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
