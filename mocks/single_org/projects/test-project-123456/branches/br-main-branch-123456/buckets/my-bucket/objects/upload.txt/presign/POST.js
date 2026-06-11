import { writeFileSync } from 'node:fs';

// Returns a presigned PUT URL that points back at this same mock server's
// capture sink (see mocks/single_org/_upload_sink/PUT.js). The signed headers
// echo the requested Content-Type so the test can prove they are forwarded.
//
// This is the unified presign endpoint: the request carries an `operation`
// discriminator. neonctl only ever uploads, so it must send
// `operation: "upload"`; the mock records the received operation to the file
// named by NEONCTL_TEST_PRESIGN_SINK so the test can assert the body shape.
export default function (req, res) {
  const presignSink = process.env.NEONCTL_TEST_PRESIGN_SINK;
  if (presignSink) {
    writeFileSync(
      presignSink,
      JSON.stringify({ operation: req.body && req.body.operation }),
    );
  }
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
