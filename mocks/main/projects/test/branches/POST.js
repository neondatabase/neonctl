export default function (req, res) {
  expect(req.body).toMatchObject({
    branch: {
      name: 'test_branch',
    },
  });
  res.send({
    branch: {
      id: 1,
      name: 'test_branch',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
