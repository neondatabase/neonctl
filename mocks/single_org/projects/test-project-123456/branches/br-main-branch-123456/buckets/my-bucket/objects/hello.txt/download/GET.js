export default function (req, res) {
  const body = Buffer.from('hello world\n');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('ETag', '"abc123"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'attachment; filename="hello.txt"');
  res.status(200).send(body);
}
