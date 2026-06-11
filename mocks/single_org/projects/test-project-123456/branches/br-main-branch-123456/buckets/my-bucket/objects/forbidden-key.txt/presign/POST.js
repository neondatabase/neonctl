// Presign mock that 403s with a structured `{ message }` body, mirroring the
// console rejecting a caller that lacks write permission on the bucket. The CLI
// must surface this server message rather than a bare axios status string.
export default function (req, res) {
  res
    .status(403)
    .json({ message: 'You do not have permission to write to this bucket.' });
}
