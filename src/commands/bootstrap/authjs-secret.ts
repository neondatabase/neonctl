// See https://github.com/nextauthjs/cli/blob/8443988fe7e7f078ead32288dcd1b01b9443f13a/commands/secret.js#L9
// for reference.
export function getAuthjsSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes.toString(), 'base64').toString('base64');
}
