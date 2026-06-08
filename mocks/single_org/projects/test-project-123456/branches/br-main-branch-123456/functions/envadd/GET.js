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
    id: 'fn-envadd',
    slug: 'envadd',
    name: 'Envadd',
    invocation_url: 'https://envadd.functions.neon.tech',
    created_at: '2026-06-03T00:00:00Z',
    active_deployment,
  },
});

export default function (req, res) {
  calls += 1;
  // call 1 = pre-deploy snapshot (prior version 1); call 2 = new version 2
  // still building; call 3+ = version 2 completed.
  if (calls === 1) return res.send(fn(version(1, 'completed')));
  if (calls === 2) return res.send(fn(version(2, 'building')));
  return res.send(fn(version(2, 'completed')));
}
