// Echoes the received query params back into the response so tests can assert
// that prefix/delimiter/cursor/limit are actually forwarded by the CLI. The
// `prefix` field mirrors the requested prefix (empty string when none).
export default function (req, res) {
  res.status(200).json({
    folders: ['images/', 'logs/'],
    objects: [
      {
        key: 'hello.txt',
        size: 12,
        last_modified: '2021-01-01T00:00:00.000Z',
        etag: '"abc123"',
      },
      {
        key: 'readme.md',
        size: 2048,
        last_modified: '2021-02-02T00:00:00.000Z',
        etag: '"def456"',
      },
    ],
    prefix: req.query.prefix || '',
    delimiter: req.query.delimiter || '',
    limit: req.query.limit || '',
    cursor: req.query.cursor || '',
    next_cursor: '',
    is_truncated: false,
  });
}
