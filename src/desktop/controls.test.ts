import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createControls, IDLE_MS, type Controls } from './controls';

/**
 * 떠오르는 컨트롤의 동작.
 *
 * 지키려는 것은 둘이다.
 *   1) 읽는 동안 **절대 방해하지 않는다** — 스크롤·선택·링크 클릭에 반응하지 않는다.
 *   2) 필요할 때 **확실히 나타난다** — 마우스 이동, 탭.
 */

let ctl: Controls;
let suppressed = false;
const calls = { edit: 0, toc: 0, find: 0, theme: 0, more: 0 };

function move(x: number, y: number): void {
    window.dispatchEvent(new MouseEvent('mousemove', { screenX: x, screenY: y }));
}
function tap(target: Element, detail = 1): void {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
}

beforeEach(() => {
    vi.useFakeTimers();
    suppressed = false;
    Object.assign(calls, { edit: 0, toc: 0, find: 0, theme: 0, more: 0 });
    document.body.innerHTML =
        '<main id="m"><p id="p">본문</p><a id="a" href="#x">링크</a><div class="search-bar" id="sb">검색</div></main>';
    ctl = createControls({
        onEdit: () => calls.edit++,
        onToc: () => calls.toc++,
        onFind: () => calls.find++,
        onTheme: () => calls.theme++,
        onMore: () => calls.more++,
        suppressed: () => suppressed,
    });
    document.body.appendChild(ctl.root);
    ctl.setActive(true);
    // 첫 mousemove 가 '이동'으로 세어지도록 기준점을 한 번 둔다.
    move(0, 0);
    ctl.hide();
});

afterEach(() => {
    ctl.hide();
    vi.useRealTimers();
});

describe('마우스 이동', () => {
    it('움직이면 나타나고 가만히 있으면 스스로 사라진다', () => {
        move(100, 100);
        expect(ctl.visible).toBe(true);
        expect(ctl.root.classList.contains('is-shown')).toBe(true);

        vi.advanceTimersByTime(IDLE_MS - 1);
        expect(ctl.visible).toBe(true);
        vi.advanceTimersByTime(2);
        expect(ctl.visible).toBe(false);
    });

    it('★ 포인터가 안 움직인 mousemove(스크롤·레이아웃 때문에 오는 것)는 무시한다', () => {
        move(100, 100);
        ctl.hide();
        // 같은 자리에서 또 온다 — 문서를 스크롤하면 브라우저가 이렇게 쏜다
        move(100, 100);
        move(101, 100);
        expect(ctl.visible).toBe(false);
    });

    it('계속 움직이면 사라지는 시각이 뒤로 밀린다', () => {
        move(100, 100);
        vi.advanceTimersByTime(IDLE_MS - 500);
        move(200, 200);
        vi.advanceTimersByTime(IDLE_MS - 500);
        expect(ctl.visible).toBe(true);
    });

    it('★ 컨트롤 위에 마우스가 있는 동안은 사라지지 않는다 — 누르려는 순간에 사라지면 안 된다', () => {
        move(100, 100);
        ctl.root.dispatchEvent(new MouseEvent('mouseenter'));
        vi.advanceTimersByTime(IDLE_MS * 3);
        expect(ctl.visible).toBe(true);

        ctl.root.dispatchEvent(new MouseEvent('mouseleave'));
        vi.advanceTimersByTime(IDLE_MS + 1);
        expect(ctl.visible).toBe(false);
    });

    it('문서가 없으면 어떤 입력에도 나타나지 않는다', () => {
        ctl.setActive(false);
        move(300, 300);
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(1000);
        expect(ctl.visible).toBe(false);
    });

    it('검색 바·목차가 열려 있으면(suppressed) 그 위로 뜨지 않는다', () => {
        suppressed = true;
        move(100, 100);
        expect(ctl.visible).toBe(false);
    });
});

