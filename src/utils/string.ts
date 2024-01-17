export const toSnakeCase = (str: string) =>
  str
    .split(' ')
    .map((word) => word.toLowerCase())
    .join('_');

export const isObject = (value: any) =>
  value != null && value === Object(value);
