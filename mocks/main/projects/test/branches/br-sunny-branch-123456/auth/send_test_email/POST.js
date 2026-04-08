import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('recipient_email');
  expect(req.body).toHaveProperty('host');

  res.send({
    success: true,
  });
}
