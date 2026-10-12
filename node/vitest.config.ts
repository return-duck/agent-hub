import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 事件映射与编译都是纯函数，测试之间没有共享状态，可以放心并行
    testTimeout: 20000,
  },
});
