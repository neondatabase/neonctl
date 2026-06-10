// Returns a presigned PUT URL that points back at this same mock server's
// capture sink (see mocks/single_org/_upload_sink/PUT.js). The signed headers
// echo the requested Content-Type so the test can prove they are forwarded.
export default function (req, res) {
  const host = req.headers.host;
  const headers = { 'x-neonctl-test-signed': 'yes' };
  if (req.body && req.body.content_type) {
    headers['Content-Type'] = req.body.content_type;
  }
  res.status(200).json({
    url: `http://${host}/_upload_sink`,
    method: 'PUT',
    headers,
    expires_at: '2099-01-01T00:00:00.000Z',
  });
}
