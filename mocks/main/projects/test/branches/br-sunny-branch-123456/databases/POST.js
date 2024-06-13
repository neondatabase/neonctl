import { expect } from 'bun:test';

export default function (req, res) {
  expect(req.body).toMatchObject({
    database: {
      name: 'test_db',
      owner_name: 'test_owner',
    },
  });
  res.send({
    database: {
      name: 'test_database',
    },
  });
}
