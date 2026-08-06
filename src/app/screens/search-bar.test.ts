import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * T2 검색 바 (8-6절).
 *
 * ★★ 이 화면의 핵심은 **문서 전체가 DOM 에 올라온 뒤에 훑는 것**이다.
 *   뷰어는 큰 문서를 청크로 나눠 붙이므로, 검색을 열자마자 훑으면
 *   아직 안 붙은 뒷부분이 통째로 빠진다. 사용자에게는 "검색이 안 된다" 로만 보인다.
 *
 * ★ 닫히는 경로는 셋이다(닫기 버튼 · 뒤로가기 · 다른 문서 열기).
 *   어느 쪽으로 닫혀도 <mark> 가 남으면 안 된다.
 */

vi.mock('@capacitor/app', () => ({
    App: {
        exitApp: vi.fn(async () => {}),
        addListener: vi.fn(async () => ({ remove: async () => {} })),
    },
}));

import { createSearchBar, type SearchBar } from './search-bar';
import { __resetRouterForTest, __pressBackForTest, hasLayer } from '../router';
import type { RenderHandle } from '../../markdown/render-pipeline';
import { t } from '../../i18n';

let container: HTMLElement;
let bar: SearchBar;
let toggles: boolean[];

/**
 * 뷰어의 청크 렌더를 흉내 낸다.
 * 처음에는 앞부분만 DOM 에 있고, renderRest() 를 불러야 뒷부분이 붙는다.
 */
function makeHandle(rest: string, delayMs = 0): RenderHandle {
    let done = false;
    return {
        headings: [],
        complete: Promise.resolve(),
        cancel: () => {},
        renderRest: async () => {
            if (done) return;
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            done = true;
            const section = document.createElement('section');
            section.className = 'md-chunk';
            section.innerHTML = `<p>${rest}</p>`;
            container.appendChild(section);
        },
    } as unknown as RenderHandle;
}

function typeQuery(value: string): void {
    const input = bar.root.querySelector<HTMLInputElement>('.search-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
}

function counter(): string {
    return bar.root.querySelector('.search-counter')?.textContent ?? '';
}

function marks(): string[] {
    return [...container.querySelectorAll('mark')].map((m) => m.textContent ?? '');
}

function btnByAria(label: string): HTMLButtonElement {
    return [...bar.root.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.getAttribute('aria-label') === label,
    )!;
}

beforeEach(() => {
    vi.useFakeTimers();
    __resetRouterForTest();
    toggles = [];

    container = document.createElement('div');
    container.className = 'md-target';
    container.innerHTML = '<section class="md-chunk"><p>앞부분에 사과가 있다</p></section>';
    document.body.appendChild(container);
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

function build(handle: RenderHandle | null): void {
    bar = createSearchBar(
        container,
        () => handle,
        (open) => toggles.push(open),
    );
    document.body.appendChild(bar.root);
}

describe('열고 닫기', () => {
    beforeEach(() => build(makeHandle('뒷부분에도 사과가 있다')));

    it('열면 바가 보이고 상단 바를 감추라고 알린다', async () => {
        expect(bar.root.hidden).toBe(true);
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);

        expect(bar.root.hidden).toBe(false);
        expect(bar.isOpen).toBe(true);
        /*
         * ★★ 상단 바 '아래 한 줄'이 아니라 상단 바를 **덮는** 것이다.
         *   덧붙이기만 하면 검색 중에도 편집·목차 버튼이 눌려 오작동한다(9-1절 T2).
         */
        expect(toggles).toEqual([true]);
    });

    it('여는 순간 back 레이어를 얹는다', async () => {
        await bar.open();
        expect(hasLayer('search')).toBe(true);
    });

    it('뒤로가기로 닫힌다', async () => {
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);
        expect(marks().length).toBeGreaterThan(0);

        await __pressBackForTest();

        expect(bar.isOpen).toBe(false);
        expect(hasLayer('search')).toBe(false);
        // ★ <mark> 를 남기면 다음에 문서를 볼 때 엉뚱한 데가 칠해져 있다.
        expect(marks()).toEqual([]);
        expect(toggles).toEqual([true, false]);
    });

    it('닫기 버튼으로도 같은 정리를 한다', async () => {
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);

        btnByAria(t.search.close).click();

        expect(bar.isOpen).toBe(false);
        expect(marks()).toEqual([]);
        expect(hasLayer('search')).toBe(false);
    });

    it('두 번 열어도 한 번만 연다', async () => {
        await bar.open();
        await bar.open();
        expect(toggles).toEqual([true]);
    });

    it('닫혀 있을 때 close 는 아무것도 안 한다', () => {
        bar.close();
        expect(toggles).toEqual([]);
    });

    it('다시 열면 앞의 검색어가 남아 있지 않다', async () => {
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);
        bar.close();

        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
        expect(bar.root.querySelector<HTMLInputElement>('.search-input')!.value).toBe('');
        expect(counter()).toBe('0/0');
    });
});