describe('탭 = 열고 닫기', () => {
    it('본문을 탭하면 고정되어 열리고, 마우스가 가만있어도 사라지지 않는다', () => {
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(true);

        vi.advanceTimersByTime(IDLE_MS * 4);
        expect(ctl.visible).toBe(true);
    });

    it('★ 고정된 동안에는 마우스를 움직여도 상태가 흔들리지 않는다', () => {
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        move(500, 500);
        vi.advanceTimersByTime(IDLE_MS * 2);
        expect(ctl.visible).toBe(true);
    });

    it('다시 탭하면 닫힌다', () => {
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(false);
    });

    it('이동으로 떠 있는 중에 탭하면 즉시 닫힌다', () => {
        move(100, 100);
        expect(ctl.visible).toBe(true);
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(false);
    });

    it('★ 링크를 누르면 탭이 아니다 — 링크가 자기 일을 한다', () => {
        tap(document.getElementById('a')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(false);
    });

    it('★ 검색 바 안을 눌러도 탭이 아니다', () => {
        tap(document.getElementById('sb')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(false);
    });

    it('★ 글자를 골라 둔 상태에서는 탭이 아니다 — 드래그로 고른 직후의 클릭', () => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('p')!);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);

        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(false);
        sel.removeAllRanges();
    });

    it('★ 더블클릭(낱말 선택)은 깜빡이지 않는다 — 첫 클릭의 토글이 취소된다', () => {
        tap(document.getElementById('p')!, 1);
        tap(document.getElementById('p')!, 2);
        vi.advanceTimersByTime(1000);
        expect(ctl.visible).toBe(false);
    });

    it('목차·찾기가 열려 있는 동안에는 탭으로 뜨지 않는다', () => {
        suppressed = true;
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        expect(ctl.visible).toBe(false);
    });
});

describe('닫기 · 버튼', () => {
    it('Esc 로 닫힌다', () => {
        tap(document.getElementById('p')!);
        vi.advanceTimersByTime(300);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(ctl.visible).toBe(false);
    });

    it('버튼 다섯 개가 각자의 동작을 부르고, 눌러도 탭 토글로 새지 않는다', () => {
        const btns = [...ctl.root.querySelectorAll<HTMLButtonElement>('button')];
        expect(btns).toHaveLength(5);
        let x = 100;
        for (const b of btns) {
            // ★ 매번 확실히 멀리 움직인다. 이전 자리와 3px 안이면 '안 움직인 것'으로 무시된다.
            x += 50;
            move(x, x);
            b.click();
            vi.advanceTimersByTime(300);
        }
        expect(calls).toEqual({ edit: 1, toc: 1, find: 1, theme: 1, more: 1 });
    });

    it('★ 목차·찾기·메뉴를 누르면 컨트롤이 물러난다 — 검색 바 닫기 버튼 위에 겹치면 안 된다', () => {
        const [edit, toc, find, , more] = ctl.root.querySelectorAll<HTMLButtonElement>('button');
        let x = 300;
        for (const b of [edit, toc, find, more]) {
            x += 50;
            move(x, x);
            expect(ctl.visible).toBe(true);
            b.click();
            expect(ctl.visible).toBe(false);
        }
    });

    it('테마는 누른 뒤에도 남는다 — 결과를 보며 다시 누를 수 있다', () => {
        move(300, 300);
        ctl.root.querySelectorAll<HTMLButtonElement>('button')[3].click();
        expect(ctl.visible).toBe(true);
    });

    it('★ 편집 중에는 목차·찾기가 꺼지고 편집 버튼이 눌린 모양이 된다', () => {
        const [edit, toc, find] = ctl.root.querySelectorAll<HTMLButtonElement>('button');
        expect(edit.getAttribute('aria-pressed')).toBe('false');

        ctl.setEditing(true);
        expect(edit.getAttribute('aria-pressed')).toBe('true');
        expect(toc.disabled && find.disabled).toBe(true);

        ctl.setEditing(false);
        expect(edit.getAttribute('aria-pressed')).toBe('false');
        expect(toc.disabled || find.disabled).toBe(false);
    });

    it('★ 단축키를 툴팁으로 가르친다 — 발견 가능성이 이 컨트롤의 존재 이유다', () => {
        const tips = [...ctl.root.querySelectorAll('button')].map(
            (b) => b.getAttribute('aria-label') ?? '',
        );
        expect(tips.some((t) => t.includes('Ctrl+T'))).toBe(true);
        expect(tips.some((t) => t.includes('Ctrl+F'))).toBe(true);
        expect(tips.some((t) => t.includes('Ctrl+E'))).toBe(true);
        // 보이는 툴팁은 기본 title 이 아니라 우리 것이다(윈도우 기본 모양과 구별)
        for (const b of ctl.root.querySelectorAll('button')) {
            expect(b.hasAttribute('title')).toBe(false);
            expect(b.querySelector('.desktop-tip')).not.toBeNull();
        }
        expect(ctl.root.querySelector('.desktop-tip kbd')?.textContent).toBe('Ctrl+E');
    });

    it('★ 버튼은 Tab 순회에 끼지 않는다 — 읽는 화면에서 Tab 이 컨트롤을 돌면 안 된다', () => {
        for (const b of ctl.root.querySelectorAll('button')) expect(b.tabIndex).toBe(-1);
    });

    it('키보드로 초점이 들어오면 보인다 (안 보이는 버튼에 초점이 가면 안 된다)', () => {
        ctl.root.dispatchEvent(new FocusEvent('focusin'));
        expect(ctl.visible).toBe(true);
    });
});
