const defaultSettings = {
  allowed_ips: {
    ips: ['192.168.1.1'],
    protected_branches_only: false,
  },
};

export default function (_req, res) {
  res.send({
    project: {
      id: 'test',
      name: 'test_project_with_autoscaling',
      created_at: '2019-01-01T00:00:00Z',
      settings: defaultSettings,
    },
  });
}
