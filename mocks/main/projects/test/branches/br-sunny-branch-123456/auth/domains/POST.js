import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('domain');
  expect(req.body).toHaveProperty('auth_provider', 'better_auth');
  res.status(200).send();
}
