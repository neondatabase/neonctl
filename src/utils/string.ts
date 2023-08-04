export const toSnakeCase = (str: string) =>
  str
    .split(' ')
    .map((word) => word.toLowerCase())
    .join('_');
