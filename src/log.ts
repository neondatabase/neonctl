export const log = {
  info: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
};
