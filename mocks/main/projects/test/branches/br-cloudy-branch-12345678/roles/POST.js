import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    role: {
      name: 'test_role',
    },
  });

  res.send({
    role: {
      name: 'test_role',
      created_at: '2019-01-01T00:00:00.000Z',
    },
  });
}
