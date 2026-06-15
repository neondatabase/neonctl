const deployment = {
  id: 1,
  status: 'completed',
  memory_mib: 256,
  runtime: 'nodejs24',
  created_at: '2026-06-03T00:00:00Z',
};

const page1 = {
  functions: [
    {
      id: 'fn-1',
      slug: 'my-func',
      name: 'My Func',
      invocation_url: 'https://my-func.functions.neon.tech',
      created_at: '2026-06-03T00:00:00Z',
      current_deployment: deployment,
      active_deployment: deployment,
    },
  ],
  pagination: { next: 'page-2' },
};

// The last page has no `pagination` key on purpose: this is also the
// response shape of an old server that does not paginate, so the same
// tests cover backward compatibility.
const page2 = {
  functions: [
    {
      id: 'fn-2',
      slug: 'other-func',
      name: 'Other Func',
      invocation_url: 'https://other-func.functions.neon.tech',
      created_at: '2026-06-02T00:00:00Z',
    },
  ],
};

export default function (req, res) {
  if (req.query.limit !== '100') {
    return res.status(500).send({ message: 'expected limit=100' });
  }
  res.send(req.query.cursor === 'page-2' ? page2 : page1);
}
