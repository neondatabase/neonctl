import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({ delete_data: true });
  res.status(200).send();
}
