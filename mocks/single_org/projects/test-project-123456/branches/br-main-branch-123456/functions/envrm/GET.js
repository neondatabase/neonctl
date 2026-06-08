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
    id: 'fn-envrm',
    slug: 'envrm',
    name: 'Envrm',
    invocation_url: 'https://envrm.functions.neon.tech',
    created_at: '2026-06-03T00:00:00Z',
    active_deployment,
  },
});

export default function (req, res) {
  calls += 1;
  if (calls === 1) return res.send(fn(version(1, 'completed')));
  if (calls === 2) return res.send(fn(version(2, 'building')));
  return res.send(fn(version(2, 'completed')));
}
