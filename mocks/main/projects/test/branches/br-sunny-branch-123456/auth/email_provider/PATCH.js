import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('type');
  expect(req.body).toHaveProperty('sender_email');
  res.send(req.body);
}
