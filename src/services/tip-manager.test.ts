import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * 11-2절 #15 ~ #18.
 *
 * ★ 이 목의 형태는 node_modules/cordova-plugin-purchase 의 타입 정의를 열어 확인하고 만들었다.
 *   문서만 보고 만들지 마라(11-1절 3번) — 픽셀오아시스에서 목이 버그 있는 API 형태를
 *   흉내내는 바람에 돈이 자동 환불되는 동안 CI 는 초록불이었다.
 *
 * 회귀: TipManager 의 `await transaction.finish()` 를 지우면 #15 가 실패하는 것을 확인함.
 */

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
        },
    },
}));

const toast = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
vi.mock('../utils/toast', () => ({ Toast: { ...toast } }));

type Approved = (t: CdvPurchaseTransaction) => void | Promise<void>;

function setupStore(): {
    approve: (t: CdvPurchaseTransaction) => Promise<void>;
    registered: unknown[];
    mockStore: CdvPurchaseGlobal['store'];
    raiseError: (e: { code: number; message: string }) => void;
} {
    let approvedCallback: Approved | undefined;
    let errorCallback: ((e: { code: number; message: string }) => void) | undefined;
    const registered: unknown[] = [];
    let readyCallback: (() => void) | undefined;

    const chain = {
        approved: vi.fn((cb: Approved) => {
            approvedCallback = cb;
            return chain;
        }),
        owned: vi.fn(() => chain),
        updated: vi.fn(() => chain),
    };

    const mockStore = {
        verbosity: 0,
        register: vi.fn((arg: unknown) => {
            registered.push(arg);
        }),
        get: vi.fn(() => ({
            id: 'tip_coffee',
            state: 'valid',
            title: '커피 한 잔',
            loaded: true,
            valid: true,
            canPurchase: true,
            owned: false,
            getOffer: () => ({
                id: 'o',
                canPurchase: true,
                order: vi.fn(async () => {}),
                // ★ 필드 이름은 `price` 다. 아래 '진짜 플러그인과 맞는가' 테스트가 지킨다.
                pricingPhases: [{ price: '₩1,200' }],
            }),
        })),
        when: vi.fn(() => chain),
        error: vi.fn((cb: (e: { code: number; message: string }) => void) => {
            errorCallback = cb;
        }),
        ready: vi.fn((cb: () => void) => {
            readyCallback = cb;
        }),
        initialize: vi.fn(() => readyCallback?.()),
        update: vi.fn(async () => {}),
        order: vi.fn(),
    } as unknown as CdvPurchaseGlobal['store'];

    window.CdvPurchase = {
        store: mockStore,
        ProductType: { CONSUMABLE: 'consumable', NON_CONSUMABLE: 'non', PAID_SUBSCRIPTION: 'sub' },
        Platform: { GOOGLE_PLAY: 'google' },
    };

    return {
        registered,
        mockStore,
        approve: async (t) => {
            await approvedCallback?.(t);
        },
        raiseError: (e) => errorCallback?.(e),
    };
}

/** deviceready 를 기다리므로 init() 뒤에 이벤트를 쏘아 준다. */
async function initTipManager(): Promise<void> {
    const { TipManager } = await import('./tip-manager');
    await TipManager.init();
    document.dispatchEvent(new Event('deviceready'));
}

beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.resetModules();
    delete window.CdvPurchase;
});

