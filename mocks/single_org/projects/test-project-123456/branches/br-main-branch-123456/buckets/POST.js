export default function (req, res) {
  res.status(201).json({
    bucket: {
      name: req.body.name,
      access_level: req.body.access_level || 'private',
    },
  });
}
