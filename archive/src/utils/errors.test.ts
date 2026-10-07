import { describe, it, expect, beforeEach } from 'vitest';
import { installErrorLog, getErrors, clearErrors } from './errors';

/**
 * 잡히지 않은 오류 수집 (12-3절 진단의 짝).
 *
 * ★★ 이게 없어서 실기기에서 본 예외 하나를 이틀에 걸쳐 34회 재현 시도하고도 못 쫓았다.
 *   릴리스에서는 console 이 지워지므로 정말로 아무 데도 안 남는다.
 */
installErrorLog();

/** 실제 이벤트를 그대로 흘린다 — 핸들러가 진짜로 붙어 있는지까지 시험한다. */
function 오류를낸다(message: string, filename = 'x.js', lineno = 1, colno = 2): void {
    const err = new Error(message);
    err.stack = `Error: ${message}\n    at 어딘가 (${filename}:${lineno}:${colno})`;
    dispatchEvent(new ErrorEvent('error', { message, filename, lineno, colno, error: err }));
}

beforeEach(() => clearErrors());

describe('잡히지 않은 오류를 남긴다', () => {
    it('예외 하나가 그대로 기록된다', () => {
        오류를낸다("Cannot read properties of null (reading 'style')", 'https://localhost/', 1, 44);

        const [e] = getErrors();
        expect(e, '아무것도 안 잡혔다 — 핸들러가 안 붙었다').toBeTruthy();
        expect(e.kind).toBe('error');
        expect(e.message).toContain('reading');
        expect(e.where, '자리를 잃으면 어디서 났는지 알 수 없다').toBe('https://localhost/:1:44');
        expect(e.stack).toContain('어딘가');
    });

    it('처리되지 않은 프라미스 거부도 남는다', () => {
        // ★ jsdom 은 PromiseRejectionEvent 를 안 준다. 같은 모양으로 만들어 흘린다.
        const ev = new Event('unhandledrejection') as Event & { reason?: unknown };
        ev.reason = new Error('거부된 이유');
        dispatchEvent(ev);

        const [e] = getErrors();
        expect(e?.kind).toBe('rejection');
        expect(e?.message).toBe('거부된 이유');
    });

    /**
     * ★★ 같은 오류가 스크롤마다 수백 번 나는 경우가 있다. 그대로 쌓으면 링버퍼가
     *   가득 차서 **다른 오류를 전부 밀어낸다** — 정작 알고 싶은 것이 사라진다.
     */
    it('같은 오류는 세기만 하고 다른 오류를 밀어내지 않는다', () => {
        for (let i = 0; i < 50; i++) 오류를낸다('같은 것', 'a.js', 1, 1);
        오류를낸다('다른 것', 'b.js', 2, 2);

        const list = getErrors();
        expect(list.length, '같은 오류가 쌓여 버퍼를 채웠다').toBe(2);
        expect(list[0].count, '같은 오류를 세지 않았다').toBe(50);
        expect(
            list.some((e) => e.message === '다른 것'),
            '나중에 난 다른 오류가 밀려났다',
        ).toBe(true);
    });

    /** ★ 이미지·스크립트 로드 실패도 'error' 로 온다. 그건 예외가 아니다. */
    it('리소스 로드 실패는 예외로 세지 않는다', () => {
        const img = document.createElement('img');
        document.body.appendChild(img);
        img.dispatchEvent(new Event('error', { bubbles: true }));
        img.remove();

        expect(getErrors().length, '리소스 실패가 섞이면 진짜 예외가 묻힌다').toBe(0);
    });

    it('버퍼가 넘쳐도 최신은 남는다', () => {
        for (let i = 0; i < 30; i++) 오류를낸다(`오류 ${i}`, `f${i}.js`, i, i);
        const list = getErrors();
        expect(list.length).toBeLessThanOrEqual(20);
        expect(list.at(-1)?.message).toBe('오류 29');
    });
});
