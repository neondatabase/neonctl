export default function (req, res) {
  expect(req.body).toMatchObject({
    project: {
      name: 'test_project',
    },
  });
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
