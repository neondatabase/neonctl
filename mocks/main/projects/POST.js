import { expect } from 'vitest';

export default function (req, res) {
  if (req.body.project?.name === 'test_project_with_fixed_cu') {
    expect(req.body).toMatchObject({
      project: {
        name: 'test_project_with_fixed_cu',
        branch: {},
        default_endpoint_settings: {
          autoscaling_limit_min_cu: 2,
          autoscaling_limit_max_cu: 2,
        },
      },
    });
  } else if (req.body.project?.name === 'test_project_with_autoscaling') {
    expect(req.body).toMatchObject({
      project: {
        name: 'test_project_with_autoscaling',
        branch: {},
        default_endpoint_settings: {
          autoscaling_limit_min_cu: 0.5,
          autoscaling_limit_max_cu: 2,
        },
      },
    });
  } else {
    expect(req.body).toMatchObject({
      project: {
        name: 'test_project',
      },
    });
  }
  res.send({
    project: {
      id: 'new-project-123456',
      name: 'test_project',
      created_at: '2021-01-01T00:00:00.000Z',
    },
    connection_uris: [
      { connection_uri: 'postgres://localhost:5432/test_project' },
    ],
    branch: {
      id: 'br-test-branch-123456',
      name: 'test_branch',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
