import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * KaTeX 는 @font-face 마다 woff2 / woff / ttf 세 벌을 참조한다.
 * Vite 가 그 셋을 전부 번들에 넣어 **876KB(woff 336KB + ttf 540KB)가 그냥 낭비된다**
 * (2026-08-03 실측). minSdk 26 = Android 8 = Chrome 60+ 이고 woff2 는 Chrome 36 부터
 * 지원하므로 woff/ttf 를 실을 이유가 없다.
 *
 * 02_기술_설계서.md 6-6절이 "빌드 후 www/assets 에 .ttf 가 있으면 안 된다"고 적어 둔
 * 바로 그 항목이다. 문서는 "CSS 사본을 만들어라"라고 했지만, 사본은 KaTeX 를 올릴 때마다
 * 손으로 다시 만들어야 해서 썩는다. 빌드에서 걷어내는 쪽이 유지된다.
 */
function stripLegacyFontFormats(): Plugin {
    const LEGACY_SRC =
        /,\s*url\([^)]+\.woff\)\s*format\("woff"\)|,\s*url\([^)]+\.ttf\)\s*format\("truetype"\)/g;

    return {
        name: 'marklet:strip-legacy-font-formats',
        apply: 'build',
        generateBundle(_options, bundle) {
            const kept = new Set<string>();

            // 1. CSS 에서 woff/ttf src 를 지운다
            for (const asset of Object.values(bundle)) {
                if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue;
                const before = String(asset.source);
                const after = before.replace(LEGACY_SRC, '');
                if (after !== before) asset.source = after;
                for (const m of after.matchAll(/url\(\/assets\/([^)]+)\)/g)) kept.add(m[1]);
            }

            // 2. 아무 CSS 도 참조하지 않게 된 woff/ttf 를 번들에서 뺀다
            let removed = 0;
            let bytes = 0;
            for (const [key, asset] of Object.entries(bundle)) {
                if (asset.type !== 'asset') continue;
                if (!/\.(woff|ttf)$/.test(asset.fileName)) continue;
                const base = asset.fileName.replace(/^assets\//, '');
                if (kept.has(base)) continue;
                bytes += (asset.source as Uint8Array).length ?? 0;
                delete bundle[key];
                removed++;
            }

            if (removed > 0) {
                this.info(
                    `구형 폰트 ${removed}개 제거 (${(bytes / 1024).toFixed(0)}KB) — woff2 만 남긴다`,
                );
            }
        },
    };
}

