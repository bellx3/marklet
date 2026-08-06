import { describe, it, expect, beforeEach } from 'vitest';
import { createMarkdownIt } from './renderer';
import { looksLikeMath, ensureMath, __resetMathForTest } from './math';

/**
 * KaTeX 지연 로딩 (6-6절).
 *
 * ★★ 이 파일이 존재하는 이유. 2026-08-05 사장님 보고:
 *   "예제 문서에 처음 들어가면 수식이 잘 나오는데, 나갔다 다시 들어가면 깨집니다."
 *
 *   원인은 `let mathLoaded = false; if (mathLoaded) return;` 였다.
 *   뷰어는 문서를 열 때마다 **새 markdown-it 인스턴스**를 만드는데(설정이 파서에 들어간다),
 *   그 가드가 "이미 로드했다"로 판단해 **새 인스턴스에는 플러그인을 안 붙였다.**
 *   내려받기는 한 번, 붙이는 것은 인스턴스마다여야 한다.
 */

beforeEach(() => {
    __resetMathForTest();
});

describe('수식 판정 — 값싼 어림짐작이다', () => {
    it.each([
        ['$E = mc^2$', true],
        ['$$\\int_0^1 x\\,dx$$', true],
        ['\\(a+b\\)', true],
        ['\\begin{cases} x \\end{cases}', true],
        ['그냥 글입니다', false],
        ['값이 $ 하나만 있으면 아니다', false],
    ])('%s → %s', (src, expected) => {
        expect(looksLikeMath(src)).toBe(expected);
    });

    /*
     * ★ 오탐을 허용하는 판정이다. 달러 기호가 두 번 나오는 가격 문장도 참으로 본다.
     *   대가는 **KaTeX 396KB 를 괜히 한 번 더 받는 것뿐**이고, 화면은 멀쩡하다 —
     *   아래 테스트가 그 '멀쩡함'을 고정한다. 이게 깨지면 판정을 조여야 한다.
     */
    it('가격처럼 달러가 둘인 문장도 참으로 본다 (오탐 허용)', () => {
        expect(looksLikeMath('가격은 $5 이고 배송비는 $3 입니다')).toBe(true);
    });

    it('★ 그렇게 오탐이 나도 가격 문장이 수식으로 망가지지 않는다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureMath(md);
        const html = md.render('가격은 $5 이고 배송비는 $3 입니다\n');
        expect(html).toContain('가격은 $5 이고 배송비는 $3 입니다');
        expect(html).not.toContain('katex');
    });
});

describe('★ 인스턴스마다 붙는다 (같은 문서를 다시 열어도 수식이 나온다)', () => {
    const SRC = '수식: $E = mc^2$\n';

    it('첫 번째 인스턴스에 수식이 그려진다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureMath(md);
        expect(md.render(SRC)).toContain('katex');
    });

    /*
     * ★ 이 테스트가 그 버그를 잡는다. `if (mathLoaded) return;` 를 되살리면
     *   두 번째 인스턴스에는 플러그인이 안 붙어 `$E = mc^2$` 가 글자 그대로 남는다.
     */
    it('★ 두 번째로 만든 인스턴스에도 그려진다', async () => {
        const first = createMarkdownIt({ breaks: true });
        await ensureMath(first);
        expect(first.render(SRC)).toContain('katex');

        const second = createMarkdownIt({ breaks: true });
        await ensureMath(second);
        const html = second.render(SRC);

        expect(html).toContain('katex');
        expect(html).not.toContain('$E = mc^2$');
    });

    it('세 번을 열어도 매번 그려진다', async () => {
        for (let i = 0; i < 3; i++) {
            const md = createMarkdownIt({ breaks: i % 2 === 0 });
            await ensureMath(md);
            expect(md.render(SRC), `${i + 1}번째`).toContain('katex');
        }
    });

    it('동시에 불러도 각자 붙는다', async () => {
        const a = createMarkdownIt({ breaks: true });
        const b = createMarkdownIt({ breaks: true });
        await Promise.all([ensureMath(a), ensureMath(b)]);
        expect(a.render(SRC)).toContain('katex');
        expect(b.render(SRC)).toContain('katex');
    });

    it('★ 깨진 수식이 문서 전체를 죽이지 않는다 (throwOnError: false)', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureMath(md);
        const html = md.render('앞 문단\n\n$\\frac{1}{$\n\n뒤 문단\n');
        expect(html).toContain('앞 문단');
        expect(html).toContain('뒤 문단');
    });
});

