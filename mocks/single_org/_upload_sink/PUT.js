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
    res.status(200).end();
  });
}
