import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('type');
  res.send(req.body);
}
