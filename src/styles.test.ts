import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * 11-2절 #21 · 11-3절.
 *
 * ★ 왜 이 테스트가 필요한가. 픽셀오아시스에서 `.hidden{display:none}` 이 맨 위에 놓이고
 *   그 뒤의 컴포넌트 클래스가 display 를 지정하자 **같은 명시도에서 나중 선언이 이겼다.**
 *   6개 클래스 중 5개가 "숨겼는데 화면에 보이고 눌러도 반응이 없는" 상태였다.
 *   순서가 전부다 — 그래서 브라우저 없이 판정할 수 있게 파일을 직접 읽어 검사한다.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * 주석을 걷어낸 CSS.
 * ★ 이 파일들은 주석에 규칙의 근거를 길게 적어 두었고, 그 안에 `left: 50%` 같은
 *   '하지 말 것'이 그대로 인용돼 있다. 주석째로 검사하면 헛된 실패가 난다.
 */
const readCss = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 선택자가 정확히 일치하는 규칙 블록들의 본문을 모아 돌려준다.
 * ★ 정규식으로 `body {` 를 찾으면 `html,\nbody {` 리셋 블록까지 걸린다.
 *   그 블록의 `padding: 0` 은 문제가 아니므로 구분해야 한다.
 */
function rule(css: string, selector: string): string {
    let out = '';
    const re = /([^{}]+)\{([^}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
        const selectors = m[1].split(',').map((s) => s.trim());
        if (selectors.length === 1 && selectors[0] === selector) out += `${m[2]}\n`;
    }
    return out;
}

describe('CSS import 순서', () => {
    it('utilities.css 가 마지막 CSS import 다', () => {
        const src = read('./main.ts');
        const imports = [...src.matchAll(/^import\s+'(\.\/styles\/[^']+)';$/gm)].map((m) => m[1]);
        expect(imports.length).toBeGreaterThan(1);
        expect(imports[imports.length - 1]).toBe('./styles/utilities.css');
    });

    it('utilities.css 외의 CSS 는 [hidden] 을 재정의하지 않는다', () => {
        for (const f of ['base.css', 'markdown.css', 'hljs.css', 'components.css']) {
            expect(readCss(`./styles/${f}`)).not.toMatch(/\[hidden\]/);
        }
    });

    it('utilities.css 가 [hidden] 을 !important 로 강제한다', () => {
        const css = readCss('./styles/utilities.css');
        expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    });
});

describe('안전영역 규칙 (2026-08-03 실기기 확정)', () => {
    it('★ body 에 padding-top 을 주지 않는다 — sticky 상단 바가 펀치홀과 겹친다', () => {
        const css = readCss('./styles/base.css');
        const body = rule(css, 'body');
        expect(body).not.toMatch(/padding-top/);
        expect(body).not.toMatch(/^\s*padding:/m); // 단축 속성도 금지
        expect(body).toMatch(/padding-bottom:\s*var\(--safe-bottom\)/);
    });

    it('★ 상단 인셋은 .app-topbar 가 자기 padding-top 으로 갖는다', () => {
        const css = readCss('./styles/base.css');
        const bar = rule(css, '.app-topbar');
        expect(bar).toMatch(/position:\s*sticky/);
        expect(bar).toMatch(/padding-top:\s*calc\([^)]*var\(--safe-top\)\)/);
    });

    it('★ .app-topbar 를 다시 정의하는 곳에서 padding 단축 속성을 쓰지 않는다', () => {
        // 같은 명시도라 나중 규칙이 이겨서 padding-top 이 0 이 된다.
        const css = readCss('./styles/components.css');
        const bar = rule(css, '.app-topbar');
        expect(bar.length).toBeGreaterThan(0);
        expect(bar).not.toMatch(/^\s*padding:/m);
    });

    it('★ 문서가 가로로 스크롤되지 않게 html 에만 overflow-x:hidden 을 건다', () => {
        const css = readCss('./styles/base.css');
        expect(rule(css, 'html')).toMatch(/overflow-x:\s*hidden/);
        // body 에 걸면 body 가 스크롤 컨테이너가 되어 sticky 상단 바가 죽는다.
        expect(rule(css, 'body')).not.toMatch(/overflow-x/);
    });

    it('★ 폭 없는 fixed 상자를 left:50% 로 가운데 맞추지 않는다 (shrink-to-fit 함정)', () => {
        const css = readCss('./styles/components.css');
        const toast = rule(css, '#toast-root');
        expect(toast).toMatch(/position:\s*fixed/);
        expect(toast).not.toMatch(/left:\s*50%/);
        expect(toast).toMatch(/margin-left:\s*auto/);
    });
});

