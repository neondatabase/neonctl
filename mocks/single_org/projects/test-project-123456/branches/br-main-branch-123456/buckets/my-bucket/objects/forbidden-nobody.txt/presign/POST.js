// Presign mock that 403s with no parseable `{ message }` body, exercising the
// CLI's clean status-bearing fallback (it must still include the HTTP status
// and never leak a bare axios error or a signed URL).
export default function (req, res) {
  res.status(403).type('text/plain').send('Forbidden');
}
