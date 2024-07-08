import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    source_branch_id: 'br-any-branch-123456',
  });

  res.status(200).send({
    branch: {
      id: 'br-another-branch-123456',
      name: 'another-branch',
      last_reset_at: '2021-01-01T00:00:00Z',
    },
  });
}
