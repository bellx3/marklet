import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom', // DOMPurify 와 렌더 파이프라인이 진짜 DOM 을 쓴다
        include: ['src/**/*.test.ts'],
        setupFiles: ['./src/test/setup.ts'],
    },
});
