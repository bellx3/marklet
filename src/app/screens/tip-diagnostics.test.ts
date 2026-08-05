import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * S5 후원 화면 · 진단 화면.
 *
 * ★★ 후원 화면에서 지킬 것은 **가격을 코드에 적지 않는 것**이다.
 *   Play Console 에서 값을 바꾸는 순간 코드에 적은 가격은 거짓이 되고,
 *   다른 통화를 쓰는 사용자에게는 처음부터 틀린 값이 보인다 — 정책 위반이기도 하다.
 *   그래서 화면은 빈 칸만 만들고 스토어가 내려준 값을 TipManager 가 채운다.
 */

const h = vi.hoisted(() => ({
    prices: {} as Record<string, string>,
    tipCount: 0,
    bought: [] as string[],
    samples: [] as Array<{ name: string; ms: number; at: number }>,
    cleared: 0,
    copied: [] as string[],
    clipboardFails: { value: false },
}));

vi.mock('../../services/tip-manager', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../services/tip-manager')>();
    return {
        TIP_PRODUCT_IDS: real.TIP_PRODUCT_IDS,
        tipLabel: real.tipLabel,
        TipManager: {
            get tipCount() {
                return h.tipCount;
            },
            get isSupporter() {
                return h.tipCount > 0;
            },
            buy: async (id: string) => {
                h.bought.push(id);
            },
            // 진짜 renderPrices 가 하는 일을 그대로 흉내 낸다 —
            // 값이 없으면 버튼을 잠그는 것까지.
            renderPrices: () => {
                for (const id of real.TIP_PRODUCT_IDS) {
                    const price = h.prices[id] ?? '';
                    document.querySelectorAll(`[data-tip-price="${id}"]`).forEach((el) => {
                        el.textContent = price;
                    });
                    document.querySelectorAll(`[data-tip-buy="${id}"]`).forEach((el) => {
                        (el as HTMLButtonElement).disabled = price === '';
                    });
                }
            },
        },
    };
});

vi.mock('../../utils/perf', () => ({
    getSamples: () => h.samples,
    clearSamples: () => {
        h.cleared += 1;
        h.samples.length = 0;
    },
}));

import { createTipScreen } from './tip';
import { createDiagnostics } from './diagnostics';
import { TIP_PRODUCT_IDS, tipLabel } from '../../services/tip-manager';
import { t } from '../../i18n';

beforeEach(() => {
    h.prices = {};
    h.tipCount = 0;
    h.bought.length = 0;
    h.samples.length = 0;
    h.cleared = 0;
    h.copied.length = 0;
    h.clipboardFails.value = false;

    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            writeText: async (s: string) => {
                if (h.clipboardFails.value) throw new Error('권한 없음');
                h.copied.push(s);
            },
        },
    });
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('후원 화면', () => {
    function mount() {
        const screen = createTipScreen(() => {});
        document.body.appendChild(screen.root);
        return screen;
    }

    function buyButtons(): HTMLButtonElement[] {
        return [...document.querySelectorAll<HTMLButtonElement>('[data-tip-buy]')];
    }

    it('상품 수만큼 버튼을 만든다', () => {
        mount();
        expect(buyButtons()).toHaveLength(TIP_PRODUCT_IDS.length);
        expect(buyButtons().map((b) => b.dataset.tipBuy)).toEqual([...TIP_PRODUCT_IDS]);
    });

    it('★ 가격을 코드에 적지 않는다 — 빈 칸만 만든다', () => {
        mount();
        const prices = [...document.querySelectorAll('[data-tip-price]')].map((e) => e.textContent);
        expect(prices).toEqual(TIP_PRODUCT_IDS.map(() => ''));

        // 화면 어디에도 통화 기호나 숫자가 박혀 있으면 안 된다.
        const text = document.querySelector('.tip-list')!.textContent ?? '';
        expect(text).not.toMatch(/[₩$€]|\d/);
    });

    it('★ 가격을 못 받으면 버튼이 잠긴 채로 있다', () => {
        const screen = mount();
        screen.refresh(); // 스토어가 아무것도 안 내려줬다

        // 눌러도 결제창이 안 뜨므로 잠가 둔다.
        expect(buyButtons().every((b) => b.disabled)).toBe(true);
    });

    it('스토어가 값을 내려주면 그 값을 그대로 보여 주고 버튼을 푼다', () => {
        const screen = mount();
        for (const id of TIP_PRODUCT_IDS) h.prices[id] = '₩1,500';
        screen.refresh();

        expect(
            [...document.querySelectorAll('[data-tip-price]')].map((e) => e.textContent),
        ).toEqual(TIP_PRODUCT_IDS.map(() => '₩1,500'));
        expect(buyButtons().every((b) => b.disabled)).toBe(false);
    });

    it('일부만 내려와도 그 버튼만 풀린다', () => {
        const screen = mount();
        h.prices[TIP_PRODUCT_IDS[0]] = '₩1,500';
        screen.refresh();

        expect(buyButtons()[0].disabled).toBe(false);
        expect(buyButtons()[1].disabled).toBe(true);
    });

    it('누르면 그 상품을 산다', () => {
        const screen = mount();
        for (const id of TIP_PRODUCT_IDS) h.prices[id] = '₩1,500';
        screen.refresh();

        buyButtons()[1].click();
        expect(h.bought).toEqual([TIP_PRODUCT_IDS[1]]);
    });

    it('상품 이름을 사람이 읽는 말로 붙인다', () => {
        mount();
        expect([...document.querySelectorAll('.tip-label')].map((e) => e.textContent)).toEqual(
            TIP_PRODUCT_IDS.map((id) => tipLabel(id)),
        );
    });

    it('후원 전에는 감사 문구를 감춘다', () => {
        const screen = mount();
        screen.refresh();
        expect(document.querySelector<HTMLElement>('.tip-thanks')!.hidden).toBe(true);
    });

    it('후원했으면 횟수를 세어 인사한다', () => {
        const screen = mount();
        h.tipCount = 3;
        screen.refresh();

        const thanks = document.querySelector<HTMLElement>('.tip-thanks')!;
        expect(thanks.hidden).toBe(false);
        expect(thanks.textContent).toBe(t.tip.thanks(3));
    });

    it('★ 기기를 바꾸면 표시가 사라진다고 미리 말한다', () => {
        mount();
        // 소모성 상품이라 복원이 없다. 안 말하면 결제가 사라졌다고 느낀다(출시 3-6절).
        expect(document.querySelector('.setting-hint')?.textContent).toBe(t.tip.note);
    });
});

