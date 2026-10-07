import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * 데스크톱(Electron) 렌더러 빌드 → dist-desktop/.
 *
 * 옛 모바일 빌드 설정(www/ 로 내보내 APK 에 넣던 것)은 archive/web/vite.config.ts 로 옮겼다.
 * 되살릴 때는 두 설정의 출력 폴더를 섞지 마라 — www/ 는 cap sync 가 통째로 APK 에 넣는다.
 */
export default defineConfig({
    root: './',
    // main.cjs 의 marklet:// 스킴이 dist-desktop 을 그대로 내준다. 상대 경로로 둔다.
    base: './',
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    esbuild: {
        pure: ['console.log', 'console.debug', 'console.info', 'console.trace'],
        drop: ['debugger'],
    },
    build: {
        outDir: 'dist-desktop',
        emptyOutDir: true,
        // Electron 의 Chromium 은 최신이다. 모바일처럼 낮은 타깃을 맞출 이유가 없다.
        target: 'chrome120',
        rollupOptions: { input: { desktop: 'desktop.html' } },
        chunkSizeWarningLimit: 1200,
    },
});
