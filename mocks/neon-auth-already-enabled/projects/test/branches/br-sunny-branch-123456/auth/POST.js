export default function (req, res) {
  res.status(409).send({ message: 'Neon Auth is already enabled for this branch' });
}
