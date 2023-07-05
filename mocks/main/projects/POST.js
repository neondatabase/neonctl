export default function (req, res) {
  expect(req.body).toMatchObject({
    project: {
      name: 'test_project',
    },
  });
  res.send({
    project: {
      id: 1,
      name: 'test_project',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
