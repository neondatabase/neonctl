const version = (id, status) => ({
  id,
  status,
  bundle_sha256: `sha-${id}`,
  memory_mib: 256,
  runtime: 'nodejs24',
  created_at: '2026-06-03T00:00:00Z',
});

const fn = (active_deployment) => ({
  function: {
    id: 'fn-envadd',
    slug: 'envadd',
    name: 'Envadd',
    invocation_url: 'https://envadd.functions.neon.tech',
    created_at: '2026-06-03T00:00:00Z',
    active_deployment,
  },
});

// The mock module is import-cached and reused across the file's tests, so per
// test state lives on globalThis and is reset by the deploy POST. The deploy
// helper does exactly: one snapshot GET, then the POST, then poll GETs. The
// snapshot (before the POST has incremented `polls`) reports prior version 1;
// the first poll reports version 2 still building, then completed.
export default function (req, res) {
  const state = (globalThis.__envadd ??= { polls: 0, deploying: false });
  if (!state.deploying) return res.send(fn(version(1, 'completed')));
  state.polls += 1;
  if (state.polls <= 1) return res.send(fn(version(2, 'building')));
  // Terminal poll: end this cycle so the next test's snapshot sees prior
  // version 1 again. --no-wait stops before reaching here; it resets on its
  // own deploy POST.
  state.deploying = false;
  return res.send(fn(version(2, 'completed')));
}
