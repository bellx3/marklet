import { describe, it, expect } from 'vitest';
import { shortcutFor } from './shortcuts';

const key = (
    k: string,
    mods: Partial<{
        ctrl: boolean;
        shift: boolean;
        alt: boolean;
        code: string;
        composing: boolean;
    }> = {},
) =>
    shortcutFor({
        key: k,
        code: mods.code,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        isComposing: mods.composing,
    });

describe('shortcutFor — 메뉴가 받던 키를 렌더러가 받는다', () => {
    it('Ctrl+글자는 메뉴에 적힌 동작으로 간다', () => {
        expect(key('o', { ctrl: true })).toEqual({ kind: 'run', name: 'open' });
        expect(key('e', { ctrl: true })).toEqual({ kind: 'command', name: 'edit' });
        expect(key('s', { ctrl: true })).toEqual({ kind: 'command', name: 'save' });
        expect(key('f', { ctrl: true })).toEqual({ kind: 'command', name: 'find' });
        expect(key('t', { ctrl: true })).toEqual({ kind: 'command', name: 'toc' });
        expect(key('u', { ctrl: true })).toEqual({ kind: 'command', name: 'source' });
        expect(key('p', { ctrl: true })).toEqual({ kind: 'command', name: 'print' });
        expect(key('w', { ctrl: true })).toEqual({ kind: 'run', name: 'close' });
        expect(key('q', { ctrl: true })).toEqual({ kind: 'run', name: 'quit' });
    });

    it('Ctrl+Shift+P 는 PDF, 대문자로 와도 같다(Shift 를 누르면 key 가 대문자다)', () => {
        expect(key('P', { ctrl: true, shift: true })).toEqual({ kind: 'command', name: 'pdf' });
    });

    it('확대는 + · = · 숫자패드 +, 축소는 - · 숫자패드 -, 0 은 원래 크기', () => {
        expect(key('=', { ctrl: true })).toEqual({ kind: 'zoom', dir: 1 });
        expect(key('+', { ctrl: true, shift: true })).toEqual({ kind: 'zoom', dir: 1 });
        expect(key('Add', { ctrl: true, code: 'NumpadAdd' })).toEqual({ kind: 'zoom', dir: 1 });
        expect(key('-', { ctrl: true })).toEqual({ kind: 'zoom', dir: -1 });
        expect(key('Subtract', { ctrl: true, code: 'NumpadSubtract' })).toEqual({
            kind: 'zoom',
            dir: -1,
        });
        expect(key('0', { ctrl: true })).toEqual({ kind: 'zoom', dir: 0 });
    });

    it('F11 은 전체 화면', () => {
        expect(key('F11')).toEqual({ kind: 'run', name: 'fullscreen' });
    });

    it('★ Ctrl 없이 친 글자는 가로채지 않는다 — 편집기에 글을 쳐야 한다', () => {
        for (const k of ['o', 'e', 's', 'f', 't', 'u', 'p', 'w', 'q', '0', '+', '-']) {
            expect(key(k), k).toBeNull();
        }
    });

    it('★ Alt 가 같이 눌린 것(AltGr 로 치는 글자)은 가로채지 않는다', () => {
        expect(key('e', { ctrl: true, alt: true })).toBeNull();
        expect(key('f', { ctrl: true, alt: true })).toBeNull();
    });

    it('Shift 가 낀 다른 조합(Ctrl+Shift+T 등)은 우리 것이 아니다', () => {
        for (const k of ['o', 'e', 's', 'f', 't', 'u', 'w', 'q']) {
            expect(key(k.toUpperCase(), { ctrl: true, shift: true }), k).toBeNull();
        }
    });

    it('한글 조합 중에는 아무것도 가로채지 않는다', () => {
        expect(key('s', { ctrl: true, composing: true })).toBeNull();
        expect(key('F11', { composing: true })).toBeNull();
    });

    it('모르는 키는 null', () => {
        expect(key('x', { ctrl: true })).toBeNull();
        expect(key('Enter', { ctrl: true })).toBeNull();
    });
});