/**
 * ★★★ 2026-08-06. **감지는 하는데 그리지는 못하고 있었다.**
 *
 *   looksLikeMath 는 예전부터 `\(` 와 `\begin{` 를 수식으로 셌다. 그런데
 *   @vscode/markdown-it-katex 1.1.2 는 기본값으로 **달러만** 안다.
 *   결과: KaTeX 396KB 를 받아 놓고 아무것도 안 그렸다. 값만 치르고 얻는 게 없었다.
 *
 *   화면에 뜨던 것:  `넓이는 \(\pi r^2\) 입니다`  →  `넓이는 (pi r^2) 입니다`
 *   수식이 안 나오는 정도가 아니라 markdown-it 의 escape 규칙이 백슬래시를 먹어서
 *   **말이 안 되는 글자로 바뀌었다.**
 *
 *   이게 왜 중요한가: 이 앱은 AI 가 쓴 문서를 보는 앱이고, OpenAI 계열 모델은
 *   `\(…\)` · `\[…\]` 를 기본 구분자로 쓴다.
 */
describe('★★ AI 가 실제로 뱉는 수식 구분자', () => {
    async function render(src: string): Promise<string> {
        const md = createMarkdownIt({ breaks: true });
        await ensureMath(md);
        return md.render(src);
    }

    it.each([
        ['\\(…\\) 인라인', String.raw`넓이는 \(\pi r^2\) 입니다.`],
        ['\\[…\\] 한 줄', String.raw`\[ E = mc^2 \]`],
        ['\\[…\\] 여러 줄', '\\[\nE = mc^2\n\\]'],
        ['\\[…\\] 문장 속', String.raw`식은 \[x^2\] 입니다.`],
        ['$$ 없는 \\begin{align}', '\\begin{align}\na &= b\n\\end{align}'],
        ['```math 펜스', '```math\nE = mc^2\n```'],
    ])('%s → 수식으로 그린다', async (_name, src) => {
        expect(await render(src)).toContain('katex');
    });

    it('```math 펜스도 감지한다 (감지 못 하면 KaTeX 를 아예 안 받는다)', () => {
        expect(looksLikeMath('```math\nE = mc^2\n```')).toBe(true);
    });

    it('★ 백슬래시가 먹혀서 글자가 망가지지 않는다', async () => {
        const html = await render(String.raw`넓이는 \(\pi r^2\) 입니다.`);
        expect(html, '\\pi 가 pi 로 뭉개졌다').not.toContain('(pi r^2)');
        expect(html).toContain('넓이는');
        expect(html).toContain('입니다');
    });

    /*
     * ★★ 원본 문자열을 통째로 치환하는 방식(`\(` → `$`)으로는 이 두 개를 못 지킨다.
     *   코드 안의 백슬래시 괄호는 C·정규식·윈도우 경로에서 흔하다.
     *   그래서 markdown-it 규칙으로 넣었다 — 코드는 규칙이 돌기 전에 이미 삼켜진다.
     */
    it('★ 인라인 코드 안의 \\( \\) 는 건드리지 않는다', async () => {
        const html = await render('`' + String.raw`\(리터럴\)` + '` 은 그대로');
        expect(html).toContain('<code>');
        expect(html).toContain(String.raw`\(리터럴\)`);
        expect(html).not.toContain('katex');
    });

    it('★ 펜스 코드 안의 \\( \\) 는 건드리지 않는다', async () => {
        const html = await render('```c\nprintf("\\(x\\)");\n```');
        expect(html).toContain('<pre>');
        expect(html).not.toContain('katex');
    });

    it('★ 닫는 짝이 없으면 평범한 글로 둔다', async () => {
        const html = await render(String.raw`경로는 \(열린 채로 남는다`);
        expect(html).not.toContain('katex');
        expect(html).toContain('열린 채로 남는다');
    });

    it('★ 문장 한가운데 \\[…\\] 는 문단을 쪼개지 않는다', async () => {
        // 블록 렌더러는 <p> 를 뱉는다. 그게 문단 안에 들어가면 브라우저가 바깥 <p> 를
        // 강제로 닫아 한 문장이 세 조각이 된다. 그래서 여기서는 인라인으로 그린다.
        const html = await render(String.raw`식은 \[x^2\] 입니다.`);
        expect(html).not.toContain('<p>식은 <p');
        expect(html).toContain('katex');
    });

    it('빈 줄 없이 이어져도 앞 문단을 끊고 블록으로 그린다', async () => {
        const html = await render('설명입니다\n\\[\nE = mc^2\n\\]\n그 다음 문장');
        expect(html).toContain('katex-display');
        expect(html).toContain('설명입니다');
        expect(html).toContain('그 다음 문장');
    });

    it.each([
        ['목록 안', '- 항목\n  \\[ x^2 \\]'],
        ['인용 안', '> 인용\n> \\[ x^2 \\]'],
    ])('%s 에서도 그린다', async (_name, src) => {
        expect(await render(src)).toContain('katex');
    });

    it('★ 깨진 \\( \\) 수식도 문서를 죽이지 않는다', async () => {
        const html = await render(String.raw`앞\(\frac{1}{\)뒤`);
        expect(html).toContain('앞');
        expect(html).toContain('뒤');
    });
});
