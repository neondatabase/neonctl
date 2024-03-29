export default function (req, res) {
  expect(req.body).toMatchObject({
    source_branch_id: 'br-self-tolsn-123456',
    source_lsn: '0/123ABC',
    preserve_under_name: 'backup',
  });

  res.status(200).send({
    branch: {
      id: 'br-self-tolsn-123456',
      name: 'self-tolsn',
      last_reset_at: '2021-01-01T00:00:00Z',
    },
  });
}