describe('진단 화면 (12-3절)', () => {
    function mount() {
        const screen = createDiagnostics(() => {});
        document.body.appendChild(screen.root);
        return screen;
    }

    it('계측값이 없으면 그렇게 말한다', () => {
        const screen = mount();
        screen.refresh();
        expect(document.querySelector('.list-empty')?.textContent).toBe(t.diagnostics.empty);
    });

    it('최신이 위로 온다', () => {
        h.samples.push(
            { name: 'doc:parse', ms: 12.34, at: 1_700_000_000_000 },
            { name: 'doc:complete', ms: 56.7, at: 1_700_000_001_000 },
        );
        const screen = mount();
        screen.refresh();

        expect([...document.querySelectorAll('.diag-name')].map((e) => e.textContent)).toEqual([
            'doc:complete',
            'doc:parse',
        ]);
    });

    it('밀리초를 소수 한 자리로 적는다', () => {
        h.samples.push({ name: 'doc:parse', ms: 12.345, at: 1_700_000_000_000 });
        const screen = mount();
        screen.refresh();
        expect(document.querySelector('.diag-ms')?.textContent).toBe('12.3 ms');
    });

    it('★ 시각에 언어를 박아 두지 않는다', () => {
        h.samples.push({ name: 'doc:parse', ms: 1, at: 1_700_000_000_000 });
        const screen = mount();
        screen.refresh();

        /*
         * ★★ 'ko-KR' 을 박아 두면 영어로 쓰는 사람에게 "오후 3:04:12" 가 나온다.
         *   i18n/index.ts 가 이미 금지한 것이고 폴더 정렬은 지키고 있었는데
         *   여기만 어긋나 있었다(2026-08-05).
         */
        const shown = document.querySelector('.diag-at')!.textContent!;
        const expected = new Date(1_700_000_000_000).toLocaleTimeString('en-US');
        expect(shown).toBe(expected);
        expect(shown).not.toMatch(/오전|오후/);
    });

    it('비우기를 누르면 비우고 다시 그린다', () => {
        h.samples.push({ name: 'doc:parse', ms: 1, at: 1 });
        const screen = mount();
        screen.refresh();

        [...document.querySelectorAll<HTMLButtonElement>('.home-actions .btn')]
            .find((b) => b.textContent === t.diagnostics.clear)!
            .click();

        expect(h.cleared).toBe(1);
        expect(document.querySelector('.list-empty')?.textContent).toBe(t.diagnostics.empty);
    });

    it('복사에는 버전과 기기 정보가 함께 들어간다', async () => {
        h.samples.push({ name: 'doc:parse', ms: 1, at: 1_700_000_000_000 });
        const screen = mount();
        screen.refresh();

        [...document.querySelectorAll<HTMLButtonElement>('.home-actions .btn')]
            .find((b) => b.textContent === t.diagnostics.copy)!
            .click();
        await Promise.resolve();
        await Promise.resolve();

        // 문의를 받았을 때 이 한 덩이만 있으면 되도록 한다.
        expect(h.copied[0]).toMatch(/^Marklet \d+\.\d+\.\d+/);
        expect(h.copied[0]).toContain(navigator.userAgent);
        expect(h.copied[0]).toContain('doc:parse');
    });

    it('★ 클립보드를 못 쓰면 화면에 펼쳐 준다', async () => {
        h.clipboardFails.value = true;
        h.samples.push({ name: 'doc:parse', ms: 1, at: 1_700_000_000_000 });
        const screen = mount();
        screen.refresh();

        [...document.querySelectorAll<HTMLButtonElement>('.home-actions .btn')]
            .find((b) => b.textContent === t.diagnostics.copy)!
            .click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // 출구를 반드시 남긴다 — 못 복사했다고만 하면 문의할 방법이 없어진다.
        const pre = document.querySelector('pre.md-plain');
        expect(pre, '복사 실패했는데 펼쳐 주지도 않았다').not.toBeNull();
        expect(pre!.textContent).toContain('doc:parse');
    });
});
