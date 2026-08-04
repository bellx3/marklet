/// <reference types="vite/client" />

/**
 * tsconfig 의 "types": ["vitest/globals"] 가 기본 전역 타입 집합을 좁히므로
 * vite/client 타입(?raw 임포트, import.meta.env 등)은 이 파일로만 들어온다.
 *
 * ★ @ts-expect-error 로 때우지 마라. 7-1절의 "거래 완결 실패" 버그가 그래서 생겼다.
 */

// 공식 타입 패키지가 없는 markdown-it 플러그인들
declare module 'markdown-it-footnote';
declare module 'markdown-it-task-lists';

/** vite.config.ts 의 define 이 package.json 의 version 을 넣는다. */
declare const __APP_VERSION__: string;

/* ── cordova-plugin-purchase 13.x ───────────────────────────── */

interface CdvPurchaseOffer {
    id: string;
    canPurchase: boolean;
    order: () => Promise<void>;
    pricingPhases?: { formattedPrice: string }[];
}

interface CdvPurchaseProduct {
    id: string;
    state: string;
    title: string;
    loaded: boolean;
    valid: boolean;
    canPurchase: boolean;
    owned: boolean;
    getOffer: () => CdvPurchaseOffer | undefined;
}

/**
 * 승인된 거래
 *
 * finish() 가 Google Play 의 acknowledge(비소모성) 또는 consume(소모성)에 해당한다.
 * 완결되지 않은 구매는 자동 환불되므로 반드시 호출해야 한다.
 */
interface CdvPurchaseTransaction {
    transactionId?: string;
    /** 거래를 완결한다. 영수증 검증 서버가 없으면 이것을 직접 호출한다. */
    finish: () => Promise<void>;
    /** store.validator 를 설정한 경우에만 사용한다. 완결은 verified 이벤트에서 처리한다. */
    verify: () => Promise<void>;
}

interface CdvPurchaseGlobal {
    store: {
        verbosity: number;
        register: (
            product: { id: string; alias?: string; type: unknown; platform?: unknown } | unknown[],
        ) => void;
        get: (id: string) => CdvPurchaseProduct | undefined;
        when: () => {
            approved: (
                callback: (transaction: CdvPurchaseTransaction) => void | Promise<void>,
            ) => void;
            owned: (callback: (product: unknown) => void) => void;
            updated: (callback: (product: unknown) => void) => void;
        };
        error: (callback: (error: { code: number; message: string }) => void) => void;
        ready: (callback: () => void) => void;
        initialize: (platforms: unknown[]) => void;
        update: () => Promise<void>;
        order: (productId: string) => void;
    };
    ProductType: {
        CONSUMABLE: unknown;
        NON_CONSUMABLE: unknown;
        PAID_SUBSCRIPTION: unknown;
    };
    Platform: {
        GOOGLE_PLAY: unknown;
    };
}

interface Window {
    CdvPurchase?: CdvPurchaseGlobal;
}
