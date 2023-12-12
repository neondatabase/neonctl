export default function (req, res) {
  const project = req.body.project ?? {}
  res.send({
    "project": {
      "id": "test",
      "name": project.name ?? "test_project",
      "created_at": "2019-01-01T00:00:00Z",
      "settings": project.settings
    }
  });
}



