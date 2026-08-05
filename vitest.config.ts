import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
    /*
     * ★★ vite.config.ts 의 define 과 **같은 값을 여기에도 둬야 한다.**
     *   빌드 설정과 테스트 설정이 다른 파일이라 그냥 어긋난다.
     *   이게 없으면 __APP_VERSION__ 을 쓰는 모듈은 import 하는 순간
     *   "ReferenceError: __APP_VERSION__ is not defined" 로 죽어서
     *   **아예 시험할 수 없는 코드**가 된다(설정 화면이 그랬다, 2026-08-05).
     *   define 을 새로 늘리면 여기에도 같이 넣어라.
     */
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    test: {
        globals: true,
        environment: 'jsdom', // DOMPurify 와 렌더 파이프라인이 진짜 DOM 을 쓴다
        include: ['src/**/*.test.ts'],
        setupFiles: ['./src/test/setup.ts'],
    },
});
