/**
 * TipManager — 소모성 팁(후원) 인앱결제 (7-3절)
 *
 * 픽셀오아시스(비소모성 remove_ads)와 다른 점
 *   - 상품이 여러 개이고 전부 CONSUMABLE 이다
 *   - finish() 가 consume 을 부르므로 재구매가 가능하다
 *   - 소비된 거래는 재전달되지 않으므로 '복원' 개념이 없다
 *   - 다만 consume 직전에 앱이 죽으면 다음 실행에서 재전달되므로
 *     transactionId 로 중복 지급을 막는다
 */
import { Preferences } from '@capacitor/preferences';
import { Toast } from '../utils/toast';
import { t } from '../i18n';

/** Play Console 에 등록한 상품 ID. 순서가 화면 표시 순서다. */
export const TIP_PRODUCT_IDS = ['tip_coffee', 'tip_lunch', 'tip_dinner'] as const;
export type TipProductId = (typeof TIP_PRODUCT_IDS)[number];

/**
 * 화면에 쓸 이름. ★ 가격은 여기 적지 마라 — 스토어가 내려준 값만 쓴다.
 * ★ 상수가 아니라 함수다. 모듈이 평가되는 순간에는 아직 언어가 정해지지 않았다.
 */
export function tipLabel(id: TipProductId): string {
    return { tip_coffee: t.tip.coffee, tip_lunch: t.tip.lunch, tip_dinner: t.tip.dinner }[id];
}

const STORAGE_KEY = 'supporter';

interface SupporterState {
    /** 누적 후원 횟수 */
    count: number;
    /** 이미 처리한 거래 ID. consume 실패 후 재전달될 때 중복 지급을 막는다 */
    handled: string[];
}

class TipManagerClass {
    private state: SupporterState = { count: 0, handled: [] };
    private loaded = false;

    /** 사용자가 방금 buy() 로 시작한 구매인지 */
    private purchaseRequested = false;

    get isSupporter(): boolean {
        return this.state.count > 0;
    }

    get tipCount(): number {
        return this.state.count;
    }

    /** ★ 저장소가 async 이므로 init 도 async 다. */
    async init(): Promise<void> {
        await this.loadState();
        this.updateUI();

        const initializeStore = () => {
            const CdvPurchase = window.CdvPurchase;
            if (!CdvPurchase) {
                console.log('🛍️ 결제 플러그인이 없습니다 (웹 환경).');
                return;
            }

            const { store, ProductType, Platform } = CdvPurchase;
            store.verbosity = import.meta.env.DEV ? 4 : 0;

            if (!ProductType || !Platform) {
                console.error('🛍️ 결제 상수가 없습니다.');
                return;
            }

            // ★ 소모성으로 등록해야 finish() 가 consume 을 부른다.
            //   NON_CONSUMABLE 로 등록하면 acknowledge 만 되어 재후원이 막힌다.
            store.register(
                TIP_PRODUCT_IDS.map((id) => ({
                    id,
                    alias: id,
                    type: ProductType.CONSUMABLE,
                    platform: Platform.GOOGLE_PLAY,
                })),
            );

            store.ready(() => {
                const missing = TIP_PRODUCT_IDS.filter((id) => !store.get(id)?.valid);
                if (missing.length) {
                    console.error('🛍️ 상품을 받지 못했습니다:', missing.join(', '));
                    void store.update();
                }
                this.renderPrices();
            });

            store.when().approved(async (transaction) => {
                const txId = transaction.transactionId ?? '';
                const alreadyHandled = txId !== '' && this.state.handled.includes(txId);
                const userInitiated = this.purchaseRequested;
                this.purchaseRequested = false;

                // 사용자는 이미 결제를 마쳤다. 감사 표시를 먼저 반영한다.
                // consume 에 실패해도 미완결 거래는 다음 실행에 재전달되어 재시도된다.
                if (!alreadyHandled) {
                    this.state.count += 1;
                    if (txId) this.state.handled.push(txId);
                    await this.saveState();
                    this.updateUI();
                }

                try {
                    // ★ 소모성이므로 이 호출이 consumePurchase 로 간다.
                    //   부르지 않으면 자동 환불되고, 그 전까지 재구매도 막힌다.
                    await transaction.finish();
                } catch (err) {
                    console.error('🛍️ 거래 완결 실패 (다음 실행 시 재시도됩니다):', err);
                }

                if (userInitiated && !alreadyHandled) {
                    Toast.success(t.tip.thanksToast);
                }
            });

            store.error((error) => {
                // 구매가 완료되지 못했으므로 표시를 해제한다.
                // 남겨두면 다음 실행 시 재전달되는 approved 를 새 구매로 오인한다.
                this.purchaseRequested = false;

                // 6 = 사용자 취소
                if (error.code === 6) {
                    Toast.info(t.tip.cancelled);
                    return;
                }
                // 7 = ITEM_ALREADY_OWNED. 소모성인데 이게 뜨면 이전 구매가 consume 되지 않은 것이다.
                //     update() 가 미완결 거래를 다시 흘려보낸다.
                if (error.code === 7) {
                    Toast.info(t.tip.pending);
                    void window.CdvPurchase?.store.update();
                    return;
                }
                console.error(`🛍️ 결제 오류: ${error.message} (${error.code})`);
            });

            store.initialize([Platform.GOOGLE_PLAY]);

            // 초기화 직후 한 번 더 — 상품 목록 누락 방지
            setTimeout(() => void store.update(), 2000);
        };

        // Cordova 플러그인이므로 deviceready 가 필수다.
        document.addEventListener('deviceready', initializeStore, false);
    }

