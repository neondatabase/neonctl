export default function (req, res) {
  expect(req.body).toMatchObject({
    branch: {
      name: 'new_test_branch',
    },
  });
  res.send({
    branch: {
      id: req.body.branch.id,
      name: 'new_test_branch',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
