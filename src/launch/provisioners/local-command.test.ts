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

import { startLocalCommand } from './local-command.js';

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
    await expect(handle.ready).rejects.toThrow(/code 7/);
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
