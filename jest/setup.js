export default function () {
  process.env.CI = 'true';
  process.argv.push('--no-color');
  process.env.FORCE_COLOR = 'false';
}
