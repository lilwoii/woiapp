const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  {
    ignores: [
      'dist/**',
      '.expo/**',
      '.openai/**',
      'node_modules/**',
      'supabase/functions/**',
      'supabase/tests/**',
    ],
  },
  expoConfig,
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='Alert'][callee.property.name='alert']",
          message:
            'Use the cross-platform dialog helper; React Native Alert is a no-op on web.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.{js,jsx,ts,tsx}', '**/__tests__/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        afterEach: 'readonly',
        beforeEach: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      'import/first': 'off',
    },
  },
  {
    files: ['lib/platform-dialog.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        self: 'readonly',
        URL: 'readonly',
      },
    },
  },
]);
