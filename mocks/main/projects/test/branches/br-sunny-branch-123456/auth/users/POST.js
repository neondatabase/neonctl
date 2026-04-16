import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('email');
  expect(req.body).toHaveProperty('name');

  res.send({
    id: 'test-user-id',
  });
}