    async buy(productId: TipProductId): Promise<void> {
        const CdvPurchase = window.CdvPurchase;
        if (!CdvPurchase) {
            Toast.info(t.tip.appOnly);
            return;
        }

        const product = CdvPurchase.store.get(productId);
        if (!product) {
            Toast.error(t.tip.noProducts);
            void CdvPurchase.store.update();
            return;
        }

        this.purchaseRequested = true;

        try {
            // v13 권장 방식: 오퍼(Offer)를 통한 주문
            const offer = product.getOffer?.();
            if (offer?.canPurchase) {
                await offer.order();
                return;
            }
            // 폴백: 기존 ID 기반 주문
            CdvPurchase.store.order(productId);
        } catch (err) {
            this.purchaseRequested = false;
            const msg = err instanceof Error ? err.message : String(err);
            Toast.error(t.tip.requestFailed(msg));
        }
    }

    /**
     * 버튼에 스토어가 내려준 표시 가격을 채운다.
     * ★ 가격을 코드나 문구에 적지 마라. Play Console 에서 값을 바꾸는 순간 거짓이 되고,
     *   다른 통화를 쓰는 사용자에게는 처음부터 틀린 값이 보인다.
     *   (스토어 등재 설명에 가격을 쓰는 것도 정책 위반이다.)
     */
    renderPrices(): void {
        const store = window.CdvPurchase?.store;
        for (const id of TIP_PRODUCT_IDS) {
            /*
             * ★★ 필드 이름은 `price` 다. `formattedPrice` 가 아니다.
             *   플러그인의 PricingPhase 는 사람이 읽는 값을 `price` 에 담는다
             *   (store.d.ts 의 "Price formatted for humans").
             *   `formattedPrice` 는 **네이티브 브리지 쪽 이름**(formatted_price)이라
             *   JS 객체에는 없다 — 읽으면 undefined 가 되고, 그러면 아래에서
             *   '가격을 못 받았다'로 판정해 **버튼이 영원히 비활성으로 남는다.**
             *   2026-08-04 실기기에서 확인: 로그에는 ₩1,500 이 내려와 있는데
             *   화면의 후원 버튼 셋이 전부 회색이었다.
             */
            const price = store?.get(id)?.getOffer?.()?.pricingPhases?.[0]?.price ?? '';
            document.querySelectorAll(`[data-tip-price="${id}"]`).forEach((el) => {
                el.textContent = price;
            });
            // 가격을 못 받았으면 버튼을 비활성화한다. 눌러도 결제창이 안 뜨기 때문이다.
            document.querySelectorAll(`[data-tip-buy="${id}"]`).forEach((el) => {
                (el as HTMLButtonElement).disabled = price === '';
            });
        }
    }

    updateUI(): void {
        this.renderPrices();
        document.body.classList.toggle('is-supporter', this.isSupporter);
        document.querySelectorAll('[data-tip-count]').forEach((el) => {
            el.textContent = String(this.state.count);
        });
    }

    private async loadState(): Promise<void> {
        if (this.loaded) return;
        try {
            const { value } = await Preferences.get({ key: STORAGE_KEY });
            if (value) this.state = { count: 0, handled: [], ...JSON.parse(value) };
        } catch {
            // 깨졌으면 초기값 유지
        }
        this.loaded = true;
    }

    private async saveState(): Promise<void> {
        // handled 가 무한히 자라지 않게 최근 50건만 남긴다
        if (this.state.handled.length > 50) {
            this.state.handled = this.state.handled.slice(-50);
        }
        try {
            await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(this.state) });
        } catch (err) {
            console.error('후원 상태 저장 실패:', err);
        }
    }
}

export const TipManager = new TipManagerClass();
