import { writeFileSync } from 'node:fs';

// Capture sink for the presigned PUT. The presign mock points its returned URL
// here; this handler drains the raw request body (the streamed file bytes) and
// records the body plus the headers the CLI sent to the file named by
// NEONCTL_TEST_UPLOAD_SINK so the test can assert the exact bytes and that the
// presigned headers were forwarded verbatim. Runs in the test process, so it
// reads the sink path from the parent env.
export default function (req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    const sink = process.env.NEONCTL_TEST_UPLOAD_SINK;
    if (sink) {
      writeFileSync(
        sink,
        JSON.stringify({
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: req.headers['content-type'] || '',
          signed: req.headers['x-neonctl-test-signed'] || '',
          contentLength: req.headers['content-length'] || '',
        }),
      );
    }
    // When the test asks for a failure, answer with an XML body like a real S3
    // data plane would, so we can prove the CLI surfaces a clean error (with the
    // HTTP status) rather than leaking the raw axios error or the presigned URL.
    const failStatus = Number(process.env.NEONCTL_TEST_UPLOAD_FAIL_STATUS);
    if (failStatus) {
      res
        .status(failStatus)
        .type('application/xml')
        .end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    res.status(200).end();
  });
}
