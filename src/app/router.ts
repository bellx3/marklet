import { App } from '@capacitor/app';

/**
 * 뒤로가기 스택 (9-3절).
 *
 * ★ backButton 리스너를 붙이면 Capacitor 의 기본 동작(웹뷰 히스토리 뒤로/앱 종료)이
 *   전부 우리 책임이 된다. 아래 for 문이 끝까지 갔을 때 exitApp 을 부르는 이유다.
 */

/** true 를 돌려주면 "내가 처리했다"는 뜻이고 더 아래로 내려가지 않는다. */
export type BackHandler = () => boolean | Promise<boolean>;

interface Layer {
    name: string;
    onBack: BackHandler;
}

const stack: Layer[] = [];
let busy = false;
let removeListener: (() => void) | null = null;

/**
 * 레이어를 얹는다. 오버레이를 '여는 함수' 안에서 동기적으로 불러야 한다.
 * 애니메이션이 끝난 뒤에 부르면 그 사이 뒤로가기가 아래 레이어로 새어 나간다.
 */
export function pushLayer(name: string, onBack: BackHandler): void {
    removeLayer(name); // 중복 등록 방지
    stack.push({ name, onBack });
}

/**
 * 레이어를 뗀다. 오버레이를 '닫기 시작하는 순간' 동기적으로 불러야 한다.
 * ★ 애니메이션(예: 300ms 페이드)이 끝난 뒤에 떼면, 그 사이의 뒤로가기 한 번을
 *   이미 화면에 없는 오버레이가 잡아먹는다. 픽셀오아시스 커밋 13195dc 가 그 사고다.
 */
export function removeLayer(name: string): void {
    const i = stack.findIndex((l) => l.name === name);
    if (i >= 0) stack.splice(i, 1);
}

export function hasLayer(name: string): boolean {
    return stack.some((l) => l.name === name);
}

export function initRouter(): void {
    if (removeListener) return;
    void App.addListener('backButton', () => {
        // 연타로 두 개가 동시에 닫히는 것을 막는다.
        if (busy) return;
        busy = true;
        void (async () => {
            try {
                for (let i = stack.length - 1; i >= 0; i--) {
                    // ★ 핸들러가 스택을 줄인다(거의 항상 자기 레이어를 뗀다).
                    //   인덱스가 빈 자리를 가리키면 건너뛴다 — 안 그러면 여기서 터지고
                    //   그 뒤로 뒤로가기가 통째로 죽는다.
                    const layer = stack[i];
                    if (!layer) continue;
                    if (await layer.onBack()) return;
                }
                await App.exitApp();
            } finally {
                busy = false;
            }
        })();
    })
        .then((h) => {
            removeListener = () => void h.remove();
        })
        .catch(() => {
            // 브라우저(npm run dev)에는 네이티브가 없다. Esc 로 대신 흉내 낸다.
            const onKey = (e: KeyboardEvent) => {
                if (e.key !== 'Escape' || stack.length === 0) return;
                void (async () => {
                    for (let i = stack.length - 1; i >= 0; i--) {
                        if (await stack[i].onBack()) return;
                    }
                })();
            };
            document.addEventListener('keydown', onKey);
            removeListener = () => document.removeEventListener('keydown', onKey);
        });
}

/** 테스트 전용 */
export function __resetRouterForTest(): void {
    stack.length = 0;
    busy = false;
    removeListener?.();
    removeListener = null;
}

/** 테스트 전용 — 뒤로가기 한 번을 흉내 낸다. 처리한 레이어 이름을 돌려준다. */
export async function __pressBackForTest(): Promise<string | null> {
    for (let i = stack.length - 1; i >= 0; i--) {
        const layer = stack[i];
        if (!layer) continue;
        // ★ 이름을 **먼저** 잡는다. 핸들러는 거의 항상 자기 레이어를 떼므로
        //   부른 뒤에 stack[i] 를 읽으면 이미 없거나 남의 것이다.
        const { name } = layer;
        if (await layer.onBack()) return name;
    }
    return null;
}
