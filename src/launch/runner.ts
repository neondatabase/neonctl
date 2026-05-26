/**
 * Runner — orchestrates plan + provisioning + foreground phase.
 *
 * This file will get its real body in Phase 6 (impl-plan.md). For now it's
 * a thin scaffold so `src/commands/launch.ts` compiles and a stub `neon
 * launch` invocation can prove the CLI wiring + Node-22 guard work
 * end-to-end ahead of the plan/provisioner work in Phases 4–5.
 */
import { log } from '../log.js';
import { buildLaunchContext } from './context.js';

export type LaunchRunOptions = {
  configPath: string;
  branchFlag?: string;
  branchTimeoutSeconds: number;
  yes: boolean;
  argv: Record<string, unknown>;
  recognizedFlags: ReadonlySet<string>;
};

export function runLaunch(opts: LaunchRunOptions): Promise<void> {
  const ctx = buildLaunchContext({
    argv: opts.argv,
    recognizedFlags: opts.recognizedFlags,
    branchFlag: opts.branchFlag,
    processEnv: process.env,
    cwd: process.cwd(),
  });

  log.info(`neon launch — gitBranch=${ctx.gitBranch || '(none)'}`);
  log.info(`  config=${opts.configPath}`);
  log.info(`  flags=${JSON.stringify(ctx.flags)}`);
  log.info('  (Plan + provisioning come in Phases 4–6 of the impl-plan.)');

  // Real flow lands here:
  //   1. loadStack(opts.configPath) — Phase 4 (jiti, walk, invariants).
  //   2. provision in topo order — Phase 5.
  //   3. foreground phase + Ctrl-C — Phase 6.
  return Promise.resolve();
}
