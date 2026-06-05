const version = {
  id: 1,
  status: 'completed',
  bundle_sha256: 'sha-1',
  memory_mib: 256,
  runtime: 'nodejs24',
  created_at: '2026-06-03T00:00:00Z',
};

export default function (req, res) {
  res.send({
    function: {
      id: 'fn-stuckstart',
      slug: 'stuckstart',
      name: 'Stuckstart',
      invocation_url: 'https://stuckstart.functions.neon.tech',
      created_at: '2026-06-03T00:00:00Z',
      active_deployment: version,
    },
  });
}
