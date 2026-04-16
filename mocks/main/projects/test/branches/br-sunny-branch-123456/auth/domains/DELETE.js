import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('auth_provider', 'better_auth');
  expect(req.body.domains).toContainEqual({ domain: 'https://example.com' });
  res.status(200).send();
}
