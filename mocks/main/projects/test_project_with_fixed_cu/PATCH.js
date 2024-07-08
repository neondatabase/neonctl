const defaultSettings = {
  allowed_ips: {
    ips: ['192.168.1.1'],
    primary_branch_only: false,
  },
};

export default function (_req, res) {
  res.send({
    project: {
      id: 'test',
      name: 'test_project_with_fixed_cu',
      created_at: '2019-01-01T00:00:00Z',
      settings: defaultSettings,
    },
  });
}