export default defineConfig(({ mode }) => ({
    root: './',
    plugins: [stripLegacyFontFormats()],
    /*
     * ★ 버전을 화면에 손으로 적지 마라. package.json 이 유일한 출처다
     *   (android/app/build.gradle 도 같은 값을 읽어 versionName 을 만든다).
     *   두 곳에 적으면 반드시 어긋나고, 사용자 문의를 받을 때 엉뚱한 버전을 보게 된다.
     */
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    esbuild: {
        /*
         * 릴리스에서 잡음 로그를 지운다. ★ 다만 **error 와 warn 은 남긴다.**
         *
         * 예전에는 `drop: ['console']` 로 전부 지웠는데, 2026-08-04에 그 대가를 치렀다 —
         * 후원 버튼이 비활성으로 남는 문제를 쫓는데 **우리 쪽 진단이 하나도 안 남아 있었다.**
         * 결국 플러그인의 네이티브 logcat 으로만 원인을 찾았다.
         * 결제·저장처럼 **조용히 실패하면 사용자가 손해를 보는 경로**에 로그가 없으면
         * 다음에도 똑같이 막막해진다.
         *
         * ★ logcat 은 안드로이드 4.1 부터 **다른 앱이 읽을 수 없다**(adb 로만 본다).
         *   그래서 기기를 벗어나지 않는다는 약속과 어긋나지 않는다.
         *   다만 그렇다고 **문서 내용을 로그에 흘리지는 마라** — mermaid.ts 참고.
         *
         * drop 이 아니라 pure 를 쓰는 이유: drop 은 console 전체를 통으로 지운다.
         * pure 는 "부작용 없음"으로 표시만 하므로 결과를 안 쓰는 호출만 사라진다.
         */
        pure:
            mode === 'production'
                ? ['console.log', 'console.debug', 'console.info', 'console.trace']
                : [],
        drop: mode === 'production' ? ['debugger'] : [],
    },
    build: {
        // ★ capacitor.config.json 의 webDir 과 반드시 같아야 한다.
        //   Vite 기본값 dist 를 그대로 두면 cap sync 가 빈 www 를 복사해 흰 화면이 된다.
        outDir: 'www',
        emptyOutDir: true,
        // 안드로이드 WebView 하한 고려. Capacitor 8은 최신 WebView를 요구한다.
        target: 'es2020',
        cssCodeSplit: true,
        reportCompressedSize: true,
        chunkSizeWarningLimit: 200, // KB, 원시 크기(gzip 아님)
        rollupOptions: {
            input: {
                main: 'index.html',
                licenses: 'licenses.html',
            },
            output: {
                manualChunks(id) {
                    /*
                     * ★★★ Vite 의 preload 헬퍼를 **반드시 자기 청크로 떼어 낸다.**
                     *
                     *   이걸 안 하면 Rollup 이 그 헬퍼를 아무 청크에나 넣는데,
                     *   실제로 **mermaid 청크(902KB)에 들어갔다.** 헬퍼는 동적 import 를
                     *   부르는 쪽(=초기 코드)이 정적으로 import 하므로, 결과적으로
                     *   index.html 이 mermaid 청크를 modulepreload 하고 부팅 때
                     *   902KB 를 통째로 받아 실행했다 —
                     *   **제품 결정서 11.1 의 1번 규칙("mermaid 를 정적 import 하지 않는다")이
                     *   산출물에서 깨져 있었다.** (2026-08-05 빌드 산출물에서 발견)
                     *
                     *   node_modules 검사보다 **먼저** 와야 한다. 헬퍼는 가상 모듈이라
                     *   경로에 node_modules 가 없어서 아래 return undefined 에 먹힌다.
                     */
                    if (id.includes('vite/preload-helper')) return 'preload-helper';

                    /*
                     * ★★ **node_modules 만 본다.** 아래 조건은 경로 문자열 검사라서
                     *   우리 소스인 `src/markdown/mermaid.ts` 도 함께 걸린다.
                     *   그러면 그 파일이 import 하는 것들(i18n 카탈로그 등)이 통째로
                     *   지연 청크로 끌려가고, 초기 화면이 그 문자열을 못 찾는다 —
                     *   2026-08-04에 실제로 겪었다: 시작 화면은 영어인데
                     *   뷰어 상단 바만 한국어로 남았다.
                     *   지연시켜야 하는 것은 **라이브러리**지 우리 래퍼가 아니다
                     *   (래퍼는 viewer-screen 이 정적으로 import 하므로 어차피 초기 코드다).
                     */
                    if (!id.includes('node_modules')) return undefined;

                    // KaTeX·Mermaid 는 반드시 별도 청크로 — 지연 로딩의 전제다.
                    // ★ mermaid 를 이 목록에서 빼면 초기 번들에 섞여 들어가 예산 검사가 실패한다.
                    if (id.includes('mermaid')) return 'mermaid';
                    if (id.includes('katex')) return 'katex';
                    if (id.includes('highlight.js')) return 'hljs';
                    if (
                        id.includes('markdown-it') ||
                        id.includes('dompurify') ||
                        id.includes('js-yaml')
                    ) {
                        return 'markdown';
                    }
                    return undefined;
                },
            },
        },
    },
    server: {
        // scripts/dev-device.cjs 가 이 포트로 adb reverse 를 건다. 바꾸면 두 곳을 같이 고칠 것.
        port: 3000,
        open: true,
    },
}));
