import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * 데스크톱(Electron) 렌더러 빌드. 모바일(vite.config.ts → www/)과 **출력이 완전히 분리**돼 있다.
 *
 * ★ www/ 에 섞지 마라. www/ 는 cap sync 가 통째로 APK 에 넣는다 —
 *   데스크톱 번들이 폰 앱 안에 실려 나간다.
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
