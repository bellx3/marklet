/**
 * 키 → 동작. 메뉴가 아니라 렌더러가 키를 받는다.
 *
 * ★ 순수 함수다(DOM 을 만지지 않는다). 메뉴를 숨긴 창에서도 같은 키가 같게 동작해야 해서, 키 처리를 메뉴가 아니라
 *   여기에 둔다 — 같은 키를 두 곳이 받으면 한 번 누른 것이 두 번 일어난다.
 */

export type CommandName = 'edit' | 'save' | 'find' | 'toc' | 'source' | 'print' | 'pdf';

export type Shortcut =
    | { kind: 'command'; name: CommandName }
    | { kind: 'run'; name: 'open' | 'close' | 'quit' | 'fullscreen' }
    | { kind: 'zoom'; dir: -1 | 0 | 1 };

interface KeyLike {
    key: string;
    code?: string;
    ctrlKey: boolean;
    metaKey?: boolean;
    shiftKey: boolean;
    altKey: boolean;
    isComposing?: boolean;
}

const COMMAND_KEYS: Record<string, CommandName> = {
    e: 'edit',
    s: 'save',
    f: 'find',
    t: 'toc',
    u: 'source',
};

export function shortcutFor(e: KeyLike): Shortcut | null {
    // 한글 조합 중에는 키를 가로채지 않는다.
    if (e.isComposing) return null;

    if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        return { kind: 'run', name: 'fullscreen' };
    }

    // AltGr(= Ctrl+Alt)로 치는 글자와 겹치지 않게 Alt 가 눌려 있으면 보지 않는다.
    const ctrl = e.ctrlKey || !!e.metaKey;
    if (!ctrl || e.altKey) return null;

    const key = e.key.toLowerCase();

    // 확대 · 축소 · 원래 크기 (Shift 와 상관없이: '+' 는 Shift+'=' 이다)
    if (key === '+' || key === '=' || e.code === 'NumpadAdd') return { kind: 'zoom', dir: 1 };
    if (key === '-' || key === '_' || e.code === 'NumpadSubtract') return { kind: 'zoom', dir: -1 };
    if (key === '0' || e.code === 'Numpad0') return { kind: 'zoom', dir: 0 };

    if (key === 'p') return { kind: 'command', name: e.shiftKey ? 'pdf' : 'print' };

    // 나머지는 Shift 없이만(Ctrl+Shift+T 같은 것은 우리 것이 아니다)
    if (e.shiftKey) return null;
    if (key === 'o') return { kind: 'run', name: 'open' };
    if (key === 'w') return { kind: 'run', name: 'close' };
    if (key === 'q') return { kind: 'run', name: 'quit' };
    const name = COMMAND_KEYS[key];
    return name ? { kind: 'command', name } : null;
}
