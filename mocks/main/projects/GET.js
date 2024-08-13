import { expect } from 'vitest';

export default function (req, res) {
  expect(req.query).toMatchObject({
    limit: '100',
  });

  if (req.query.org_id) {
    expect(['org-2', 'org-3']).toContain(req.query.org_id);

    if (req.query.org_id === 'org-2') {
      return res.json({
        projects: [
          {
            id: 4,
            name: 'Project_4',
            created_at: '2019-01-01T00:00:00.000Z',
            updated_at: '2019-01-01T00:00:00.000Z',
            org_id: 'org-2',
          },
          {
            id: 5,
            name: 'Project_5',
            created_at: '2019-01-01T00:00:00.000Z',
            updated_at: '2019-01-01T00:00:00.000Z',
            org_id: 'org-2',
          },
          {
            id: 6,
            name: 'Project_6',
            created_at: '2019-01-01T00:00:00.000Z',
            updated_at: '2019-01-01T00:00:00.000Z',
            org_id: 'org-2',
          },
        ],
      });
    }

    if (req.query.org_id === 'org-3') {
      return res.json({
        projects: [
          {
            id: 7,
            name: 'Project_7',
            created_at: '2019-01-01T00:00:00.000Z',
            updated_at: '2019-01-01T00:00:00.000Z',
            org_id: 'org-3',
          },
        ],
      });
    }
  }

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
