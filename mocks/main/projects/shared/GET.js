import { expect } from 'vitest';

export default function (req, res) {
  expect(req.query).toMatchObject({
    limit: '100',
  });
  res.json({
    projects: [
      {
        id: 'adj-noun-12401747',
        region_id: 'aws-us-east-2',
        name: 'Shared Project',
        created_at: '2024-04-03T04:45:46Z',
        updated_at: '2024-04-11T16:13:43Z',
      },
    ],
  });
}
