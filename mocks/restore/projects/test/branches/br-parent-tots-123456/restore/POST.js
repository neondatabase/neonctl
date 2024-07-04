import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    source_branch_id: 'br-any-branch-123456',
    source_timestamp: '2021-01-01T00:00:00.000Z',
  });

  res.status(200).send({
    branch: {
      id: 'br-parent-tots-123456',
      name: 'parent-tots',
      last_reset_at: '2021-01-01T00:00:00Z',
    },
  });
}
