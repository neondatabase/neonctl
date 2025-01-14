import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    label: 'newlabel',
  });
  res.status(200).send({});
}
