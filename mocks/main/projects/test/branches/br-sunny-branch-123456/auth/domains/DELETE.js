import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('auth_provider', 'better_auth');
  expect(req.body).toHaveProperty('domains');
  res.status(200).send();
}
