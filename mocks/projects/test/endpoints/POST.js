export default function (req, res) {
  expect(req.body).toMatchObject({
    endpoint: {
      branch_id: 'test_branch_id',
      type: 'read_only',
    },
  });

  res.send({
    endpoint: {
      id: 'test_endpoint_id',
      branch_id: 'test_branch_id',
      created_at: '2019-01-01T00:00:00Z',
      type: 'read_only',
    },
  });
}
