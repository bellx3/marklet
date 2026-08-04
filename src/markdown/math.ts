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

let mathLoaded = false;

/**
 * 수식이 있을 때만 KaTeX 를 붙인다. md 인스턴스를 그 자리에서 확장한다.
 *
 * ★ md.parse() 전에 await 해야 한다. 렌더 도중에 붙이면 앞 청크에만 수식이 안 들어간다.
 */
export async function ensureMath(md: MarkdownIt): Promise<void> {
    if (mathLoaded) return;
    const [katexPlugin] = await Promise.all([
        import('@vscode/markdown-it-katex'),
        import('katex/dist/katex.min.css'),
    ]);
    md.use(unwrapPlugin(katexPlugin), {
        throwOnError: false, // 깨진 수식 때문에 문서 전체가 죽으면 안 된다
        errorColor: '#cc0000',
        strict: false, // 한글이 수식 안에 들어와도 경고만
        trust: false, // ★ \href, \htmlData 등 HTML 생성 명령 차단. 절대 true 로 바꾸지 마라
    });
    mathLoaded = true;
}

/**
 * mathLoaded 를 되돌린다. 테스트 전용.
 * 앱 코드에서 부르지 마라 — md 인스턴스에 붙은 규칙은 되돌려지지 않는다.
 */
export function __resetMathForTest(): void {
    mathLoaded = false;
}
