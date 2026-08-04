import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Overlay } from './overlay';
import { hasLayer, __resetRouterForTest, __pressBackForTest } from './router';

/**
 * 11-2절 #9.
 *
 * 회귀: hide() 안의 removeLayer 를 setTimeout 안으로 옮기면
 *   "닫는 즉시 레이어가 사라진다" 테스트가 실패하는 것을 확인함.
 *
 * 픽셀오아시스에서 실제로 난 사고: 열기는 10ms 뒤, 닫기는 300ms 뒤에 상태를 바꿨는데
 * 그 사이에 반대 동작이 들어오면 뒤늦게 터진 타이머가 새 상태를 덮어썼다.
 * 화면에는 아무것도 없는데 isOpen 이 true 라 뒤로가기 한 번을 먹었다.
 */

function makeEl(): HTMLElement {
    const el = document.createElement('div');
    el.hidden = true;
    document.body.appendChild(el);
    return el;
}

beforeEach(() => {
    __resetRouterForTest();
    vi.useFakeTimers();
});

describe('Overlay', () => {
    it('show 하면 보이고 레이어가 즉시 등록된다', () => {
        const el = makeEl();
        const o = new Overlay(el, 'sheet');
        o.show();

        expect(el.hidden).toBe(false);
        expect(el.getAttribute('aria-hidden')).toBe('false');
        // ★ 애니메이션 클래스는 나중이지만 레이어는 지금 있어야 한다
        expect(hasLayer('sheet')).toBe(true);

        vi.advanceTimersByTime(50);
        expect(el.classList.contains('is-open')).toBe(true);
    });

    it('★ hide 하면 애니메이션을 기다리지 않고 레이어가 사라진다', () => {
        const el = makeEl();
        const o = new Overlay(el, 'sheet');
        o.show();
        vi.advanceTimersByTime(50);

        o.hide();
        expect(hasLayer('sheet')).toBe(false); // 즉시
        expect(el.classList.contains('is-open')).toBe(false);
        expect(el.hidden).toBe(false); // 아직 애니메이션 중

        vi.advanceTimersByTime(300);
        expect(el.hidden).toBe(true);
    });

    it('★ show→hide→show 를 타이머가 겹치게 연속 호출해도 최종 상태가 일치한다', () => {
        const el = makeEl();
        const o = new Overlay(el, 'sheet');

        o.show();
        vi.advanceTimersByTime(5); // 열기 타이머가 아직 안 터졌다
        o.hide();
        vi.advanceTimersByTime(5); // 닫기 타이머도 아직
        o.show();
        vi.advanceTimersByTime(500); // 전부 흘려보낸다

        expect(o.isOpen).toBe(true);
        expect(el.hidden).toBe(false);
        expect(el.classList.contains('is-open')).toBe(true);
        expect(hasLayer('sheet')).toBe(true);
    });

    it('hide→show→hide 도 마찬가지다', () => {
        const el = makeEl();
        const o = new Overlay(el, 'sheet');
        o.show();
        vi.advanceTimersByTime(50);

        o.hide();
        o.show();
        o.hide();
        vi.advanceTimersByTime(500);

        expect(o.isOpen).toBe(false);
        expect(el.hidden).toBe(true);
        expect(hasLayer('sheet')).toBe(false);
    });

    it('이미 열려 있으면 show 를 무시한다 (레이어 중복 없음)', () => {
        const el = makeEl();
        const o = new Overlay(el, 'sheet');
        o.show();
        o.show();
        o.hide();
        expect(hasLayer('sheet')).toBe(false);
    });

    it('뒤로가기로 닫으면 onClosed 가 불린다', async () => {
        const el = makeEl();
        const closed = vi.fn();
        const o = new Overlay(el, 'sheet', closed);
        o.show();
        vi.advanceTimersByTime(50);

        await __pressBackForTest();
        vi.advanceTimersByTime(300);

        expect(o.isOpen).toBe(false);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('[data-autofocus] 로 포커스를 옮긴다 (10-3절)', () => {
        const el = makeEl();
        const btn = document.createElement('button');
        btn.dataset.autofocus = '';
        el.appendChild(btn);

        const o = new Overlay(el, 'sheet');
        o.show();
        expect(document.activeElement).toBe(btn);
    });
});
