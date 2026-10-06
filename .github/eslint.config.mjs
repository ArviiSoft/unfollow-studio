import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.nodeBuiltin },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  },
  { files: ['src/**/*.mjs'], languageOptions: { globals: globals.browser } },
  { files: ['src/instagram.mjs'], rules: { 'no-control-regex': 'off' } }
];
