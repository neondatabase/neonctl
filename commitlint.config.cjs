module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'footer-max-line-length': [0, 'always', 100],
    'body-max-line-length': [0, 'always', 100],
  },
};
