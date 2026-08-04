/**
 * flush 할 수 있는 디바운스 (8-4절).
 *
 * ★ 보통의 디바운스와 다른 점은 `flush()` 다. 화면이 백그라운드로 갈 때
 *   대기 중인 호출을 **즉시** 실행할 수 있어야 한다. 이걸 못 하면
 *   홈키 한 번에 마지막 몇 백 ms 의 편집이 사라진다(픽셀오아시스 커밋 be7e44f).
 */
export interface Debounced<A extends unknown[]> {
    (...args: A): void;
    /** 대기 중인 호출이 있으면 지금 실행한다. */
    flush(): void;
    /** 대기 중인 호출을 버린다. */
    cancel(): void;
    /** 대기 중인 호출이 있는가 */
    readonly pending: boolean;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: A | null = null;

    const run = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        const args = lastArgs;
        lastArgs = null;
        if (args) fn(...args);
    };

    const wrapped = ((...args: A) => {
        lastArgs = args;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(run, ms);
    }) as Debounced<A>;

    wrapped.flush = run;
    wrapped.cancel = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        lastArgs = null;
    };
    Object.defineProperty(wrapped, 'pending', { get: () => lastArgs !== null });

    return wrapped;
}
