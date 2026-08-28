// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 构建产物与前端资源不参与 lint。
    // public/ 是零构建的原生 JS，走浏览器环境，规则与后端不同，单独配置。
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // 未使用变量允许 _ 前缀豁免（常见于解构丢弃、接口占位实现）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 解析外部订阅时不可避免要和 unknown/any 打交道，
      // 但我们要求显式收窄，而不是隐式放行。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off', // logger.ts 内部使用，其余处由 review 把关
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // 测试里对固定的 fixture 数组取下标（`nodes[0]!`）是安全且可读的。
      // 逼着测试代码写一堆 undefined 检查，只会淹没真正的断言。
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // 前端：浏览器全局，零构建原生 JS
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // 审计工具：手动跑的诊断脚本，Node 环境。见 scripts/audit/README.md。
    // 用 CommonJS 是刻意的 —— 这些脚本要能在没装依赖、没走构建的情况下直接 `node` 起来。
    files: ['scripts/**/*.cjs', 'scripts/**/*.mts'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
