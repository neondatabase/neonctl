export const isCi = () => {
  return process.env.CI !== 'false' && Boolean(process.env.CI);
};

export const isDebug = () => {
  return Boolean(process.env.DEBUG);
};
