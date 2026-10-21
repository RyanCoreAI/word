import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/core/**/*.test.ts', 'apps/web/src/**/*.test.ts'] } });
