// Presign mock that 404s, mirroring a missing bucket/object so the CLI surfaces
// the server message just like get/delete do.
export default function (req, res) {
  res.status(404).json({ message: 'Not Found' });
}
