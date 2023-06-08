module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  root: true,
  env: {
    node: true,
  },
  ignorePatterns: ['**/*.js', '**/*.gen.ts'],
  rules: {
    'no-console': 'error',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