describe('TipManager — 소모성 팁', () => {
    it('★ store.register 에 넘긴 type 이 CONSUMABLE 이다 (아니면 재후원이 통째로 막힌다)', async () => {
        const s = setupStore();
        await initTipManager();

        const products = s.registered[0] as Array<{ id: string; type: unknown }>;
        expect(Array.isArray(products)).toBe(true);
        expect(products.map((p) => p.id)).toEqual(['tip_coffee', 'tip_lunch', 'tip_dinner']);
        for (const p of products) expect(p.type).toBe('consumable');
    });

    it('★ 승인된 거래에 finish() 가 정확히 1회 호출된다 (7-1절 그 버그)', async () => {
        const s = setupStore();
        const { TipManager } = await import('./tip-manager');
        await TipManager.init();
        document.dispatchEvent(new Event('deviceready'));

        const finish = vi.fn(async () => {});
        await s.approve({ transactionId: 'tx-1', finish, verify: async () => {} });

        expect(finish).toHaveBeenCalledTimes(1);
        expect(TipManager.tipCount).toBe(1);
        expect(TipManager.isSupporter).toBe(true);
    });

    it('★ finish() 가 reject 해도 후원 횟수는 유지된다 (사용자는 이미 결제했다)', async () => {
        const s = setupStore();
        const { TipManager } = await import('./tip-manager');
        await TipManager.init();
        document.dispatchEvent(new Event('deviceready'));

        await s.approve({
            transactionId: 'tx-2',
            finish: vi.fn(async () => {
                throw new Error('consume 실패');
            }),
            verify: async () => {},
        });

        expect(TipManager.tipCount).toBe(1);
    });

    it('★ 같은 transactionId 가 두 번 오면 횟수가 두 번 오르지 않는다', async () => {
        const s = setupStore();
        const { TipManager } = await import('./tip-manager');
        await TipManager.init();
        document.dispatchEvent(new Event('deviceready'));

        const t = {
            transactionId: 'tx-same',
            finish: vi.fn(async () => {}),
            verify: async () => {},
        };
        await s.approve(t);
        await s.approve(t); // consume 실패 후 재전달

        expect(TipManager.tipCount).toBe(1);
        // 다만 finish 는 재시도되어야 한다 — 완결되지 않으면 자동 환불된다
        expect(t.finish).toHaveBeenCalledTimes(2);
    });

    it('다른 거래는 각각 센다', async () => {
        const s = setupStore();
        const { TipManager } = await import('./tip-manager');
        await TipManager.init();
        document.dispatchEvent(new Event('deviceready'));

        await s.approve({ transactionId: 'a', finish: async () => {}, verify: async () => {} });
        await s.approve({ transactionId: 'b', finish: async () => {}, verify: async () => {} });

        expect(TipManager.tipCount).toBe(2);
    });

    it('사용자 취소(code 6)는 오류가 아니라 안내다', async () => {
        const s = setupStore();
        await initTipManager();
        s.raiseError({ code: 6, message: 'cancelled' });
        expect(toast.info).toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('ITEM_ALREADY_OWNED(code 7)면 update() 로 미완결 거래를 흘려보낸다', async () => {
        const s = setupStore();
        await initTipManager();
        s.raiseError({ code: 7, message: 'already owned' });
        expect(s.mockStore.update).toHaveBeenCalled();
    });

    it('가격은 스토어가 준 값만 쓰고, 없으면 버튼을 잠근다', async () => {
        const s = setupStore();
        const btn = document.createElement('button');
        btn.dataset.tipBuy = 'tip_coffee';
        const price = document.createElement('span');
        price.dataset.tipPrice = 'tip_coffee';
        document.body.append(btn, price);

        await initTipManager();
        const { TipManager } = await import('./tip-manager');
        TipManager.renderPrices();

        expect(price.textContent).toBe('₩1,200');
        expect(btn.disabled).toBe(false);

        // 가격을 못 받은 상태
        (s.mockStore.get as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
        TipManager.renderPrices();
        expect(price.textContent).toBe('');
        expect(btn.disabled).toBe(true);
    });

    it('결제 플러그인이 없으면(웹) 조용히 안내만 한다', async () => {
        const { TipManager } = await import('./tip-manager');
        await TipManager.init();
        await TipManager.buy('tip_coffee');
        expect(toast.info).toHaveBeenCalled();
    });
});

/**
 * ★★ 목이 진짜 플러그인과 어긋나지 않았는지 **설치된 타입 정의를 직접 읽어** 확인한다.
 *
 * 2026-08-04에 이걸로 실제 사고가 났다. `vite-env.d.ts` 가 가격 필드를
 * `formattedPrice` 로 잘못 선언했고, 목도 같은 이름으로 맞춰져 있어서
 * **테스트는 초록불인데 실기기에서는 후원 버튼 셋이 영원히 비활성**이었다.
 * 로그에는 ₩1,500 이 멀쩡히 내려와 있었다.
 *
 * 손으로 쓴 타입은 이렇게 원본과 대조하지 않으면 **잘못된 코드를 지켜 주는 쪽**으로 굳는다.
 */
describe('★ 손으로 쓴 타입이 진짜 플러그인과 맞는가', () => {
    const dts = readFileSync(
        join(process.cwd(), 'node_modules/cordova-plugin-purchase/www/store.d.ts'),
        'utf8',
    );

    /** `interface PricingPhase { ... }` 본문만 떼어 낸다. */
    const pricingPhase = /interface PricingPhase \{([\s\S]*?)\n {4}\}/.exec(dts)?.[1] ?? '';

    it('PricingPhase 를 찾을 수 있다 (플러그인 구조가 바뀌면 여기서 먼저 깨진다)', () => {
        expect(pricingPhase).not.toBe('');
    });

    it('사람이 읽는 가격 필드 이름은 price 다', () => {
        expect(pricingPhase).toMatch(/^\s*price:\s*string;/m);
    });

    it('formattedPrice 라는 필드는 없다', () => {
        expect(pricingPhase).not.toContain('formattedPrice');
    });

    it('우리 선언도 같은 이름을 쓴다', () => {
        const ours = readFileSync(join(process.cwd(), 'src/vite-env.d.ts'), 'utf8');
        const block = /interface CdvPurchasePricingPhase \{([\s\S]*?)\n\}/.exec(ours)?.[1] ?? '';
        expect(block).toMatch(/price:\s*string;/);
        expect(block).not.toMatch(/formattedPrice\s*:/);
    });
});
