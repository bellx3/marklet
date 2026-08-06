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

/**
 * ★★★ 2026-08-06. **검색이 통째로 터지는 입력이 있었다.**
 *
 *   다음 일치를 `indexOf(needle, i + 1)` 로 찾아서 **겹치는 일치**가 잡혔다.
 *   `....` 에서 `..` 를 찾으면 0·1·2 가 다 걸린다. 그런데 하이라이트는
 *   뒤에서부터 surroundContents 로 끼우므로 노드가 그 자리에서 잘려 짧아지고,
 *   앞쪽 일치의 끝이 이미 없는 자리를 가리킨다:
 *       DOMException: offset 5 is larger than the node's length (4)
 *
 *   드문 입력이 아니다:
 *     `..`  AI 문서의 말줄임 `...`
 *     `--`  표·구분선 `----`, 명령줄 옵션
 *     `ㅋㅋ` 한국어에서 아주 흔하다
 *     `ㄱㄱ` **초성 검색이 `기관공사` 같은 평범한 말에 걸린다**
 *
 *   그리고 터지면 사용자는 왜 안 되는지 알 방법이 없다 — 셈이 멎을 뿐이다.
 */
describe('★★ 겹치는 일치 — 검색이 터지면 안 된다', () => {
    it.each([
        ['aaaa', 'aa', 2],
        ['말줄임... 그리고', '..', 1],
        ['구분 ---- 선', '--', 2],
        ['아 ㅋㅋㅋㅋ 진짜', 'ㅋㅋ', 2],
    ])('%s 에서 %s → %i건 (터지지 않는다)', (본문, 질의, 예상) => {
        const el = host(`<p>${본문}</p>`);
        expect(() => runSearch(el, 질의)).not.toThrow();
        expect(runSearch(el, 질의).marks.length).toBe(예상);
    });

    it('★ 초성 검색이 평범한 한국어에서 터지지 않는다', () => {
        // 기관공사 → ㄱㄱㄱㅅ. `ㄱㄱ` 이 0·1 두 자리에 걸린다.
        const el = host('<p>기관공사 얘기</p>');
        expect(() => runSearch(el, 'ㄱㄱ')).not.toThrow();
        const s = runSearch(el, 'ㄱㄱ');
        expect(s.marks.length).toBe(1);
        expect(s.marks[0].textContent).toBe('기관');
    });

    it('★ 겹치지 않게 센다 (브라우저 Ctrl+F 와 같은 셈법)', () => {
        // 아이유의 → ㅇㅇㅇㅇ. 겹쳐 세면 3건, 겹치지 않게 세면 2건이다.
        const el = host('<p>아이유의 노래</p>');
        const s = runSearch(el, 'ㅇㅇ');
        expect(s.marks.length).toBe(2);
        expect(s.marks.map((m) => m.textContent)).toEqual(['아이', '유의']);
    });

    it('터진 뒤에도 글자가 남아 있어야 한다 (하이라이트가 본문을 먹지 않는다)', () => {
        const el = host('<p>말줄임... 그리고</p>');
        runSearch(el, '..');
        expect(el.textContent).toBe('말줄임... 그리고');
        clearSearch(el);
        expect(el.textContent).toBe('말줄임... 그리고');
    });

    it('겹치는 질의로도 다음/이전이 문서 순서대로 돈다', () => {
        const el = host('<p>가가가가</p>');
        let s = runSearch(el, '가가');
        expect(counterLabel(s)).toBe('1/2');
        s = step(s, 1);
        expect(counterLabel(s)).toBe('2/2');
        s = step(s, 1);
        expect(counterLabel(s)).toBe('1/2');
    });

    it('상한을 넘겨도 터지지 않는다', () => {
        const el = host(`<p>${'..'.repeat(MAX_MATCHES + 50)}</p>`);
        const s = runSearch(el, '..');
        expect(s.truncated).toBe(true);
        expect(s.marks.length).toBeLessThanOrEqual(MAX_MATCHES);
    });
});

