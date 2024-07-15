import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      'no-constant-condition': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
