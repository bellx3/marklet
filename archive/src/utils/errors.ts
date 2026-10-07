/**
 * 잡히지 않은 오류를 남긴다 (12-3절 진단의 짝).
 *
 * ★★★ 왜 필요한가 (2026-08-07).
 *   이 앱에는 전역 오류 수집이 **아예 없었다.** 잡히지 않은 예외는 흔적 없이 사라진다 —
 *   릴리스에서는 console 도 지워지므로 정말로 아무 데도 안 남는다.
 *   그래서 실기기에서 본 `Uncaught TypeError: Cannot read properties of null
 *   (reading 'style')` 을 이틀에 걸쳐 34회 재현 시도하고도 못 쫓았다.
 *   화면이 멀쩡해 보이는 종류의 오류는 사용자도 신고하지 않는다 —
 *   **아무도 모르는 채로 계속 난다.**
 *
 *   진단 화면은 "문의를 받았을 때 물어볼 게 있게" 하려고 있는 것인데,
 *   정작 가장 물어볼 값어치가 큰 것이 빠져 있었다.
 *
 * ★ 여기서 화면에 무엇을 띄우지 않는다. 잡히지 않은 오류가 곧 '사용자가 볼 사고' 는
 *   아니다(대개 화면은 멀쩡하다). 놀래키지 말고 조용히 적어 두었다가,
 *   문의가 올 때 진단 화면에서 함께 보낸다.
 *
 * ★★ 사용자 글을 여기에 담지 마라. 메시지에 파일 이름·URI 가 섞여 올 수는 있는데
 *   그건 진단 화면에 **그대로 보이고** 사용자가 보고 나서 복사한다. 본문은 절대 안 담는다.
 */

export interface ErrorEntry {
    /** 'error' = 잡히지 않은 예외, 'rejection' = 처리되지 않은 프라미스 거부 */
    kind: 'error' | 'rejection';
    message: string;
    /**
     * 'file:line:col'.
     *
     * ★★ `https://localhost/:1:NN` 은 **파일이 아니라 문자열로 평가된 코드**다.
     *   출처가 셋 중 하나다 —
     *     ① Capacitor 가 플러그인 콜백을 evaluateJavascript 로 밀어 넣은 것
     *     ② 개발 중 CDP(Runtime.evaluate)로 우리가 넣은 진단 코드
     *     ③ 웹뷰가 주입하는 것
     *   ②는 사용자 기기에서는 있을 수 없다. 그러나 **개발자가 조사하는 동안에는 흔하고**,
     *   그래서 어제 본 `:1:44` 의 null.style 이 앱 것인지 우리 진단 코드 것인지
     *   끝내 가르지 못했다(일부러 낸 대조 오류가 `:1:43` 으로 똑같이 찍혔다).
     *   자리만 보고 앱 버그로 단정하지 마라. 스택이 함께 남았는지부터 봐라.
     */
    where: string;
    /** 스택 앞부분. 없을 수도 있다(리스너 안에서 난 것). */
    stack: string;
    /** 같은 자리에서 몇 번 났는가. 1 이면 화면에 숫자를 붙이지 않는다. */
    count: number;
    /** 마지막으로 난 시각 */
    at: number;
}

/** 링버퍼. 오래된 것부터 밀어낸다 — 부팅 때 한 번 나는 오류를 잃지 않으려고 넉넉히 둔다. */
const MAX_ENTRIES = 20;
const entries: ErrorEntry[] = [];

/**
 * 같은 오류가 스크롤마다 수백 번 나는 경우가 있다. 같은 자리면 세기만 한다.
 *
 * ★★ 그대로 쌓으면 링버퍼가 가득 차서 **다른 오류를 전부 밀어낸다** —
 *   정작 알고 싶은 것이 사라진다.
 *
 * ★ 셈을 message 에 덧붙이지 마라. 그러면 다음번 키가 달라져 중복 제거가 깨진다
 *   (2026-08-07, 이 파일의 첫 판이 실제로 그랬고 테스트가 잡았다).
 *   숫자는 화면에서 붙인다.
 */
const byKey = new Map<string, ErrorEntry>();

const keyOf = (e: ErrorEntry): string => `${e.kind}|${e.message}|${e.where}`;

function push(e: ErrorEntry): void {
    const key = keyOf(e);
    const 이미 = byKey.get(key);
    if (이미) {
        이미.count += 1;
        이미.at = e.at;
        return;
    }
    byKey.set(key, e);
    entries.push(e);
    if (entries.length > MAX_ENTRIES) {
        const 밀린 = entries.shift();
        if (밀린) byKey.delete(keyOf(밀린));
    }
}

function trimStack(stack: string | undefined): string {
    if (!stack) return '';
    return stack.split('\n').slice(0, 4).join('\n').slice(0, 400);
}

let installed = false;

export function installErrorLog(): void {
    if (installed) return;
    installed = true;

    addEventListener('error', (ev) => {
        // ★ 이미지·스크립트 로드 실패도 error 로 온다. 그건 예외가 아니라 리소스다 —
        //   ev.error 가 없고 target 이 요소다. 둘을 섞으면 진짜 예외가 묻힌다.
        if (!(ev instanceof ErrorEvent)) return;
        push({
            kind: 'error',
            message: String(ev.message ?? '(메시지 없음)').slice(0, 200),
            where: `${ev.filename || '(모름)'}:${ev.lineno ?? '?'}:${ev.colno ?? '?'}`,
            stack: trimStack(ev.error?.stack),
            count: 1,
            at: Date.now(),
        });
    });

    addEventListener('unhandledrejection', (ev) => {
        const r = (ev as PromiseRejectionEvent).reason;
        const err = r instanceof Error ? r : undefined;
        push({
            kind: 'rejection',
            message: String(err?.message ?? r ?? '(이유 없음)').slice(0, 200),
            where: '(프라미스)',
            stack: trimStack(err?.stack),
            count: 1,
            at: Date.now(),
        });
    });
}

export function getErrors(): readonly ErrorEntry[] {
    return entries;
}

export function clearErrors(): void {
    entries.length = 0;
    byKey.clear();
}