describe('넓은 블록은 자기 상자 안에서 스크롤한다', () => {
    it.each([
        ['.md-body pre', /overflow-x:\s*auto/],
        ['.md-body .table-scroll', /overflow-x:\s*auto/],
        ['.md-body .katex-display', /overflow-x:\s*auto/],
    ])('%s 에 가로 스크롤이 있다', (selector, pattern) => {
        expect(rule(readCss('./styles/markdown.css'), selector)).toMatch(pattern);
    });
});

describe('★ CSS 안의 글자도 번역을 탄다', () => {
    /*
     * CSS 는 카탈로그를 못 읽는다. `content:` 에 글자를 직접 적으면 **번역에서 빠진다** —
     * 2026-08-04에 영어 스크린샷을 찍다가 다이어그램 아래에
     * '탭하면 크게 보기' 가 한국어로 박혀 있는 걸 발견했다.
     * 사람이 읽는 글자는 `var(--i18n-*)` 로 받아야 한다(setLanguage 가 채운다).
     */
    it.each(['base.css', 'markdown.css', 'hljs.css', 'components.css', 'utilities.css'])(
        '%s 의 content: 에 사람이 읽는 글자가 박혀 있지 않다',
        (file) => {
            const css = readCss(`./styles/${file}`);
            const literal = [...css.matchAll(/content\s*:\s*(['"])([^'"]*)\1/g)]
                .map((m) => m[2])
                // 장식용 기호(따옴표·화살표 등)와 빈 문자열은 번역 대상이 아니다.
                .filter((s) => /[가-힣]|[A-Za-z]{3,}/.test(s));
            expect(literal, `${file} 에서 발견`).toEqual([]);
        },
    );

    it('다이어그램 확대 안내는 CSS 변수로 받는다', () => {
        expect(readCss('./styles/markdown.css')).toContain('var(--i18n-zoom-hint');
    });
});

describe('디자인 토큰 (2026-08-04 종합 점검)', () => {
    it('간격·모서리 토큰이 base.css 에 있다', () => {
        const css = readCss('./styles/base.css');
        for (const token of ['--sp-1', '--sp-6', '--r-sm', '--r-full', '--tap']) {
            expect(css).toContain(`${token}:`);
        }
    });

    it('★ 떠 있는 면(--surface)은 다크 테마에서 다시 정의된다', () => {
        // 라이트에서만 정의하면 다크에서 메뉴·시트가 흰색으로 뜬다.
        const css = readCss('./styles/base.css');
        expect(rule(css, "[data-theme='dark']")).toMatch(/--surface:/);
    });

    it('★ 포커스 링을 우리가 정한다 — 안 정하면 삼성 웹뷰가 주황 테두리를 그린다', () => {
        expect(rule(readCss('./styles/base.css'), ':focus-visible')).toMatch(/outline:\s*2px/);
    });

    it('★ components.css 에 날 px 여백이 남아 있지 않다', () => {
        /*
         * 값이 흩어지면 화면마다 리듬이 어긋난다. 여백은 토큰으로만 쓴다.
         * ★ 예외: 목차 들여쓰기(18/36/54/72)는 단계별 계산값이고,
         *   스위치·최소 높이처럼 '치수'인 것은 간격이 아니다.
         */
        const css = readCss('./styles/components.css');
        const offenders = [...css.matchAll(/^\s*(padding|margin|gap)(-[a-z]+)?:\s*([^;]+);/gm)]
            // var(...) 안의 px 는 그 변수의 대체값이다 — 여기서 정한 여백이 아니다.
            .filter(([, , , value]) => /\d+px/.test(value.replace(/var\([^)]*\)/g, '')))
            .map(([line]) => line.trim());
        // 목차 들여쓰기만 남는다.
        expect(offenders.filter((l) => !/padding-left:\s*(18|36|54|72)px/.test(l))).toEqual([]);
    });
});

describe('⋮ 메뉴는 문서를 밀어내지 않는다 (2026-08-04 사용자 보고)', () => {
    const css = readCss('./styles/components.css');

    it('★★ .more-menu 가 흐름에서 빠져 있다 — sticky 면 열릴 때 본문이 아래로 밀린다', () => {
        const menu = rule(css, '.more-menu');
        expect(menu).toMatch(/position:\s*absolute/);
        expect(menu).not.toMatch(/position:\s*sticky/);
    });

    it('메뉴 밖을 눌러 닫을 수 있는 판이 화면 전체를 덮는다', () => {
        const scrim = rule(css, '.menu-scrim');
        expect(scrim).toMatch(/position:\s*fixed/);
        expect(scrim).toMatch(/inset:\s*0/);
    });

    it('★ 스크림이 메뉴보다 아래, 상단 바 버튼보다 위에 있다', () => {
        const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(rule(css, sel))?.[1]);
        expect(z('.menu-scrim')).toBeLessThan(z('.more-menu'));
        expect(z('.menu-scrim')).toBeGreaterThan(0);
    });
});
