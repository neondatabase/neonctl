export const isCi = () => {
  return process.env.CI !== 'false';
};
