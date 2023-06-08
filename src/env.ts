export const isCi = () => {
  return process.env.CI !== 'false' && Boolean(process.env.CI);
};
