import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('email');

  res.send({
    id: 'test-user-id',
  });
}
