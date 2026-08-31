import { describe, it, expect, beforeEach } from 'vitest';
import { fitBlock } from './fit-width';

/**
 * jsdom 에는 레이아웃이 없다. clientWidth·scrollWidth 가 항상 0 이라 그대로 두면
 * fitBlock 은 "아직 레이아웃 전" 으로 보고 즉시 빠진다. 그래서 폭을 직접 심는다.
 *
 * scrollWidth 는 글자 크기에 비례한다고 가정한다 — 수식은 실제로 그렇게 움직이고,
 * 표는 셀이 접히면서 그보다 더 줄어든다(그쪽으로 틀리는 건 안전하다).
 */
function stub(el: HTMLElement, opts: { client: number; natural: number }): void {
    Object.defineProperty(el, 'clientWidth', { get: () => opts.client });
    Object.defineProperty(el, 'scrollWidth', {
        get: () => {
            const px = parseFloat(el.style.fontSize || '16');
            return Math.round((opts.natural * px) / 16);
        },
    });
}

function katex(natural: number, client: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'katex-display';
    document.body.appendChild(el);
    stub(el, { client, natural });
    return el;
}

beforeEach(() => {
    document.body.replaceChildren();
});

describe('fitBlock — 넓은 블록을 상자 폭에 맞춘다', () => {
    it('상자에 들어가면 손대지 않는다', () => {
        const el = katex(300, 400);
        fitBlock(el);
        expect(el.style.fontSize).toBe('');
    });

    it('넘치면 글자를 줄여 상자 안에 넣는다', () => {
        const el = katex(600, 400); // 1.5배 넓다 → 16px * (400/600) = 10.67px
        fitBlock(el);
        expect(parseFloat(el.style.fontSize)).toBeCloseTo(16 * (400 / 600), 1);
        expect(el.scrollWidth).toBeLessThanOrEqual(400);
    });

    it('★ 바닥(0.55) 아래로는 줄이지 않는다 — 남는 만큼은 가로 스크롤이 받는다', () => {
        const el = katex(4000, 400);
        fitBlock(el);
        expect(parseFloat(el.style.fontSize)).toBeCloseTo(16 * 0.55, 1);
        expect(el.scrollWidth).toBeGreaterThan(400); // 여전히 넘친다 = 스크롤이 필요하다
    });

    it('다시 부르면 원래 크기에서 새로 잰다 (회전해서 넓어지면 되돌아온다)', () => {
        const el = document.createElement('div');
        el.className = 'katex-display';
        document.body.appendChild(el);
        let client = 400;
        Object.defineProperty(el, 'clientWidth', { get: () => client });
        Object.defineProperty(el, 'scrollWidth', {
            get: () => Math.round((600 * parseFloat(el.style.fontSize || '16')) / 16),
        });

        fitBlock(el);
        expect(parseFloat(el.style.fontSize)).toBeCloseTo(16 * (400 / 600), 1);

        client = 900; // 가로 화면
        fitBlock(el);
        expect(el.style.fontSize).toBe('');
    });

    it('표는 래퍼가 아니라 안쪽 <table> 의 크기를 줄인다', () => {
        const wrap = document.createElement('div');
        wrap.className = 'table-scroll';
        const table = document.createElement('table');
        wrap.appendChild(table);
        document.body.appendChild(wrap);
        Object.defineProperty(wrap, 'clientWidth', { get: () => 400 });
        stub(table, { client: 400, natural: 600 });

        fitBlock(wrap);
        expect(wrap.style.fontSize).toBe('');
        expect(parseFloat(table.style.fontSize)).toBeCloseTo(16 * (400 / 600), 1);
    });

    it('레이아웃 전(폭 0)에는 아무것도 하지 않는다', () => {
        const el = katex(800, 0);
        fitBlock(el);
        expect(el.style.fontSize).toBe('');
    });
});
