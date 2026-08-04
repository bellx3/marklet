import { describe, it, expect } from 'vitest';
import { runSearch, clearSearch, step, counterLabel, MAX_MATCHES } from './doc-search';

/**
 * 8-6절 "테스트로 고정할 것" 8항목.
 *
 * ★ 여기는 목이 없다. 실제 DOM 에 Range 로 <mark> 를 끼우는 코드라
 *   jsdom 에서 그대로 돌리는 게 맞다(11-1절 1번).
 */

function host(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
}

describe('runSearch — 초성', () => {
    it('★ 초성 2자 ㅁㅋ 로 마크다운이 잡힌다', () => {
        const el = host('<p>마크다운 뷰어</p>');
        const s = runSearch(el, 'ㅁㅋ');
        expect(s.marks.length).toBe(1);
        expect(s.marks[0].textContent).toBe('마크');
    });

    it('★ 초성 1자는 검색이 실행되지 않는다 (본문 오탐 폭증 방지)', () => {
        const el = host('<p>마크다운 뷰어</p>');
        const s = runSearch(el, 'ㅁ');
        expect(s.marks.length).toBe(0);
        expect(s.current).toBe(-1);
        expect(el.querySelector('mark')).toBeNull();
    });

    it("★ '마크' 는 초성 모드가 아니라 일반 부분 문자열이다", () => {
        const el = host('<p>마크다운과 ㅁㅋ 표기</p>');
        const s = runSearch(el, '마크');
        expect(s.marks.length).toBe(1);
        expect(s.marks[0].textContent).toBe('마크');
    });

    it('초성 하이라이트 위치가 원문과 어긋나지 않는다', () => {
        const el = host('<p>안녕 마크다운</p>');
        const s = runSearch(el, 'ㅁㅋㄷㅇ');
        expect(s.marks[0].textContent).toBe('마크다운');
    });
});

describe('runSearch — 일반', () => {
    it('대소문자를 무시한다', () => {
        const el = host('<p>README and readme</p>');
        expect(runSearch(el, 'ReAdMe').marks.length).toBe(2);
    });

    it('★ 같은 노드에 3회 일치하면 <mark> 3개가 문서 순서대로 만들어진다', () => {
        const el = host('<p>가 나 가 다 가</p>');
        const s = runSearch(el, '가');
        expect(s.marks.length).toBe(3);
        // 문서 순서 확인 — 앞의 것이 뒤의 것보다 먼저 온다
        for (let i = 1; i < s.marks.length; i++) {
            const pos = s.marks[i - 1].compareDocumentPosition(s.marks[i]);
            expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
    });

    it('여러 블록에 걸쳐 문서 순서를 지킨다', () => {
        const el = host('<p>가 하나</p><p>가 둘</p><p>가 셋</p>');
        const s = runSearch(el, '가');
        expect(s.marks.length).toBe(3);
        expect(s.marks[0].closest('p')?.textContent).toContain('하나');
        expect(s.marks[2].closest('p')?.textContent).toContain('셋');
    });

    it('코드 블록 안도 검색한다', () => {
        const el = host('<pre><code>const 마크 = 1;</code></pre>');
        expect(runSearch(el, '마크').marks.length).toBe(1);
    });

    it('★ KaTeX 수식은 1회만 잡힌다 (.katex-mathml 을 건너뛴다)', () => {
        const el = host(
            '<span class="katex">' +
                '<span class="katex-mathml"><math><mi>알파</mi></math></span>' +
                '<span class="katex-html">알파</span>' +
                '</span>',
        );
        expect(runSearch(el, '알파').marks.length).toBe(1);
    });

    it('SVG · 블록 라벨은 건너뛴다', () => {
        const el = host(
            '<div class="md-block-label">Mermaid 다이어그램</div>' +
                '<svg><text>Mermaid</text></svg>' +
                '<p>Mermaid 본문</p>',
        );
        expect(runSearch(el, 'Mermaid').marks.length).toBe(1);
    });

    it('빈 질의는 아무것도 잡지 않는다', () => {
        const el = host('<p>내용</p>');
        expect(runSearch(el, '   ').marks.length).toBe(0);
    });
});

describe('clearSearch', () => {
    it('★ 텍스트 노드가 다시 하나로 합쳐진다 (normalize 확인)', () => {
        const el = host('<p>마크다운</p>');
        runSearch(el, '마크');
        const p = el.querySelector('p')!;
        expect(p.childNodes.length).toBeGreaterThan(1);

        clearSearch(el);
        expect(p.querySelector('mark')).toBeNull();
        expect(p.childNodes.length).toBe(1);
        expect(p.textContent).toBe('마크다운');
    });

    it('★ 검색 → 해제 → 재검색해도 개수가 같다 (노드 쪼개짐 회귀)', () => {
        const el = host('<p>마크다운 마크다운 마크다운</p>');
        const first = runSearch(el, '마크다운').marks.length;
        clearSearch(el);
        const second = runSearch(el, '마크다운').marks.length;
        clearSearch(el);
        const third = runSearch(el, '마크다운').marks.length;
        expect([first, second, third]).toEqual([3, 3, 3]);
    });

    it('경계에 걸친 단어도 해제 후 다시 잡힌다', () => {
        const el = host('<p>마크다운</p>');
        runSearch(el, '마크'); // '마크' + '다운' 으로 쪼개진다
        clearSearch(el);
        expect(runSearch(el, '크다').marks.length).toBe(1);
    });
});

describe('step · counterLabel', () => {
    it('다음/이전이 끝에서 처음으로 돈다', () => {
        const el = host('<p>가 가 가</p>');
        let s = runSearch(el, '가');
        expect(s.current).toBe(0);
        s = step(s, 1);
        expect(s.current).toBe(1);
        s = step(s, 1);
        expect(s.current).toBe(2);
        s = step(s, 1);
        expect(s.current).toBe(0); // 한 바퀴
        s = step(s, -1);
        expect(s.current).toBe(2);
    });

    it('현재 항목만 is-current 를 갖는다', () => {
        const el = host('<p>가 가 가</p>');
        const s = step(runSearch(el, '가'), 1);
        const current = el.querySelectorAll('mark.is-current');
        expect(current.length).toBe(1);
        expect(current[0]).toBe(s.marks[1]);
    });

    it('0건과 상한 초과를 구분해 표시한다', () => {
        expect(counterLabel({ marks: [], current: -1, truncated: false })).toBe('0/0');
        expect(
            counterLabel({
                marks: [document.createElement('mark')],
                current: 0,
                truncated: false,
            }),
        ).toBe('1/1');
        expect(
            counterLabel({
                marks: [document.createElement('mark')],
                current: 0,
                truncated: true,
            }),
        ).toBe(`1/${MAX_MATCHES}+`);
    });

    it('★ 상한을 넘으면 truncated 가 서고 라벨이 500+ 가 된다 (조용히 자르지 않는다)', () => {
        const el = host(`<p>${'가 '.repeat(MAX_MATCHES + 1)}</p>`);
        const s = runSearch(el, '가');
        expect(s.truncated).toBe(true);
        expect(s.marks.length).toBeLessThanOrEqual(MAX_MATCHES);
        expect(counterLabel(s)).toBe(`1/${MAX_MATCHES}+`);
    });
});
