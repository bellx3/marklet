import type MarkdownIt from 'markdown-it';
import { unwrapPlugin } from './renderer';

/**
 * KaTeX JS 75.4KB + CSS 24.7KB + woff2 20개 296KB = 약 396KB(전부 gzip 실측).
 * 수식 없는 문서가 대부분이므로 상시 로딩할 크기가 아니다.
 */

/** 문서에 수식이 있는지 값싸게 판정. 오탐이 나도 396KB를 한 번 더 받을 뿐 깨지지 않는다. */
export function looksLikeMath(source: string): boolean {
    return /(\$\$[\s\S]*?\$\$)|(\$[^\s$][^$\n]*\$)|\\\(|\\\[|\\begin\{/.test(source);
}

/**
 * 내려받은 KaTeX 모듈. **"이미 붙였다"가 아니라 "이미 받았다"를 기억한다.**
 *
 * ★★ 여기에 boolean 가드를 두지 마라. 2026-08-05에 그걸로 사고가 났다 —
 *   `if (mathLoaded) return;` 이 있었는데, 뷰어는 문서를 열 때마다
 *   **새 markdown-it 인스턴스를 만든다**(설정이 파서에 들어가므로 재사용할 수 없다).
 *   그래서 첫 문서만 수식이 그려지고, 나갔다 다시 들어오면 `$...$` 가 글자 그대로 보였다.
 *   `rerender()`(보기 설정 변경)도 같은 경로라 함께 깨졌다.
 *
 *   받는 것은 한 번, **붙이는 것은 인스턴스마다**다.
 */
let katexModules: Promise<[unknown, unknown]> | null = null;

/**
 * 수식이 있을 때만 KaTeX 를 붙인다. md 인스턴스를 그 자리에서 확장한다.
 *
 * ★ md.parse() 전에 await 해야 한다. 렌더 도중에 붙이면 앞 청크에만 수식이 안 들어간다.
 */
export async function ensureMath(md: MarkdownIt): Promise<void> {
    // 약속(promise)을 캐시한다. 동시에 두 번 불려도 내려받기는 한 번이다.
    katexModules ??= Promise.all([
        import('@vscode/markdown-it-katex'),
        import('katex/dist/katex.min.css'),
    ]);
    const [katexPlugin] = await katexModules;

    md.use(unwrapPlugin(katexPlugin), {
        throwOnError: false, // 깨진 수식 때문에 문서 전체가 죽으면 안 된다
        errorColor: '#cc0000',
        strict: false, // 한글이 수식 안에 들어와도 경고만
        trust: false, // ★ \href, \htmlData 등 HTML 생성 명령 차단. 절대 true 로 바꾸지 마라
    });
}

/** 내려받기 캐시를 비운다. 테스트 전용. */
export function __resetMathForTest(): void {
    katexModules = null;
}
