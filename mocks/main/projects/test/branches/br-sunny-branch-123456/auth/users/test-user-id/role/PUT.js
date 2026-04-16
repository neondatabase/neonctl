import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('roles');

  res.send({
    id: 'test-user-id',
  });
}
