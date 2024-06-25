module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  root: true,
  env: {
    node: true,
  },
  ignorePatterns: [
    '**/*.js',
    '**/*.gen.ts',
    'src/commands/bootstrap/next-drizzle-authjs/*',
    'src/commands/bootstrap/next-drizzle/*,',
  ],
  rules: {
    'no-console': 'error',
    'no-constant-condition': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
