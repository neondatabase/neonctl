let calls = 0;

const version = (id, status) => ({
  id,
  status,
  memory_mib: 256,
  runtime: 'nodejs24',
  created_at: '2026-06-03T00:00:00Z',
});

const fn = (active_deployment) => ({
  function: {
    id: 'fn-envadd-nowait',
    slug: 'envadd-nowait',
    name: 'Envadd-nowait',
    invocation_url: 'https://envadd-nowait.functions.neon.tech',
    created_at: '2026-06-03T00:00:00Z',
    active_deployment,
  },
});

export default function (req, res) {
  calls += 1;
  // call 1 = pre-deploy snapshot (prior version 1); call 2+ = new version 2
  // building. --no-wait stops at first sight of the new version.
  if (calls === 1) return res.send(fn(version(1, 'completed')));
  return res.send(fn(version(2, 'building')));
}
