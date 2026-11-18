import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const shared = {
  'no-unused-vars': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
};

export default tseslint.config(
  { ignores: ['node_modules/', 'logs/', 'dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: {
      ...shared,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Provider protocols (Claude stream-json, Codex JSON-RPC, OpenCode events) are external JSON; `any` is used at those edges.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['test/**/*.mjs', 'bin/**/*.mjs', '*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: { ...shared, '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
    rules: { ...shared, '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
);
