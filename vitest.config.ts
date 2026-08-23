import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // core/ 是纯函数层，是整个项目正确性的地基，覆盖率要求最高。
      // server/ 与 services/ 依赖 IO，v1 以手工端到端验证为主。
      include: ['src/core/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
