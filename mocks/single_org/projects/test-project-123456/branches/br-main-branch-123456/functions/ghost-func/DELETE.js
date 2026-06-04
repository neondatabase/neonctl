export default function (req, res) {
  res.status(404).send({ message: 'Function not found' });
}
