import { expect } from 'vitest';

export default function (req, res) {
  expect(req.query).toMatchObject({
    limit: '100',
  });
  res.json({
    projects: [
      {
        id: 1,
        name: 'Project_1',
        created_at: '2019-01-01T00:00:00.000Z',
        updated_at: '2019-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        name: 'Project_2',
        created_at: '2019-01-01T00:00:00.000Z',
        updated_at: '2019-01-01T00:00:00.000Z',
      },
      {
        id: 3,
        name: 'Project_3',
        created_at: '2019-01-01T00:00:00.000Z',
        updated_at: '2019-01-01T00:00:00.000Z',
      },
    ],
  });
}
