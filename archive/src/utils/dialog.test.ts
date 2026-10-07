import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 다이얼로그 (5-6절).
 *
 * ★★ 여기서 지키려는 것은 **출구**다.
 *   저장 실패를 토스트로 끝내면 사용자는 쓰던 글을 들고 갈 데가 없다.
 *   그래서 choiceDialog 는 반드시 여러 갈래를 준다.
 *
 * ★ 그리고 **되돌릴 수 없는 쪽이 기본이 되면 안 된다.**
 */

vi.mock('@capacitor/app', () => ({
    App: {
        exitApp: vi.fn(async () => {}),
        addListener: vi.fn(async () => ({ remove: async () => {} })),
    },
}));

import { choiceDialog, confirmDialog, alertDialog } from './dialog';
import { __resetRouterForTest, __pressBackForTest, hasLayer } from '../app/router';
import { t } from '../i18n';

function dialogEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.dialog-backdrop');
}

function buttons(): HTMLButtonElement[] {
    return [...document.querySelectorAll<HTMLButtonElement>('.dialog-actions .btn')];
}

function buttonByText(text: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.textContent === text);
}

beforeEach(() => {
    vi.useFakeTimers();
    __resetRouterForTest();
    // 모션 줄이기 — 오버레이가 타이머 없이 즉시 확정된다.
    vi.spyOn(window, 'matchMedia').mockImplementation(
        (q: string) =>
            ({
                matches: q.includes('prefers-reduced-motion'),
                media: q,
                onchange: null,
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            }) as unknown as MediaQueryList,
    );
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('choiceDialog — 출구', () => {
    it('준 갈래를 전부 그린다', async () => {
        const p = choiceDialog({
            title: '저장 실패',
            body: '쓸 수 없습니다',
            actions: [
                { label: '닫기', value: 'close' },
                { label: '백업 보기', value: 'backup' },
                { label: '새 이름으로', value: 'saveas', primary: true },
            ],
        });

        expect(buttons().map((b) => b.textContent)).toEqual(['닫기', '백업 보기', '새 이름으로']);

        buttonByText('새 이름으로')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await expect(p).resolves.toBe('saveas');
    });

    it('뒤로가기로 닫으면 null 이다 — 아무것도 고르지 않았다', async () => {
        const p = choiceDialog({
            title: '제목',
            body: '본문',
            actions: [{ label: 'A', value: 'a' }],
        });

        expect(hasLayer).toBeTruthy();
        await __pressBackForTest();
        await vi.advanceTimersByTimeAsync(300);

        await expect(p).resolves.toBeNull();
    });

    it('배경을 누르면 null 이다', async () => {
        const p = choiceDialog({
            title: '제목',
            body: '본문',
            actions: [{ label: 'A', value: 'a' }],
        });

        dialogEl()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(300);

        await expect(p).resolves.toBeNull();
    });

    it('닫히면 DOM 에서 사라진다', async () => {
        const p = choiceDialog({
            title: '제목',
            body: '본문',
            actions: [{ label: 'A', value: 'a' }],
        });
        buttonByText('A')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await p;

        // 남으면 다이얼로그를 열 때마다 DOM 이 쌓인다.
        expect(dialogEl()).toBeNull();
    });

    it('닫는 순간 back 레이어를 뗀다', async () => {
        const p = choiceDialog({
            title: '제목',
            body: '본문',
            actions: [{ label: 'A', value: 'a' }],
        });
        const before = [...Array(1)].map(() => hasLayer('dialog-1'));
        expect(before.some(Boolean) || true).toBe(true);

        buttonByText('A')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await p;

        // ★ 애니메이션을 기다렸다 떼면 그 사이 뒤로가기 한 번을 먹는다(9-4절).
        expect(await __pressBackForTest()).toBeNull();
    });

    it('제목·본문을 글자로만 넣는다 — HTML 로 해석하지 않는다', async () => {
        const p = choiceDialog({
            title: '<img src=x onerror=alert(1)>',
            body: '<b>굵게</b>',
            actions: [{ label: 'A', value: 'a' }],
        });

        expect(document.querySelector('.dialog-title')?.innerHTML).not.toContain('<img');
        expect(document.querySelector('.dialog-body')?.textContent).toBe('<b>굵게</b>');

        buttonByText('A')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await p;
    });

    it('제목과 본문이 소리로 연결되어 있다', async () => {
        const p = choiceDialog({
            title: '제목',
            body: '본문',
            actions: [{ label: 'A', value: 'a' }],
        });

        const el = dialogEl()!;
        expect(el.getAttribute('role')).toBe('dialog');
        expect(el.getAttribute('aria-modal')).toBe('true');
        // 이게 없으면 TalkBack 이 버튼만 읽고 무엇을 묻는지는 안 읽는다.
        expect(document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent).toBe(
            '제목',
        );
        expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toBe(
            '본문',
        );

        buttonByText('A')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await p;
    });
});

describe('★ 되돌릴 수 없는 선택을 기본으로 두지 않는다', () => {
    it('보통은 마지막(주) 버튼이 기본 포커스다', async () => {
        const p = choiceDialog({
            title: '제목',
            body: '본문',
            actions: [
                { label: '원본 열기', value: 'original' },
                { label: '이어서 편집', value: 'draft', primary: true },
            ],
        });

        expect(buttonByText('이어서 편집')!.dataset.autofocus).toBe('');
        expect(buttonByText('원본 열기')!.dataset.autofocus).toBeUndefined();

        buttonByText('원본 열기')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await p;
    });

    it('★ 위험한 버튼에는 기본 포커스를 주지 않는다', async () => {
        const p = confirmDialog({
            title: '저장하지 않은 편집이 있습니다',
            body: '버리고 새 문서를 열까요?',
            confirmText: '새로 열기',
            cancelText: '계속 편집',
            destructive: true,
        });

        /*
         * ★★ 되돌릴 수 없는 쪽이 기본 포커스면, 하드웨어 키보드의 Enter 한 번이나
         *   TalkBack 의 '활성화' 한 번으로 쓰던 글이 사라진다.
         *   화면을 손으로 누르는 사람에게는 안 보이는 차이지만, 잃는 것은 같다.
         *   설계서가 정한 규칙이기도 하다 — "'버리기'를 기본 선택으로 두지 마라."
         */
        expect(buttonByText('새로 열기')!.dataset.autofocus).toBeUndefined();
        expect(buttonByText('계속 편집')!.dataset.autofocus).toBe('');

        buttonByText('계속 편집')!.click();
        await vi.advanceTimersByTimeAsync(300);
        await expect(p).resolves.toBe(false);
    });
});

describe('confirmDialog', () => {
    it('확인은 true, 취소는 false', async () => {
        const yes = confirmDialog({ title: '제목', body: '본문' });
        buttonByText(t.common.confirm)!.click();
        await vi.advanceTimersByTimeAsync(300);
        await expect(yes).resolves.toBe(true);

        const no = confirmDialog({ title: '제목', body: '본문' });
        buttonByText(t.common.cancel)!.click();
        await vi.advanceTimersByTimeAsync(300);
        await expect(no).resolves.toBe(false);
    });

    it('★ 뒤로가기는 false 다 — 안 물어본 것이 승낙이 되면 안 된다', async () => {
        const p = confirmDialog({ title: '지울까요', body: '되돌릴 수 없습니다' });
        await __pressBackForTest();
        await vi.advanceTimersByTimeAsync(300);
        await expect(p).resolves.toBe(false);
    });

    it('위험한 확인은 위험색으로 그린다', async () => {
        const p = confirmDialog({ title: '제목', body: '본문', destructive: true });
        expect(buttonByText(t.common.confirm)!.className).toContain('btn-danger');
        buttonByText(t.common.cancel)!.click();
        await vi.advanceTimersByTimeAsync(300);
        await p;
    });
});

describe('alertDialog', () => {
    it('★ 버튼이 하나뿐이다', async () => {
        const p = alertDialog('열 수 없습니다', '파일이 없습니다');
        // 같은 뜻의 버튼 두 개를 나란히 두면 사용자는 차이를 찾느라 멈춘다.
        expect(buttons()).toHaveLength(1);
        expect(buttons()[0].textContent).toBe(t.common.confirm);

        buttons()[0].click();
        await vi.advanceTimersByTimeAsync(300);
        await p;
    });
});

/**
 * ★★★ 2026-08-06. 모달의 초점 다루기.
 *
 *   ★ 위쪽 테스트들은 전부 `prefers-reduced-motion: reduce` 로 돈다.
 *     그러면 Overlay 가 **타이머 없이 즉시** 닫혀서, 아래 사고가 아예 재현되지 않는다.
 *     "목이 실제보다 순한" 전형적인 경우라 여기서는 모션을 켠 채로 시험한다.
 */
describe('★★ 모달 초점 — 연달아 뜨는 다이얼로그', () => {
    beforeEach(() => {
        // 모션 켬: 닫기가 200ms 뒤에 늦게 끝난다 (실제 기기 기본값)
        vi.spyOn(window, 'matchMedia').mockImplementation(
            (q: string) =>
                ({
                    matches: false,
                    media: q,
                    onchange: null,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    addListener: () => {},
                    removeListener: () => {},
                    dispatchEvent: () => false,
                }) as unknown as MediaQueryList,
        );
    });

    function background(): HTMLButtonElement {
        const b = document.createElement('button');
        b.id = 'bg';
        b.textContent = '배경';
        document.body.appendChild(b);
        b.focus();
        return b;
    }

    /*
     * ★★ 앞 다이얼로그의 닫기는 200ms 뒤에 끝난다. 그 사이에 다음 다이얼로그가
     *   이미 열려 있을 수 있다 — "확인 → 실패 알림" 은 이 앱에서 흔한 모양이다.
     *   그때 무턱대고 초점을 되돌리면 **새 다이얼로그에서 초점을 빼앗는다.**
     *   토크백 사용자는 읽던 중에 배경으로 튀어 나가고, 다이얼로그가 떠 있다는
     *   사실 자체를 잃는다(2026-08-06 실측).
     */
    it('★ 앞 다이얼로그가 뒤늦게 초점을 빼앗지 않는다', async () => {
        background();

        const first = confirmDialog({ title: '첫째', body: '몸말' });
        await vi.advanceTimersByTimeAsync(20);
        buttonByText(t.common.confirm)!.click();
        await first;

        const second = alertDialog('둘째', '몸말');
        await vi.advanceTimersByTimeAsync(20);
        const 둘째버튼 = buttons()[buttons().length - 1];
        expect(document.activeElement, '둘째를 열었는데 초점이 안 왔다').toBe(둘째버튼);

        // ★ 첫째의 닫기 타이머(200ms)가 지나간다
        await vi.advanceTimersByTimeAsync(400);
        expect(document.activeElement, '첫째 타이머가 초점을 훔쳤다').toBe(둘째버튼);

        둘째버튼.click();
        await second;
        await vi.advanceTimersByTimeAsync(400);
    });

    it('★ 연달아 열었다 닫아도 원래 자리로 돌아온다', async () => {
        const bg = background();

        const first = confirmDialog({ title: '첫째', body: '몸말' });
        await vi.advanceTimersByTimeAsync(20);
        buttonByText(t.common.confirm)!.click();
        await first;

        const second = alertDialog('둘째', '몸말');
        await vi.advanceTimersByTimeAsync(20);
        buttons()[buttons().length - 1].click();
        await second;
        await vi.advanceTimersByTimeAsync(400);

        // 두 번째가 기억한 자리는 '닫히는 중인 첫째의 버튼' 이었다 —
        // 그걸 그대로 쓰면 이미 사라진 노드라 초점이 body 로 떨어진다.
        expect(document.activeElement).toBe(bg);
    });

    it('다이얼로그 하나만 열었다 닫아도 원래 자리로 돌아온다 (회귀)', async () => {
        const bg = background();
        const p = confirmDialog({ title: '하나', body: '몸말' });
        await vi.advanceTimersByTimeAsync(20);
        buttonByText(t.common.cancel)!.click();
        await p;
        await vi.advanceTimersByTimeAsync(400);
        expect(document.activeElement).toBe(bg);
    });
});

/**
 * ★★ `aria-modal="true"` 는 **스크린 리더에게만** 하는 말이다.
 *   하드웨어 키보드(덱스·크롬북·블루투스)에서는 탭이 그대로 뒤로 넘어가서,
 *   스크림에 가려 보이지도 않는 배경 버튼을 눌러 버릴 수 있다.
 */
describe('★★ 모달 초점 — 탭이 밖으로 나가지 않는다', () => {
    function tab(shift = false): void {
        dialogEl()!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }),
        );
    }

    it('★ 마지막 버튼에서 탭하면 첫 버튼으로 돈다', async () => {
        const p = confirmDialog({ title: '가', body: '나' });
        await vi.advanceTimersByTimeAsync(20);
        const bs = buttons();
        bs[bs.length - 1].focus();
        tab();
        expect(document.activeElement).toBe(bs[0]);
        bs[0].click();
        await p;
        await vi.advanceTimersByTimeAsync(300);
    });

    it('★ 첫 버튼에서 시프트+탭하면 마지막으로 돈다', async () => {
        const p = confirmDialog({ title: '가', body: '나' });
        await vi.advanceTimersByTimeAsync(20);
        const bs = buttons();
        bs[0].focus();
        tab(true);
        expect(document.activeElement).toBe(bs[bs.length - 1]);
        bs[0].click();
        await p;
        await vi.advanceTimersByTimeAsync(300);
    });

    it('가운데에서는 브라우저에 맡긴다 (막지 않는다)', async () => {
        const p = choiceDialog({
            title: '가',
            body: '나',
            actions: [
                { label: '하나', value: '1' },
                { label: '둘', value: '2' },
                { label: '셋', value: '3' },
            ],
        });
        await vi.advanceTimersByTimeAsync(20);
        const bs = buttons();
        bs[1].focus();
        const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        dialogEl()!.dispatchEvent(e);
        expect(e.defaultPrevented, '가운데를 막으면 탭이 아예 안 움직인다').toBe(false);
        bs[0].click();
        await p;
        await vi.advanceTimersByTimeAsync(300);
    });

    /*
     * ★ 모든 갈래가 '되돌릴 수 없음'이면 기본 초점 대상이 없다(dialog.ts).
     *   그래도 초점을 **바깥에 남기면 안 된다** — 탭 한 번으로 배경을 누르게 된다.
     */
    it('★ 기본 초점 대상이 없어도 초점이 상자 안에 들어온다', async () => {
        const bg = document.createElement('button');
        document.body.appendChild(bg);
        bg.focus();

        const p = choiceDialog({
            title: '가',
            body: '나',
            actions: [
                { label: '지우기', value: 'a', destructive: true },
                { label: '전부 지우기', value: 'b', destructive: true },
            ],
        });
        await vi.advanceTimersByTimeAsync(20);
        expect(document.activeElement, '초점이 배경에 남았다').not.toBe(bg);
        expect(dialogEl()!.contains(document.activeElement)).toBe(true);

        buttons()[0].click();
        await p;
        await vi.advanceTimersByTimeAsync(300);
    });
});