describe('★ 문서 뒷부분까지 훑는다 (1번 규칙)', () => {
    it('열 때 남은 청크를 붙인다', async () => {
        build(makeHandle('뒷부분에도 사과가 있다'));
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);

        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);

        expect(marks()).toHaveLength(2);
    });

    it('★ 붙는 동안 사용자가 쳐도 뒷부분을 놓치지 않는다', async () => {
        // 큰 문서라 남은 청크를 붙이는 데 시간이 걸린다(실기기 3.6MB 에서 8초).
        build(makeHandle('뒷부분에도 사과가 있다', 300));

        const opening = bar.open();
        await vi.advanceTimersByTimeAsync(10);

        // 사용자는 기다리지 않는다. 바가 뜨자마자 친다.
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200); // debounce 120ms — 이때는 앞부분뿐이다
        expect(marks(), '아직 앞부분만 붙어 있어야 한다').toHaveLength(1);

        await vi.advanceTimersByTimeAsync(500);
        await opening;

        /*
         * ★★ 여기서 다시 훑지 않으면 결과가 **앞부분만** 잡힌 채로 굳는다.
         *   사용자에게는 "검색이 안 된다" 로만 보이고, 왜인지는 알 길이 없다.
         */
        expect(marks(), '뒷부분이 붙은 뒤 다시 훑지 않았다').toHaveLength(2);
        expect(counter()).toContain('2');
    });

    it('붙는 동안 닫으면 뒤늦게 되살아나지 않는다', async () => {
        build(makeHandle('뒷부분에도 사과가 있다', 300));

        const opening = bar.open();
        await vi.advanceTimersByTimeAsync(10);
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);

        bar.close();

        await vi.advanceTimersByTimeAsync(500);
        await opening;

        expect(bar.isOpen).toBe(false);
        expect(marks()).toEqual([]);
    });

    it('그릴 것이 없어도 터지지 않는다', async () => {
        build(null);
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);
        expect(marks()).toHaveLength(1);
    });
});

describe('세기와 이동', () => {
    beforeEach(async () => {
        container.innerHTML =
            '<section class="md-chunk"><p>사과 하나</p><p>사과 둘</p><p>사과 셋</p></section>';
        build(makeHandle(''));
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
    });

    it('찾은 개수를 세어 준다', async () => {
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);
        expect(counter()).toBe('1/3');
    });

    it('없으면 이동 버튼을 잠근다', async () => {
        typeQuery('없는말');
        await vi.advanceTimersByTimeAsync(200);
        expect(btnByAria(t.search.next).disabled).toBe(true);
        expect(btnByAria(t.search.previous).disabled).toBe(true);
    });

    it('다음으로 넘어간다 — 끝에서 처음으로 돈다', async () => {
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);

        btnByAria(t.search.next).click();
        expect(counter()).toBe('2/3');
        btnByAria(t.search.next).click();
        expect(counter()).toBe('3/3');
        btnByAria(t.search.next).click();
        expect(counter()).toBe('1/3');
    });

    it('이전으로도 돈다', async () => {
        typeQuery('사과');
        await vi.advanceTimersByTimeAsync(200);
        btnByAria(t.search.previous).click();
        expect(counter()).toBe('3/3');
    });

    it('세는 칸은 소리로도 읽힌다', () => {
        expect(bar.root.querySelector('.search-counter')?.getAttribute('aria-live')).toBe('polite');
    });
});

