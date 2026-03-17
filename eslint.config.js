// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginN from 'eslint-plugin-n';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Ignore patterns
  {
    ignores: [
      'build/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'docs/**',
      '*.config.js',
      '*.config.mjs',
      '*.mjs',
      'scripts/**',
      // Generated OpenAPI types — do not lint auto-generated files
      'src/types/*.d.ts',
      'src/types/sell-apps/**',
      'src/types/application-settings/**',
    ],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript ESLint recommended rules
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Node.js plugin recommended rules
  pluginN.configs['flat/recommended-module'],

  // Global configuration
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // ===== TypeScript Rules =====
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],

      // ===== Node.js Rules =====
      'n/no-missing-import': 'off', // Handled by TypeScript
      'n/no-unsupported-features/es-syntax': 'off', // We use ES modules
      'n/no-unsupported-features/node-builtins': [
        'error',
        {
          version: '>=22.0.0',
        },
      ],
      'n/no-process-exit': 'warn',

      // ===== General Best Practices =====
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'all'],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-return-await': 'off', // Conflicts with @typescript-eslint/return-await
      '@typescript-eslint/return-await': ['error', 'always'],

      // ===== Code Style =====
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'forbid',
        },
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE', 'PascalCase', 'camelCase'],
        },
        // Allow any format for object/type properties — eBay API uses snake_case in their schemas
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
        {
          selector: 'typeProperty',
          format: null,
        },
        {
          selector: 'classProperty',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
        // Interface names don't require I-prefix
        {
          selector: 'interface',
          format: ['PascalCase'],
        },
      ],

      // ===== Security Best Practices =====
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-implied-eval': 'error',

      // ===== Performance =====
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',

      // ===== Error Handling =====
      '@typescript-eslint/only-throw-error': 'error',
      'no-promise-executor-return': 'error',

      // ===== Intentional Patterns =====
      // Unbound-method is commonly intentional in MCP tool registration, callback passing,
      // and method extraction patterns throughout this codebase
      '@typescript-eslint/unbound-method': 'warn',
      // no-empty-function is needed for mock/stub patterns in utils and tests
      '@typescript-eslint/no-empty-function': 'warn',
    },
  },

  // Script files — process.exit is acceptable in CLI scripts
  {
    files: ['src/scripts/**/*.ts'],
    rules: {
      'n/no-process-exit': 'off',
    },
  },

  // Test helper files — mocks & stubs intentionally have async-without-await and unused exports
  {
    files: ['tests/helpers/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  // Test files specific configuration
  {
    files: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    plugins: {
      vitest,
    },
    rules: {
      ...vitest.configs.recommended.rules,
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      'vitest/no-identical-title': 'warn',
      'vitest/no-conditional-expect': 'warn',
      'no-console': 'off',
    },
  },

  // Disable rules that conflict with Prettier
  eslintConfigPrettier,
);
