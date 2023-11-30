import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    endpoint: {
      id: 'test_endpoint_id',
      branch_id: 'test_branch_id',
    },
  });

  res.send({
    endpoint: {
      id: 'test_endpoint_id',
      branch_id: 'test_branch_id',
      created_at: '2019-01-01T00:00:00Z',
      type: 'read_only',
    },
  });
}
