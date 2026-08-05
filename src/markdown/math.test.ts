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
