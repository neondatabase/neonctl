let calls = 0;

const fn = () => ({
  function: {
    id: 'fn-newfunc',
    slug: 'newfunc',
    name: 'Newfunc',
    invocation_url: 'https://newfunc.functions.neon.tech',
    created_at: '2026-06-03T00:00:00Z',
    current_deployment: {
      id: 1,
      status: 'completed',
      memory_mib: 256,
      runtime: 'nodejs24',
      created_at: '2026-06-03T00:00:00Z',
    },
  },
});

export default function (req, res) {
  calls += 1;
  if (calls === 1) return res.status(404).send({ message: 'Not Found' });
  return res.send(fn());
}
