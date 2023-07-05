let retries = 1;

export default function (req, res) {
  if (!req.body) {
    res.status(400).send('Missing body');
    return;
  }
  if (req.body.endpoint.branch_id === 'test_branch_with_retry') {
    if (retries > 0) {
      retries -= 1;
      res.status(423).send({ error: 'locked' });
      return;
    }
  }

  if (req.body.endpoint.branch_id === 'test_branch_id') {
    expect(req.body).toMatchObject({
      endpoint: {
        type: 'read_only',
      },
    });
  }

  res.send({
    endpoint: {
      id: 'test_endpoint_id',
      branch_id: req.body.endpoint.branch_id,
      created_at: '2019-01-01T00:00:00Z',
      type: req.body.endpoint.type,
    },
  });
}
