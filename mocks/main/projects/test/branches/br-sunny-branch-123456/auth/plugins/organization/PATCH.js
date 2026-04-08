export default function (req, res) {
  res.send({
    enabled: req.body.enabled ?? true,
    organization_limit: req.body.organization_limit ?? 5,
    allow_user_to_create_organization: req.body.allow_user_to_create_organization ?? true,
    creator_role: req.body.creator_role ?? 'owner',
  });
}
