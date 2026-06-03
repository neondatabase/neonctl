export default function (_req, res) {
  res.json({
    projects: [
      {
        id: 'detected-project-12345',
        name: 'detected_project',
        region_id: 'aws-us-east-2',
        org_id: 'org-detected-99887766',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      },
    ],
  });
}
