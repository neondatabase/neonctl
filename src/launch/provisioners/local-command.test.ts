/**
 * Local-command provisioner — covers the load-bearing branches of the
 * process lifecycle (spawn, readiness modes, line buffering, kill).
 *
 * Tests use real `spawn` via `node -e` / `node -p` so we exercise the
 * production code paths end-to-end (signals, exit codes, line chunking).
 * Cheap and deterministic: each test spawns a one-shot subprocess that
 * exits within milliseconds.
 *
 * `portListening` and `httpGet` readiness are NOT covered here — they
 * require real TCP/HTTP scaffolding that would slow the suite without
 * adding much over the unit-test value of the simpler readiness modes.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../pkg.ts', () => ({ default: { version: '0.0.0' } }));

import { onExitTimeoutMessage, startLocalCommand } from './local-command.js';

describe('onExitTimeoutMessage — FQN inclusion on both branches', () => {
  // R18 added the FQN to the wrong-exit-code branch. R19 caught that
  // the setTimeout-budget branch was missed AND had no test pinning
  // it. Falsifier: drop `'${resourceFqn}'` from the template; this
  // assertion fails.
  it('includes the resource FQN', () => {
    expect(onExitTimeoutMessage('my-cmd', 1000, 0)).toMatch(
      /'my-cmd'.*did not exit within 1000ms.*expected code 0/,
    );
  });
  it('FQNs with hyphens, dots, slashes survive interpolation', () => {
    expect(onExitTimeoutMessage('stack.sub/migrate-v2', 500, 7)).toContain(
      "'stack.sub/migrate-v2'",
    );
  });
});

describe('startLocalCommand — spawn error path', () => {
  it('ENOENT on bad command rejects `ready` with an actionable message', async () => {
    const handle = startLocalCommand({
      resourceFqn: 'bad',
      spec: {
        command: '/does/not/exist/at/all/__neonctl_test_missing__ --some-arg=1',
        readiness: { onExit: 0 },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    // The spawn error surfaces either as a child 'error' event (ENOENT
    // from PATH miss) or as a non-zero exit from the wrapping shell when
    // it tries to invoke an absent binary. Both paths must surface a
    // user-actionable rejection — never silently resolve.
    await expect(handle.ready).rejects.toThrow();
  });
});

describe('startLocalCommand — stream error listeners (R18 fix, R19 TDD gap)', () => {
  it('emits-error events on stdout/stderr do not throw uncaught', async () => {
    // Falsifier: removing the `child.stdout.on('error', …)` /
    // `child.stderr.on('error', …)` blocks would let an emit-on-stream
    // surface as an uncaughtException, crashing the test process. We
    // assert that emitting an error on the stream is handled (the test
    // continues, the handle's promise settles normally) instead of
    // taking down the process.
    const handle = startLocalCommand({
      resourceFqn: 'stream-error',
      spec: {
        command: `node -e "console.log('ok'); setTimeout(() => process.exit(0), 100);"`,
        readiness: { logMatch: /ok/ },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await handle.ready;
    // Synthetic stream 'error' — without the listener this becomes
    // uncaughtException. With the listener (the R18 fix) it's logged
    // and the process continues. We assert no throw escapes here.
    expect(() => {
      handle.child.stdout?.emit('error', new Error('synthetic EPIPE'));
      handle.child.stderr?.emit('error', new Error('synthetic EPIPE'));
    }).not.toThrow();
    await handle.kill();
    await handle.exited;
  });
});

describe('startLocalCommand — onExit readiness', () => {
  it('exits 0 → ready resolves', async () => {
    const handle = startLocalCommand({
      resourceFqn: 'one-shot-success',
      spec: {
        command: `node -e "process.exit(0)"`,
        readiness: { onExit: 0 },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await expect(handle.ready).resolves.toBeUndefined();
    const result = await handle.exited;
    expect(result.code).toBe(0);
  });

  it('exits non-zero → ready rejects with the actual exit code', async () => {
    const handle = startLocalCommand({
      resourceFqn: 'one-shot-fail',
      spec: {
        command: `node -e "process.exit(7)"`,
        readiness: { onExit: 0 },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    // FQN must be in the message so a multi-resource failure points
    // at the right command. Falsifier: dropping `'${resourceFqn}'` in
    // awaitOnExit would still satisfy /code 7/ but lose the FQN signal.
    await expect(handle.ready).rejects.toThrow(/one-shot-fail.*code 7/);
  });
});

describe('startLocalCommand — logMatch readiness + line buffering', () => {
  it('mid-chunk fragments are reassembled into whole lines', async () => {
    // Print two newline-terminated lines, then keep the process alive
    // briefly so the pattern matcher has time to subscribe + match.
    const script = `
      process.stdout.write('starting up');
      process.stdout.write('\\n');
      process.stdout.write('READY ');
      process.stdout.write('on port 3000\\n');
      setTimeout(() => process.exit(0), 200);
    `.replace(/\n\s+/g, ' ');
    const handle = startLocalCommand({
      resourceFqn: 'log-match',
      spec: {
        command: `node -e "${script}"`,
        readiness: { logMatch: /READY on port \d+/ },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await expect(handle.ready).resolves.toBeUndefined();
    await handle.kill();
    await handle.exited;
  });

  it("logMatch that never fires + early child exit → ready rejects (doesn't wait the full budget)", async () => {
    const handle = startLocalCommand({
      resourceFqn: 'log-match-never',
      spec: {
        command: `node -e "console.log('nothing matches'); process.exit(0)"`,
        readiness: { logMatch: /WILL_NEVER_APPEAR/ },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    // The child exits before the regex matches; readiness must reject
    // promptly (well under the 5-minute logMatch budget).
    await expect(handle.ready).rejects.toThrow();
  });
});

describe('startLocalCommand — kill', () => {
  it('kill() is a no-op when the child has already exited', async () => {
    const handle = startLocalCommand({
      resourceFqn: 'already-dead',
      spec: {
        command: `node -e "process.exit(0)"`,
        readiness: { onExit: 0 },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await handle.ready;
    // Already exited — kill() must not throw and must resolve.
    await expect(handle.kill()).resolves.toBeUndefined();
  });

  it('detached/prefixed: kill() escalates to SIGKILL after timeout when child traps SIGTERM', async () => {
    // Prefixed mode → detached → process.kill(-pid, sig) does NOT touch
    // child.killed. Tests the detached escalation path.
    const handle = startLocalCommand({
      resourceFqn: 'sigterm-trap-detached',
      spec: {
        command: `node -e "process.on('SIGTERM', () => {}); console.log('trapped'); setTimeout(() => {}, 60_000);"`,
        readiness: { logMatch: /trapped/ },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await handle.ready;
    await handle.kill();
    const result = await handle.exited;
    expect(result.signal === 'SIGKILL' || result.code === 137).toBe(true);
  }, 10_000);

  it('gracefulShutdown reaps SIGTERM-trapping children within the term grace, before parent would exit', async () => {
    // The shutdown handler in runner.ts schedules `process.exit(code)` after
    // a ~1.5s analytics flush. kill()'s own SIGKILL escalation is 5s — by
    // the time the timer fires the parent is gone. gracefulShutdown must
    // dispatch SIGKILL directly within the term-grace window.
    const handle = startLocalCommand({
      resourceFqn: 'sigterm-trap-shutdown',
      spec: {
        command: `node -e "process.on('SIGTERM', () => {}); console.log('alive'); setTimeout(() => {}, 60_000);"`,
        readiness: { logMatch: /alive/ },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await handle.ready;
    const { gracefulShutdown } = await import('../runner.js');
    const t0 = Date.now();
    await gracefulShutdown([handle], 1_000); // 1s grace, well under 5s
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2_500);
    const result = await handle.exited;
    expect(result.signal === 'SIGKILL' || result.code === 137).toBe(true);
  }, 10_000);

  it('inherit/non-detached: kill() escalates to SIGKILL when child traps SIGTERM', async () => {
    // Inherit mode → non-detached → child.kill('SIGTERM') sets
    // child.killed = true IMMEDIATELY on dispatch (Node spec). A
    // SIGKILL-escalation check that reads `!child.killed` is dead code
    // in this path. Without the fix, this test hangs until vitest's
    // timeout. With it, SIGKILL fires after 5s.
    //
    // No readiness probe — inherit mode doesn't capture stdout so
    // logMatch can't fire. We sleep briefly to let the child spawn,
    // then kill.
    const handle = startLocalCommand({
      resourceFqn: 'sigterm-trap-inherit',
      spec: {
        command: `node -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);"`,
        // No readiness — ready resolves immediately.
      },
      resolvedEnv: {},
      stdioMode: 'inherit',
    });
    await handle.ready;
    // Give the child ~200ms to actually spawn + install the SIGTERM trap
    // before we kill — otherwise the SIGTERM arrives before the trap
    // handler is registered and the default disposition kills the child.
    await new Promise((r) => setTimeout(r, 200));
    await handle.kill();
    const result = await handle.exited;
    expect(result.signal === 'SIGKILL' || result.code === 137).toBe(true);
  }, 10_000);

  it('kill() on a still-running child SIGTERMs it; `exited` resolves shortly after', async () => {
    // A long-running child that responds to SIGTERM with the default
    // exit. We can't use logMatch readiness here because we want to
    // race the kill before the child finishes on its own.
    const handle = startLocalCommand({
      resourceFqn: 'long-running',
      spec: {
        command: `node -e "setTimeout(() => {}, 30_000); console.log('alive');"`,
        readiness: { logMatch: /alive/ },
      },
      resolvedEnv: {},
      stdioMode: 'prefixed',
    });
    await handle.ready;
    await handle.kill();
    const result = await handle.exited;
    // SIGTERM exits with signal SIGTERM (code null) OR code 143 depending
    // on platform/shell — either is a successful teardown.
    expect(result.signal === 'SIGTERM' || result.code === 143).toBe(true);
  });
});

import { provisionLocalCommandNode } from '../runner.js';
import type { PlanNode } from '../plan.js';

// -----------------------------------------------------------------------------
// Post-readiness-exit detection — R15 fix that previously had no test.
// A non-onExit readiness mode (httpGet/portListening/logMatch) firing
// and then the child crashing in the microsecond window before the
// runner records it as ready must surface as a crash, not be treated
// as a one-shot. Otherwise dependent stages race a dead resource.
// -----------------------------------------------------------------------------

function planNodeFor(spec: object, name = 'cmd'): PlanNode {
  return {
    name,
    localKey: name,
    resource: {
      __kind: 'local-command',
      __id: name,
      __spec: () => spec,
      __dependsOn: {},
    } as any,
    spec,
    parentFqn: null,
    deps: [],
  };
}

function fakeRuntime() {
  return {
    outputs: new Map(),
    shuttingDown: { value: false },
  } as any;
}

describe('provisionLocalCommandNode — post-readiness-exit detection', () => {
  it('logMatch fires then child exits → throws (dependents would race dead resource)', async () => {
    // Child prints READY then exits 0 immediately. logMatch readiness
    // fires on READY; by the time provisionLocalCommandNode reaches
    // the post-readiness check, child.exitCode is non-null. The runner
    // must throw, NOT silently splice the handle as if it were a
    // one-shot.
    const spec = {
      command: `node -e "console.log('READY'); process.exit(0);"`,
      readiness: { logMatch: /READY/ },
    };
    const node = planNodeFor(spec, 'matches-then-dies');
    await expect(
      provisionLocalCommandNode({
        runtime: fakeRuntime(),
        node,
        cwd: process.cwd(),
        stdioMode: 'prefixed',
        liveLocalCommands: [],
      }),
    ).rejects.toThrow(
      /local-command.*matches-then-dies.*exited.*immediately after readiness fired/,
    );
  });

  it('refuses to spawn when shutdown flips DURING the resolveEnv await (R19 residual)', async () => {
    // The R18 fix checked shuttingDown only BEFORE resolveEnv. R19's
    // runtime reviewer pointed out the await window itself is a race
    // window: any spec.env containing a ref leaf yields via
    // resolveLeaf, and SIGINT during that yield arrives AFTER the
    // pre-check passed. Without the post-await re-check, we then
    // spawn a detached child that the shutdown handler's snapshot
    // already missed.
    //
    // To exercise the post-resolveEnv check, we need an `env` that
    // contains at least one ref. Use a minimal fake ref that the
    // runtime's resolveEnv knows how to resolve.
    const node = planNodeFor(
      {
        command: `node -e "setTimeout(() => {}, 60_000);"`,
        env: { FOO: 'bar' }, // no refs — but the post-await check
        // fires regardless of whether the await yielded.
        readiness: { logMatch: /never/ },
      },
      'race-during-await',
    );
    const live: any[] = [];
    const runtime = fakeRuntime();
    // Race shape: shuttingDown is false at function entry (so the
    // pre-await guard PASSES), but flips to true before the post-await
    // guard runs. We can't easily race a real microtask, so mutate the
    // runtime object such that the property returns false on first
    // read and true on subsequent reads — same observable timing.
    let reads = 0;
    Object.defineProperty(runtime.shuttingDown, 'value', {
      get() {
        const v = reads > 0;
        reads += 1;
        return v;
      },
    });
    await expect(
      provisionLocalCommandNode({
        runtime,
        node,
        cwd: process.cwd(),
        stdioMode: 'prefixed',
        liveLocalCommands: live,
      }),
    ).rejects.toThrow(/shutdown in flight/);
    // Critical: never pushed into the live list. If the pre-resolveEnv
    // check were the only guard, we'd have spawned and pushed before
    // throwing.
    expect(live).toHaveLength(0);
  });

  it('refuses to spawn when shutdown is already in flight (race fix)', async () => {
    // If SIGINT arrives while we're waiting on a dependency, the
    // shutdown handler has already iterated liveLocalCommands and
    // moved on. Spawning now would leak the child — gracefulShutdown
    // won't see it. The fix: refuse at the top of the provisioner.
    const spec = {
      command: `node -e "console.log('READY'); setTimeout(() => {}, 60_000);"`,
      readiness: { logMatch: /READY/ },
    };
    const node = planNodeFor(spec, 'race-victim');
    const live: any[] = [];
    const runtime = fakeRuntime();
    runtime.shuttingDown.value = true;
    await expect(
      provisionLocalCommandNode({
        runtime,
        node,
        cwd: process.cwd(),
        stdioMode: 'prefixed',
        liveLocalCommands: live,
      }),
    ).rejects.toThrow(/shutdown in flight/);
    // Critical: nothing pushed into the live list — we never spawned.
    expect(live).toHaveLength(0);
  });

  it('onExit:0 + clean exit → no throw (one-shot semantics preserved)', async () => {
    // onExit IS readiness — when the child exits 0 the readiness fires.
    // The post-readiness check sees an exited child but recognizes the
    // onExit case and splices the handle without throwing.
    const spec = {
      command: `node -e "process.exit(0);"`,
      readiness: { onExit: 0 },
    };
    const node = planNodeFor(spec, 'one-shot');
    await expect(
      provisionLocalCommandNode({
        runtime: fakeRuntime(),
        node,
        cwd: process.cwd(),
        stdioMode: 'prefixed',
        liveLocalCommands: [],
      }),
    ).resolves.toBeUndefined();
  });
});
