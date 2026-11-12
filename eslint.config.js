// @ts-check
// CommonJS on purpose: the package has no `"type": "module"` (dist/index.js is the CJS build).
const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['eslint.config.js'],
    rules: {
      // Config file is CommonJS (see above).
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
