let calls = 0;

// call 1 = pre-deploy snapshot (404, no prior version); call 2 = a transient
// 5xx the poll loop must tolerate and retry; call 3+ = version 1 completed.
export default function (req, res) {
  calls += 1;
  if (calls === 1) return res.status(404).send({ message: 'Not Found' });
  if (calls === 2) return res.status(500).send({ message: 'Server Error' });
  return res.send({
    function: {
      id: 'fn-flaky',
      slug: 'flaky',
      name: 'Flaky',
      invocation_url: 'https://flaky.functions.neon.tech',
      created_at: '2026-06-03T00:00:00Z',
      active_deployment: {
        id: 1,
        status: 'completed',
        memory_mib: 256,
        runtime: 'nodejs24',
        created_at: '2026-06-03T00:00:00Z',
      },
    },
  });
}
