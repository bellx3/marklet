import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from './debounce';

/**
 * flush 할 수 있는 디바운스 (8-4절).
 *
 * ★★ 이건 편의 함수가 아니라 **초안 저장의 바닥**이다.
 *   여기가 어긋나면 사용자가 친 글이 사라지거나, 지운 초안이 되살아난다.
 *   실제로 둘 다 겪었다 — 초안 되살아남은 2026-08-05 에 clearDraft 쪽에서 잡았다.
 */
describe('debounce', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('마지막 호출만 한 번 실행한다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d('a');
        d('b');
        d('c');
        expect(fn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledOnce();
        expect(fn).toHaveBeenCalledWith('c');
    });

    it('시간이 덜 지나면 실행하지 않는다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d('a');
        vi.advanceTimersByTime(99);
        expect(fn).not.toHaveBeenCalled();
    });

    it('★ flush 는 대기 중인 것을 지금 실행한다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 5000);

        d('쓰던 글');
        d.flush();

        // ★ 홈키 한 번에 마지막 몇 백 ms 의 편집이 사라지면 안 된다.
        expect(fn).toHaveBeenCalledWith('쓰던 글');
    });

    it('flush 뒤에는 타이머가 다시 터지지 않는다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d('a');
        d.flush();
        vi.advanceTimersByTime(500);

        // 두 번 쓰면 같은 내용을 두 번 저장한다.
        expect(fn).toHaveBeenCalledOnce();
    });

    it('★ 대기 중인 것이 없으면 flush 는 아무것도 안 한다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d.flush();
        d.flush();

        /*
         * ★★ 편집기를 닫을 때마다 flushDraft() 가 불린다.
         *   여기서 헛호출이 나가면 **방금 지운 초안이 되살아난다.**
         */
        expect(fn).not.toHaveBeenCalled();
    });

    it('flush 를 두 번 해도 한 번만 나간다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d('a');
        d.flush();
        d.flush();

        expect(fn).toHaveBeenCalledOnce();
    });

    it('★ cancel 은 대기 중인 것을 버린다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d('지울 초안');
        d.cancel();
        vi.advanceTimersByTime(500);

        /*
         * ★★ 초안을 지우기 전에 이걸 안 부르면, 지운 직후에 대기 중이던 쓰기가
         *   터져서 **지운 초안이 되살아난다**(2026-08-05 실제 버그).
         */
        expect(fn).not.toHaveBeenCalled();
    });

    it('cancel 뒤에 flush 해도 되살아나지 않는다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d('지울 초안');
        d.cancel();
        d.flush();

        expect(fn).not.toHaveBeenCalled();
    });

    it('cancel 뒤에도 다시 쓸 수 있다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        d('버릴 것');
        d.cancel();
        d('새로 쓴 것');
        vi.advanceTimersByTime(100);

        expect(fn).toHaveBeenCalledOnce();
        expect(fn).toHaveBeenCalledWith('새로 쓴 것');
    });

    it('pending 이 실제 상태를 말한다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);

        expect(d.pending).toBe(false);
        d('a');
        expect(d.pending).toBe(true);

        vi.advanceTimersByTime(100);
        expect(d.pending).toBe(false);

        d('b');
        d.cancel();
        expect(d.pending).toBe(false);

        d('c');
        d.flush();
        expect(d.pending).toBe(false);
    });

    it('인자를 여러 개 그대로 넘긴다', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d('content://a', '본문');
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledWith('content://a', '본문');
    });
});
