export default function (_req, res) {
  res.status(403).json({
    code: '',
    message: 'not allowed for organization API keys',
  });
}
