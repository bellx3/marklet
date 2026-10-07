/**
 * 앱 안에서 그리는 드롭다운 메뉴 — 케밥 버튼과 우클릭이 같이 쓴다.
 *
 * ★ 윈도우 기본(네이티브) 메뉴를 쓰지 않는 이유: 기본 메뉴는 OS 의 것처럼 보여서 이게 Marklet 의
 *   기능인지 헷갈린다. 모양을 우리가 정하려면 직접 그려야 한다(Electron 은 네이티브 메뉴를 꾸미지 못한다).
 * ★ 글을 치는 곳(편집기·검색 입력)의 우클릭은 네이티브 그대로 둔다 — 붙여넣기 · 맞춤법 같은 것이 거기 있다.
 */

export interface MenuItem {
    label: string;
    /** 오른쪽에 흐리게 적는 단축키 */
    shortcut?: string;
    disabled?: boolean;
    onSelect(): void;
}
export type MenuEntry = MenuItem | 'separator';

export interface PopupMenu {
    /** 마우스 자리(x, y) 또는 버튼 아래(오른쪽 맞춤)에 연다 */
    open(entries: MenuEntry[], at: { x: number; y: number } | { below: HTMLElement }): void;
    close(): void;
    readonly isOpen: boolean;
}

const EDGE = 8;

export function createPopupMenu(): PopupMenu {
    let el: HTMLElement | null = null;
    let opener: Element | null = null;

    const items = (): HTMLButtonElement[] =>
        el ? [...el.querySelectorAll<HTMLButtonElement>('button.mk-menu-item:not(:disabled)')] : [];

    function close(): void {
        if (!el) return;
        el.remove();
        el = null;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('resize', close);
        window.removeEventListener('wheel', close, true);
        (opener as HTMLElement | null)?.blur?.();
        opener = null;
    }
    function onOutside(e: Event): void {
        const target = e.target as Element;
        // 열어 준 버튼(컨트롤)을 누르는 것은 그 버튼의 토글이 맡는다. 여기서 닫으면 곧바로 다시 열린다.
        if (el && !el.contains(target) && !target.closest?.('.desktop-controls')) close();
    }
    function onKey(e: KeyboardEvent): void {
        if (!el) return;
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        const go = (n: number) => {
            e.preventDefault();
            e.stopPropagation();
            list[(n + list.length) % list.length]?.focus();
        };
        switch (e.key) {
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                close();
                break;
            case 'ArrowDown':
                go(i + 1);
                break;
            case 'ArrowUp':
                go(i < 0 ? list.length - 1 : i - 1);
                break;
            case 'Home':
                go(0);
                break;
            case 'End':
                go(list.length - 1);
                break;
            case 'Tab':
                // 메뉴 안에서 Tab 은 아무 데도 가지 않고 메뉴를 닫는다(문서 화면의 Tab 규칙과 같다).
                e.preventDefault();
                e.stopPropagation();
                close();
                break;
        }
    }

    function open(
        entries: MenuEntry[],
        at: { x: number; y: number } | { below: HTMLElement },
    ): void {
        close();
        opener = document.activeElement;
        const menu = document.createElement('div');
        menu.className = 'mk-menu';
        menu.setAttribute('role', 'menu');
        for (const entry of entries) {
            if (entry === 'separator') {
                const hr = document.createElement('div');
                hr.className = 'mk-menu-sep';
                hr.setAttribute('role', 'separator');
                menu.appendChild(hr);
                continue;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mk-menu-item';
            b.setAttribute('role', 'menuitem');
            b.tabIndex = -1;
            b.disabled = !!entry.disabled;
            const label = document.createElement('span');
            label.textContent = entry.label;
            b.appendChild(label);
            if (entry.shortcut) {
                const k = document.createElement('kbd');
                k.textContent = entry.shortcut;
                b.appendChild(k);
            }
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                close();
                entry.onSelect();
            });
            b.addEventListener('mouseenter', () => b.focus());
            menu.appendChild(b);
        }
        // 오른쪽 클릭이 메뉴 위에서 또 네이티브 메뉴를 띄우지 않게
        menu.addEventListener('contextmenu', (e) => e.preventDefault());
        document.body.appendChild(menu);
        el = menu;

        // 위치: 화면 안으로 들어오게 누른다.
        const w = menu.offsetWidth;
        const h = menu.offsetHeight;
        let x: number;
        let y: number;
        if ('below' in at) {
            const r = at.below.getBoundingClientRect();
            x = r.right - w;
            y = r.bottom + 6;
        } else {
            x = at.x;
            y = at.y;
        }
        x = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE));
        y = Math.max(EDGE, Math.min(y, window.innerHeight - h - EDGE));
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', close);
        window.addEventListener('resize', close);
        window.addEventListener('wheel', close, { capture: true, passive: true });
        // 처음엔 아무 항목도 강조하지 않는다(마우스로 연 메뉴에 선택이 미리 걸려 보이면 안 된다). 화살표가 첫 항목으로 간다.
        menu.tabIndex = -1;
        menu.focus();
    }

    return {
        open,
        close,
        get isOpen() {
            return !!el;
        },
    };
}
