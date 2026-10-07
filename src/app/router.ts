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

    /*
     * ★★ 새 레이어가 얹혔으면 연타 잠금을 푼다. **다이얼로그가 뒤로가기를 죽였다.**
     *
     *   busy 는 "연타로 두 개가 한꺼번에 닫히는 것"을 막으려고 둔 것인데,
     *   핸들러가 **사용자 입력을 기다리면** 그 시간 내내 잠긴 채로 있었다:
     *       편집 중 뒤로가기 → "저장하지 않은 편집이 있습니다" 확인 상자
     *       → 그 상자를 뒤로가기로 닫으려 하면 **아무 반응이 없다**
     *   안드로이드에서 뒤로가기가 안 먹는 것은 사용자가 앱을 의심하는 신호다.
     *
     *   레이어가 새로 얹혔다는 건 화면이 앞으로 나아갔다는 뜻이고,
     *   앞선 뒤로가기는 이미 제 몫을 다했다. 다음 누름은 새 레이어가 받아야 한다.
     */
    busy = false;
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

/**
 * 뒤로가기 한 번. **네이티브·브라우저·테스트가 전부 이 함수를 쓴다.**
 *
 * ★★ 예전에는 세 곳이 각자 for 문을 들고 있었고, **연타 잠금은 네이티브 쪽에만** 있었다.
 *   즉 잠금이 만드는 문제(위 pushLayer 주석)는 개발 중에도 테스트에서도
 *   한 번도 돌지 않는 코드였다. 갈래를 나누면 갈라진 쪽이 시험되지 않는다.
 *
 * @returns 처리한 레이어 이름. 아무도 처리하지 않았으면 null (부르는 쪽이 앱을 닫는다).
 */
async function handleBack(): Promise<string | null> {
    // 연타로 두 개가 동시에 닫히는 것을 막는다.
    if (busy) return null;
    busy = true;
    try {
        for (let i = stack.length - 1; i >= 0; i--) {
            /*
             * ★ 핸들러가 스택을 줄인다(거의 항상 자기 레이어를 뗀다).
             *   인덱스가 빈 자리를 가리키면 건너뛴다 — 안 그러면 여기서 터지고
             *   그 뒤로 뒤로가기가 통째로 죽는다.
             * ★ 이름을 **먼저** 잡는다. 부른 뒤에 stack[i] 를 읽으면 이미 없거나 남의 것이다.
             */
            const layer = stack[i];
            if (!layer) continue;
            const { name } = layer;
            if (await layer.onBack()) return name;
        }
        return null;
    } finally {
        busy = false;
    }
}

export function initRouter(): void {
    if (removeListener) return;
    void App.addListener('backButton', () => {
        void (async () => {
            /*
             * ★ 잠겨서 아무것도 못 했을 때(busy)와 아무도 처리하지 않았을 때를
             *   구분해야 한다. 구분하지 않으면 **연타 두 번째가 앱을 닫아 버린다.**
             */
            if (busy) return;
            if ((await handleBack()) === null) await App.exitApp();
        })();
    })
        .then((h) => {
            removeListener = () => void h.remove();
        })
        .catch(() => {
            // 브라우저(npm run dev)에는 네이티브가 없다. Esc 로 대신 흉내 낸다.
            // ★ 앱을 닫지는 않는다 — 탭을 닫아 버리면 개발이 안 된다.
            const onKey = (e: KeyboardEvent) => {
                if (e.key !== 'Escape' || stack.length === 0) return;
                void handleBack();
            };
            document.addEventListener('keydown', onKey);
            removeListener = () => document.removeEventListener('keydown', onKey);
        });
}

/**
 * 뒤로가기 한 번. 데스크톱의 Esc 가 이것이다(src/desktop/main.ts).
 * ★ 새 갈래를 만들지 않고 handleBack 을 그대로 부른다 — 위 주석의 이유와 같다.
 */
export function pressBack(): Promise<string | null> {
    return handleBack();
}

/** 테스트 전용 */
export function __resetRouterForTest(): void {
    stack.length = 0;
    busy = false;
    removeListener?.();
    removeListener = null;
}

/**
 * 테스트 전용 — 뒤로가기 한 번을 흉내 낸다. 처리한 레이어 이름을 돌려준다.
 * ★ 실제와 **같은 함수**를 부른다. 여기서 for 문을 따로 들고 있으면
 *   연타 잠금 같은 것이 테스트에서 영영 돌지 않는다(handleBack 주석).
 */
export function __pressBackForTest(): Promise<string | null> {
    return handleBack();
}
