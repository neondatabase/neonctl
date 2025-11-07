import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toEqual({
    source_branch_id: 'br-parent-branch-123456',
  });
  res.status(200).json({
    branch: {
      id: 'br-branch-123456',
      name: 'test-branch',
      source_branch_id: 'br-parent-branch-123456',
      project_id: 'pr-project-123456',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      last_reset_at: '2020-01-01T00:00:00.000Z',
    },
  });
}
