import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * 데스크톱 렌더러 빌드 → src-tauri/frontend/ (Tauri 폴더 안이라 그 폴더의 .gitignore 가 막아 준다).
 * `src-tauri/tauri.conf.json` 의 beforeBuildCommand 가 부른다.
 */
export default defineConfig({
    root: './',
    // Tauri 가 앱 자산을 http://tauri.localhost/ 에서 내준다. 상대 경로로 둔다.
    base: './',
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    esbuild: {
        pure: ['console.log', 'console.debug', 'console.info', 'console.trace'],
        drop: ['debugger'],
    },
    build: {
        outDir: 'src-tauri/frontend',
        emptyOutDir: true,
        // WebView2 는 Edge 의 엔진이라 늘 최신이다. 낮은 타깃을 맞출 이유가 없다.
        target: 'chrome120',
        rollupOptions: { input: { desktop: 'desktop.html' } },
        chunkSizeWarningLimit: 1200,
    },
});
