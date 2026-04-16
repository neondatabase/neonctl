import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('id');

  res.send({
    id: req.body.id,
    type: req.body.client_id ? 'standard' : 'shared',
    client_id: req.body.client_id || '',
  });
}
