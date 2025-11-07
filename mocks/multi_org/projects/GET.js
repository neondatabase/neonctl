export default function (req, res) {
  // Simulate the API behavior when user belongs to multiple organizations
  // and org_id is not provided
  if (!req.query.org_id) {
    return res.status(400).json({
      message: 'org_id is required, you can find it on your organization settings page',
    });
  }

  // If org_id is provided, return projects for that org
  res.json({
    projects: [
      {
        id: 'test',
        name: 'Test Project',
        region_id: 'aws-us-east-1',
        created_at: '2019-01-01T00:00:00.000Z',
        updated_at: '2019-01-01T00:00:00.000Z',
        org_id: req.query.org_id,
      },
    ],
  });
}
