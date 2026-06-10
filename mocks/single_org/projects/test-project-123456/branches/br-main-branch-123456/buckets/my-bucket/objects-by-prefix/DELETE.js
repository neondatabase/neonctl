export default function (req, res) {
  // The CLI must forward a non-empty prefix; reject otherwise so a dropped
  // query param surfaces as a test failure rather than a silent pass.
  if (!req.query.prefix) {
    res.status(400).json({ message: 'prefix query parameter is required' });
    return;
  }
  res.status(200).json({ deleted: 3 });
}