/**
 * ★★★ 2026-08-06. **글자를 칠 때마다 화면이 굳었다.**
 *
 *   텍스트 노드마다 `parent.closest(SKIP_SELECTOR)` 를 불렀다. closest 는 조상을 타고
 *   올라가며 매번 셀렉터를 맞춰 본다. 500KB 문서는 텍스트 노드가 4만 개가 넘고
 *   요소는 7만 5천 개다 — 한 번 검색할 때마다 수십만 번 맞춰 보게 된다.
 *
 *   실측 (500KB 평범한 문서, 데스크톱 크로뮴):
 *       고치기 전   글자 하나마다  485 ~ 879ms   ·  clearSearch 110ms
 *       고친 뒤                  211 ~ 335ms   ·  clearSearch  15ms
 *   폰이면 3~5배다. 검색어를 치는 내내 화면이 멎는다. 500KB 는 확인 상자(2MB)도
 *   진행 표시(512KB)도 안 뜨는 **평범한 크기**다.
 *
 *   요소를 함께 훑으면서 제외 대상을 FILTER_REJECT 로 잘라 내면 셀렉터를
 *   요소마다 한 번만 맞춰 본다. clearSearch 의 normalize() 는 부모마다 한 번만 부른다.
 *
 * ★ 빠르게 만들면서 **건너뛰는 규칙이 그대로인지**가 관건이다. 아래가 그걸 지킨다.
 */
describe('★★ 빨라져도 건너뛸 것은 그대로 건너뛴다', () => {
    it('제외 대상의 **깊은 자손**까지 건너뛴다', () => {
        // FILTER_REJECT 는 가지를 통째로 자른다. 한 겹만 보던 게 아니어야 한다.
        const el = host(
            '<p>겉의 마크다운</p>' +
                '<span class="katex-mathml"><math><semantics><mrow><mi>마크다운</mi></mrow></semantics></math></span>' +
                '<svg><g><text><tspan>마크다운</tspan></text></g></svg>' +
                '<div class="md-block-label"><span><b>마크다운</b></span></div>',
        );
        const s = runSearch(el, '마크다운');
        expect(s.marks.length, '제외 대상 안까지 잡았다').toBe(1);
        expect(s.marks[0].closest('p')).not.toBeNull();
    });

    it('제외 대상 **다음** 형제는 다시 잡는다 (가지를 잘라도 흐름이 끊기면 안 된다)', () => {
        const el = host('<p>앞 마크다운</p><svg><text>마크다운</text></svg><p>뒤 마크다운</p>');
        const s = runSearch(el, '마크다운');
        expect(s.marks.length).toBe(2);
        expect(s.marks.map((m) => m.parentElement?.textContent)).toEqual([
            '앞 마크다운',
            '뒤 마크다운',
        ]);
    });

    it('★ 한 문단에 표시가 여럿이어도 지운 뒤 다시 하나로 합쳐진다', () => {
        // normalize() 를 부모마다 한 번만 부르도록 바꿨다 — 합쳐지는 것은 그대로여야 한다.
        const el = host('<p>가 나 가 나 가 나 가</p>');
        expect(runSearch(el, '가').marks.length).toBe(4);
        clearSearch(el);

        const p = el.querySelector('p')!;
        expect(p.childNodes.length, `${p.childNodes.length}조각으로 쪼개진 채 남았다`).toBe(1);
        expect(p.textContent).toBe('가 나 가 나 가 나 가');

        // 쪼개진 채 남으면 다음 검색이 낱말을 놓친다.
        expect(runSearch(el, '가 나').marks.length).toBe(3);
    });

    it('여러 문단에 걸쳐 있어도 전부 합쳐진다', () => {
        const el = host('<p>가나 가나</p><p>가나 가나</p><p>가나</p>');
        expect(runSearch(el, '가나').marks.length).toBe(5);
        clearSearch(el);
        for (const p of el.querySelectorAll('p')) {
            expect(p.childNodes.length).toBe(1);
        }
    });
});
