export default function (req, res) {
  // Handle set-expiration operation on default branch - should fail
  if (req.body.branch.hasOwnProperty('expires_at')) {
    res.status(400).send({
      message: 'Default branch cannot have an expiration date',
      code: 'DEFAULT_BRANCH_EXPIRATION_NOT_ALLOWED',
    });
    return;
  }

  // Handle other operations (like rename) - default response
  res.status(400).send({ message: 'Unsupported PATCH operation' });
}
