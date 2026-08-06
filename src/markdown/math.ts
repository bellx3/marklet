import type MarkdownIt from 'markdown-it';
import { unwrapPlugin } from './renderer';

/**
 * KaTeX JS 75.4KB + CSS 24.7KB + woff2 20개 296KB = 약 396KB(전부 gzip 실측).
 * 수식 없는 문서가 대부분이므로 상시 로딩할 크기가 아니다.
 */

/**
 * 문서에 수식이 있는지 값싸게 판정. 오탐이 나도 396KB를 한 번 더 받을 뿐 깨지지 않는다.
 *
 * ★ ```math 펜스도 본다. 여기 없으면 KaTeX 를 아예 안 받아서 그릴 기회조차 없다.
 */
export function looksLikeMath(source: string): boolean {
    return /(\$\$[\s\S]*?\$\$)|(\$[^\s$][^$\n]*\$)|\\\(|\\\[|\\begin\{|```math/.test(source);
}

/**
 * ★★ ChatGPT 구분자 `\(…\)` · `\[…\]`.
 *
 *   @vscode/markdown-it-katex 1.1.2 는 **달러만 안다.** 그런데 우리 looksLikeMath 는
 *   `\(` 를 수식으로 세고 있었다 — 396KB 를 받아 놓고 아무것도 안 그렸다는 뜻이다.
 *   더 나쁜 건 결과물이다. markdown-it 의 escape 규칙이 백슬래시를 먹어서
 *       `넓이는 \(\pi r^2\) 입니다`  →  `넓이는 (pi r^2) 입니다`
 *   가 된다. 수식이 안 나오는 게 아니라 **말이 안 되는 글자로 바뀐다.**
 *   이 앱은 AI 가 쓴 문서를 보는 앱이고, OpenAI 계열은 이 구분자를 기본으로 쓴다.
 *
 * ★ escape 규칙 **앞에** 꽂아야 한다. 뒤에 꽂으면 백슬래시가 이미 먹힌 뒤라 늦다.
 * ★ 코드는 건드리지 않는다 — 인라인 코드는 backticks 규칙이 통째로 집어삼킨 뒤라
 *   이 규칙이 `\(` 를 볼 일이 없고, 펜스 코드는 애초에 인라인 규칙이 안 돈다.
 *   (원본 문자열을 통째로 치환하는 방식은 이걸 못 지킨다. 그래서 규칙으로 넣는다.)
 */
function latexDelimiters(md: MarkdownIt): void {
    /** `\[` 로 시작하는 줄을 통째로 블록 수식으로. ChatGPT 가 여러 줄로 뱉는 모양이다. */
    md.block.ruler.before(
        'fence',
        'math_bracket_block',
        (state, startLine, endLine, silent) => {
            const begin = state.bMarks[startLine] + state.tShift[startLine];
            if (state.src.slice(begin, begin + 2) !== '\\[') return false;

            for (let line = startLine; line < endLine; line++) {
                const text = state.src.slice(state.bMarks[line], state.eMarks[line]);
                const close = text.indexOf('\\]');
                if (close === -1) continue;
                if (silent) return true;

                const from = begin + 2;
                const to = state.bMarks[line] + close;
                const token = state.push('math_block', 'math', 0);
                token.block = true;
                token.markup = '\\[';
                token.content = state.src.slice(from, to).trim();
                token.map = [startLine, line + 1];
                state.line = line + 1;
                return true;
            }
            return false; // 닫는 짝이 없으면 평범한 글이다. 건드리지 않는다.
        },
        { alt: ['paragraph', 'blockquote', 'list'] },
    );

    md.inline.ruler.before('escape', 'math_latex_delims', (state, silent) => {
        const src = state.src;
        if (src.charCodeAt(state.pos) !== 0x5c /* \ */) return false;

        const open = src.charCodeAt(state.pos + 1);
        const inline = open === 0x28; /* ( */
        if (!inline && open !== 0x5b /* [ */) return false;

        const closer = inline ? '\\)' : '\\]';
        const end = src.indexOf(closer, state.pos + 2);
        if (end === -1) return false;

        if (!silent) {
            /*
             * ★ 토큰 이름은 플러그인이 이미 등록해 둔 것을 그대로 쓴다.
             * ★ 여기 오는 `\[…\]` 는 **문장 한가운데**다 — 줄 맨 앞이었다면 위 블록 규칙이
             *   이미 가져갔다. 그래서 블록으로 그리지 않고 인라인으로 그린다.
             *   블록 렌더러는 `<p>` 를 뱉는데, 그게 문단 안에 들어가면 브라우저가
             *   바깥 `<p>` 를 강제로 닫아서 **한 문장이 세 조각으로 쪼개진다.**
             */
            const token = state.push('math_inline', 'math', 0);
            token.markup = inline ? '\\(' : '\\[';
            token.content = src.slice(state.pos + 2, end).trim();
        }
        state.pos = end + 2;
        return true;
    });
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

        /*
         * ★ 둘 다 AI 가 실제로 뱉는 모양이다. 기본값이 꺼짐이라 켜 줘야 한다.
         *   enableBareBlocks : `$$` 없이 `\begin{align}…\end{align}` 만 있는 경우.
         *                      looksLikeMath 는 예전부터 이걸 세고 있었다 — 감지만 하고
         *                      못 그리던 쪽을 맞춘 것이다.
         *   enableFencedBlocks : ```math 펜스. 안 켜면 수식이 코드 블록으로 보인다.
         */
        enableBareBlocks: true,
        enableFencedBlocks: true,
    });

    md.use(latexDelimiters);
}

/** 내려받기 캐시를 비운다. 테스트 전용. */
export function __resetMathForTest(): void {
    katexModules = null;
}