describe('★ 한글 IME (6번 규칙)', () => {
    beforeEach(async () => {
        container.innerHTML = '<section class="md-chunk"><p>한글 문서다</p></section>';
        build(makeHandle(''));
        await bar.open();
        await vi.advanceTimersByTimeAsync(10);
    });

    it('★★ 조합 중에도 훑는다 — 안 그러면 한글 검색이 아예 안 돈다', async () => {
        const input = bar.root.querySelector<HTMLInputElement>('.search-input')!;
        input.value = '한글';
        input.dispatchEvent(
            Object.assign(new Event('input'), { isComposing: true }) as unknown as Event,
        );
        await vi.advanceTimersByTimeAsync(200);

        /*
         * ★★ 이 테스트는 예전에 정반대를 고정하고 있었다("조합 중에는 훑지 않는다").
         *   그런데 검색창에서는 사용자가 마지막 글자를 치고 **멈춘다** — 뒤에
         *   스페이스도 엔터도 안 친다. 한글 IME 는 마지막 음절을 조합 상태로 열어 두므로
         *   compositionend 가 영영 안 온다.
         *   실기기에서 문서에 "조합" 이 있는데 "조합" 을 치고 3초를 기다려도 0/0 이었다
         *   (2026-08-06, Gboard 한국어 자판).
         */
        expect(marks(), '조합 중이라고 건너뛰면 한글 검색이 죽는다').toEqual(['한글']);
    });

    it('★ 그래도 매 자모마다 훑지는 않는다 — 디바운스가 막는다', async () => {
        const input = bar.root.querySelector<HTMLInputElement>('.search-input')!;
        for (const v of ['ㅎ', '하', '한', '한그', '한글']) {
            input.value = v;
            input.dispatchEvent(
                Object.assign(new Event('input'), { isComposing: true }) as unknown as Event,
            );
            await vi.advanceTimersByTimeAsync(30); // 120ms 안에 이어서 친다
        }
        // 중간 자모로 훑으면 결과가 튀고 화면이 번쩍인다. 아직 안 돌았어야 한다.
        expect(marks()).toEqual([]);

        await vi.advanceTimersByTimeAsync(200);
        expect(marks()).toEqual(['한글']);
    });

    it('조합이 끝나는 순간에도 반응한다', async () => {
        const input = bar.root.querySelector<HTMLInputElement>('.search-input')!;
        input.value = '한글';
        input.dispatchEvent(new Event('compositionend'));
        await vi.advanceTimersByTimeAsync(200);
        expect(marks()).toEqual(['한글']);
    });

    it('★ 조합 중인 Enter 는 가로채지 않는다', async () => {
        const input = bar.root.querySelector<HTMLInputElement>('.search-input')!;
        input.value = '한글';
        input.dispatchEvent(new Event('compositionend'));
        await vi.advanceTimersByTimeAsync(200);

        const composing = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        Object.defineProperty(composing, 'isComposing', { value: true });
        input.dispatchEvent(composing);

        // 한글 확정용 Enter 까지 먹으면 글자가 씹힌다(9-5절).
        expect(composing.defaultPrevented).toBe(false);
    });

    it('확정된 Enter 는 다음으로 넘긴다', async () => {
        container.innerHTML = '<section class="md-chunk"><p>한글 한글</p></section>';
        const input = bar.root.querySelector<HTMLInputElement>('.search-input')!;
        input.value = '한글';
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(200);
        expect(counter()).toBe('1/2');

        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        input.dispatchEvent(enter);

        expect(enter.defaultPrevented).toBe(true);
        expect(counter()).toBe('2/2');
    });
});

/**
 * ★★★ 2026-08-06. **검색을 닫으면 초점이 갈 곳을 잃었다.**
 *
 *   닫는 순간 바가 `hidden` 이 되는데, 그때 초점은 아직 검색칸에 있다.
 *   실측: 닫은 뒤에도 activeElement 가 `[hidden]` 안의 입력칸이었다.
 *   실기기에서는 브라우저가 곧 body 로 떨어뜨린다 — 어느 쪽이든 **열기 전 자리로
 *   돌아가지 않는다.** 토크백 사용자는 다음 스와이프가 화면 맨 위에서 다시 시작해
 *   읽던 자리를 잃는다.
 *
 *   ★ 시트·다이얼로그는 Overlay 가 이걸 해 준다. 검색 바는 상단 바를 **덮는**
 *     인라인 바라 Overlay 를 쓰지 않아서 그 그물 밖에 있었다.
 */
describe('★★ 닫으면 초점이 열기 전 자리로 돌아간다', () => {
    let 찾기버튼: HTMLButtonElement;

    beforeEach(() => {
        build(makeHandle('뒷부분'));
        찾기버튼 = document.createElement('button');
        찾기버튼.id = 'find-btn';
        document.body.appendChild(찾기버튼);
    });

    it('★ 뒤로가기로 닫아도 [찾기] 버튼으로 돌아간다', async () => {
        찾기버튼.focus();
        await bar.open();
        expect(document.activeElement, '열면 검색칸이 잡혀야 한다').toBe(
            bar.root.querySelector('input'),
        );

        expect(await __pressBackForTest()).toBe('search');

        expect(document.activeElement, '초점이 숨겨진 칸이나 body 에 남았다').toBe(찾기버튼);
    });

    it('닫기 버튼으로 닫아도 돌아간다', async () => {
        찾기버튼.focus();
        await bar.open();
        const 닫기 = [...bar.root.querySelectorAll('button')].pop()!;
        닫기.focus();
        닫기.click();
        expect(document.activeElement).toBe(찾기버튼);
    });

    it('돌아갈 자리가 이미 사라졌으면 아무 데도 손대지 않는다', async () => {
        찾기버튼.focus();
        await bar.open();
        찾기버튼.remove(); // 그 사이에 화면이 바뀌었다
        expect(() => bar.close()).not.toThrow();
    });

    /*
     * ★ 닫는 사이에 앱이 초점을 다른 곳으로 옮겼으면 빼앗지 않는다
     *   (Overlay 에서 다이얼로그가 겹칠 때 겪은 것과 같은 함정이다).
     */
    it('★ 다른 곳이 이미 초점을 가져갔으면 빼앗지 않는다', async () => {
        찾기버튼.focus();
        await bar.open();

        const 다른곳 = document.createElement('button');
        document.body.appendChild(다른곳);
        다른곳.focus();

        bar.close();
        expect(document.activeElement, '남의 초점을 빼앗았다').toBe(다른곳);
    });
});
