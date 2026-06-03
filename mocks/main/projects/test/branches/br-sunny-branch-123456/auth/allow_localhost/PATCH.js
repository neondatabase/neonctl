import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('allow_localhost');
  res.send({ allow_localhost: req.body.allow_localhost });
}
