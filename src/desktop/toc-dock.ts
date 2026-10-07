import type { Heading } from '../markdown/render-pipeline';
import { icon } from '../app/icons';
import { t } from '../i18n';

/**
 * 목차 도크 — 창 왼쪽에 붙어 문서 옆에 계속 떠 있는 목차.
 *
 * 모바일의 목차는 바닥에서 올라오는 시트라 한 번 고르면 닫힌다. 데스크톱은 화면이 넓으므로
 * 목차를 열어 둔 채 읽으며 오갈 수 있게 문서를 옆으로 밀어 자리를 만든다.
 *
 * ★ 제목이 없는 문서는 도크를 열지 않는다. 빈 도크를 여는 것보다 '제목이 없습니다' 안내를
 *   모달로 띄우는 쪽이 무슨 일인지 분명하다 — 그 판단은 부르는 쪽(main.ts)이 한다.
 */

export interface TocDockOptions {
    /** 도크가 열리면 이 요소에 `has-toc` 를 붙인다. CSS 가 문서를 밀어낸다. */
    host: HTMLElement;
    /** 제목이 들어 있는 문서 영역. 현재 위치를 따라가려고 제목 요소를 여기서 찾는다. */
    container: HTMLElement;
    onJump(id: string): void;
}

export interface TocDock {
    root: HTMLElement;
    setHeadings(headings: Heading[]): void;
    open(): void;
    close(): void;
    toggle(): void;
    /** 편집처럼 문서가 가려지는 동안 잠깐 접어 둔다. 열림 상태는 기억했다가 돌려준다. */
    suspend(on: boolean): void;
    readonly isOpen: boolean;
}

/** 이 높이 안에 들어온 가장 아래 제목이 '지금 읽는 절'이다 */
const READING_LINE_PX = 120;

export function createTocDock(opts: TocDockOptions): TocDock {
    const root = document.createElement('nav');
    root.className = 'toc-dock';
    root.setAttribute('aria-label', t.toc.title);
    root.hidden = true;

    const head = document.createElement('div');
    head.className = 'toc-dock-head';
    const title = document.createElement('span');
    title.className = 'toc-dock-title';
    title.textContent = t.toc.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn desktop-ctl';
    close.title = `${t.common.close} (Ctrl+T)`;
    close.setAttribute('aria-label', close.title);
    close.tabIndex = -1;
    close.appendChild(icon('close', 16));
    head.append(title, close);

    const list = document.createElement('div');
    list.className = 'toc-dock-list';
    root.append(head, list);

    let headings: Heading[] = [];
    let items: HTMLButtonElement[] = [];
    let open = false;
    let suspended = false;
    let activeIndex = -1;
    let raf = 0;

    function apply(): void {
        const visible = open && !suspended;
        root.hidden = !visible;
        opts.host.classList.toggle('has-toc', visible);
        // 문서 폭이 바뀐다. 표·수식 맞춤(fit-width)은 창 크기 변화에 맞춰 다시 재므로 알려 준다.
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        if (visible) track();
    }

    function setActive(i: number): void {
        if (i === activeIndex) return;
        items[activeIndex]?.classList.remove('is-active');
        items[activeIndex]?.removeAttribute('aria-current');
        activeIndex = i;
        const el = items[i];
        if (!el) return;
        el.classList.add('is-active');
        el.setAttribute('aria-current', 'location');
        // 긴 목차에서 현재 절이 도크 밖으로 나가지 않게 따라간다.
        el.scrollIntoView({ block: 'nearest' });
    }

    /**
     * 지금 읽는 절을 표시한다.
     * ★ 아직 안 붙은 청크의 제목은 DOM 에 없다. 있는 것 중에서만 찾는다 —
     *   문서를 아래로 내리면 청크가 붙으며 따라간다.
     */
    function track(): void {
        if (!open || suspended) return;
        let found = -1;
        for (let i = 0; i < headings.length; i++) {
            const el = opts.container.querySelector(`#${CSS.escape(headings[i].id)}`);
            if (!el) continue;
            if (el.getBoundingClientRect().top <= READING_LINE_PX) found = i;
            else break;
        }
        setActive(found);
    }

    window.addEventListener(
        'scroll',
        () => {
            if (!open || suspended || raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                track();
            });
        },
        { passive: true },
    );

    close.addEventListener('click', () => api.close());
    list.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
        if (!btn) return;
        opts.onJump(btn.dataset.id ?? '');
        setActive(items.indexOf(btn));
    });

    const api: TocDock = {
        root,
        setHeadings(next) {
            headings = next;
            activeIndex = -1;
            list.replaceChildren();
            items = next.map((h) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'toc-dock-item';
                b.dataset.id = h.id;
                b.dataset.level = String(h.level);
                b.textContent = h.text || t.toc.untitled;
                // 키보드 순회에 끼지 않는다 — 문서 화면의 Tab 은 아무것도 순회하지 않는다(main.ts).
                b.tabIndex = -1;
                list.appendChild(b);
                return b;
            });
            // 제목이 없으면 열어 둘 이유가 없다.
            if (next.length === 0 && open) api.close();
            else if (open) track();
        },
        open() {
            if (headings.length === 0) return;
            open = true;
            apply();
        },
        close() {
            if (!open) return;
            open = false;
            apply();
        },
        toggle() {
            if (open) api.close();
            else api.open();
        },
        suspend(on) {
            suspended = on;
            apply();
        },
        get isOpen() {
            return open;
        },
    };
    return api;
}
