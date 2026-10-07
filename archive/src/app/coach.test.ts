import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runCoach, isCoachOpen, closeCoach, type CoachStep } from './coach';
import { hasLayer, __resetRouterForTest, __pressBackForTest } from './router';
import { setLanguage } from '../i18n';

/**
 * 스포트라이트 안내.
 *
 * ★ jsdom 에는 레이아웃이 없다. getBoundingClientRect 가 전부 0 이므로 구멍 계산은
 *   '대상 없음' 길로 떨어진다 — 그 길이 **실제로도 도는 길**이라(화면 밖 대상, 숨은 화면)
 *   그대로 두고 본다. 위치가 필요한 검사에서는 사각형을 직접 심는다.
 */

function step(name: string, target: HTMLElement | null = null): CoachStep {
    return { target: () => target, title: `${name} 제목`, body: `${name} 설명` };
}

function card(): HTMLElement {
    return document.querySelector('.coach-card') as HTMLElement;
}
function buttons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('.coach-actions button'));
}
function nextBtn(): HTMLButtonElement {
    return buttons()[1];
}
function skipBtn(): HTMLButtonElement {
    return buttons()[0];
}

/** 열고 닫는 애니메이션 타이머(10ms · 200ms)를 흘려보낸다. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(300);
}

beforeEach(() => {
    __resetRouterForTest();
    document.body.replaceChildren();
    setLanguage('ko');
    vi.useFakeTimers();
});

afterEach(async () => {
    /*
     * ★ 안내는 **모듈 안에 '지금 떠 있는 것' 하나를 들고 있다.** 열어 둔 채로 끝내면
     *   다음 테스트의 runCoach 가 곧바로 interrupted 로 빠져 아무것도 안 그린다 —
     *   그러면 검사는 엉뚱한 이유로 실패하고, 원인은 이 파일 어디에도 안 보인다.
     */
    closeCoach();
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
});

describe('runCoach — 진행', () => {
    it('첫 단계를 띄우고 뒤로가기 레이어를 얹는다', async () => {
        void runCoach([step('a'), step('b')]);

        expect(isCoachOpen()).toBe(true);
        expect(hasLayer('coach')).toBe(true);
        expect(card().textContent).toContain('a 제목');
        expect(document.querySelector('.coach-count')?.textContent).toBe('1 / 2');
    });

    it('[다음] 으로 넘어가고 마지막에는 끝내는 버튼이 된다', async () => {
        const done = runCoach([step('a'), step('b')]);

        nextBtn().click();
        expect(card().textContent).toContain('b 제목');
        expect(document.querySelector('.coach-count')?.textContent).toBe('2 / 2');

        // ★ 마지막에는 [건너뛰기] 를 숨긴다 — 끝내는 것과 같은 말이 되어 둘 다 헷갈린다.
        expect(skipBtn().hidden).toBe(true);

        nextBtn().click();
        await settle();
        await expect(done).resolves.toBe('done');
    });

    it('건너뛰면 skipped 로 끝난다', async () => {
        const done = runCoach([step('a'), step('b')]);
        skipBtn().click();
        await settle();
        await expect(done).resolves.toBe('skipped');
    });

    it('★ 뒤로가기로 닫아도 skipped 다 — 본 것으로 세면 안 되지만 거절은 거절이다', async () => {
        const done = runCoach([step('a'), step('b')]);
        await __pressBackForTest();
        await settle();
        await expect(done).resolves.toBe('skipped');
    });

    it('★ 화면이 바뀌어 걷힌 것은 interrupted 다 — 다음에 다시 띄워야 한다', async () => {
        const done = runCoach([step('a')]);
        closeCoach();
        await settle();
        await expect(done).resolves.toBe('interrupted');
    });

    it('끝나면 DOM 에서 사라지고 레이어도 없다', async () => {
        const done = runCoach([step('a')]);
        nextBtn().click();
        await settle();
        await done;

        expect(document.querySelector('.coach-backdrop')).toBeNull();
        expect(hasLayer('coach')).toBe(false);
        expect(isCoachOpen()).toBe(false);
    });

    it('이미 떠 있으면 새로 열지 않는다', async () => {
        void runCoach([step('a')]);
        const second = await runCoach([step('b')]);

        expect(second).toBe('interrupted');
        expect(document.querySelectorAll('.coach-backdrop')).toHaveLength(1);
        expect(card().textContent).toContain('a 제목');
    });

    it('단계가 없으면 아무것도 띄우지 않는다', async () => {
        await expect(runCoach([])).resolves.toBe('done');
        expect(document.querySelector('.coach-backdrop')).toBeNull();
    });
});

describe('runCoach — 구멍', () => {
    it('가리킬 것이 없으면 구멍 없이 가운데에 놓는다', () => {
        void runCoach([step('a', null)]);

        expect((document.querySelector('.coach-hole') as HTMLElement).hidden).toBe(true);
        expect(card().classList.contains('coach-card--center')).toBe(true);
    });

    it('★ 구멍이 없는 단계에서는 배경이 직접 어두워진다 — 어둠은 구멍이 그리기 때문이다', () => {
        void runCoach([step('a', null)]);
        const backdrop = document.querySelector('.coach-backdrop') as HTMLElement;

        /*
         * 2026-08-31 실기기: 이게 없어서 뷰어 첫 단계에서 문서가 밝은 채로 남고
         * 말풍선만 떠 있었다. 탭은 backdrop 이 먹으니 '눌러도 안 되는 화면' 이었다.
         */
        expect(backdrop.classList.contains('coach-backdrop--dim')).toBe(true);
    });

    it('대상이 있으면 그 자리에 여백을 두고 구멍을 판다', () => {
        const el = document.createElement('button');
        document.body.appendChild(el);
        el.getBoundingClientRect = () =>
            ({ top: 100, left: 40, width: 200, height: 48, bottom: 148, right: 240 }) as DOMRect;

        void runCoach([step('a', el)]);

        const hole = document.querySelector('.coach-hole') as HTMLElement;
        expect(hole.hidden).toBe(false);
        // HOLE_PAD 6px 만큼 사방으로 넓다
        expect(hole.style.top).toBe('94px');
        expect(hole.style.left).toBe('34px');
        expect(hole.style.width).toBe('212px');
        expect(hole.style.height).toBe('60px');
        expect(card().classList.contains('coach-card--center')).toBe(false);
        // 구멍이 어둠을 그리므로 배경은 칠하지 않는다 — 둘 다 칠하면 구멍까지 덮인다.
        expect(
            (document.querySelector('.coach-backdrop') as HTMLElement).classList.contains(
                'coach-backdrop--dim',
            ),
        ).toBe(false);
    });

    it('★ 크기가 0 인 대상(숨은 화면)은 구멍을 포기한다 — 화면 구석에 점이 찍힌다', () => {
        const el = document.createElement('button');
        document.body.appendChild(el); // jsdom 이라 사각형이 전부 0 이다

        void runCoach([step('a', el)]);

        expect((document.querySelector('.coach-hole') as HTMLElement).hidden).toBe(true);
        expect(card().classList.contains('coach-card--center')).toBe(true);
    });
});
