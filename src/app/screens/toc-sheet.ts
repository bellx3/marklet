import { Overlay, createSheet } from '../overlay';
import { t } from '../../i18n';
import type { Heading, RenderHandle } from '../../markdown/render-pipeline';
import { jumpToAnchor } from './viewer';

/**
 * T1 목차 시트.
 *
 * ★ 헤딩 항목의 행 높이를 48px 아래로 내리지 마라(10-1절).
 *   계층은 들여쓰기로 표현하고 높이는 유지한다.
 */
export interface TocSheet {
    open(headings: Heading[]): void;
    close(): void;
    destroy(): void;
}

export function createTocSheet(
    container: HTMLElement,
    getHandle: () => RenderHandle | null,
): TocSheet {
    const { root, body } = createSheet({ title: t.toc.title, id: 'toc' });
    (document.querySelector('#overlay-root') ?? document.body).appendChild(root);

    const overlay = new Overlay(root, 'toc');

    root.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t === root || t.closest('[data-act="close"]')) overlay.hide();
    });

    return {
        open(headings) {
            body.replaceChildren();

            if (headings.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'sheet-empty';
                empty.textContent = t.toc.empty;
                body.appendChild(empty);
            }

            headings.forEach((h, i) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'list-item toc-item';
                item.dataset.level = String(h.level);
                item.textContent = h.text || t.toc.untitled;
                if (i === 0) item.dataset.autofocus = '';
                item.addEventListener('click', () => {
                    overlay.hide();
                    if (h.id) void jumpToAnchor(h.id, container, getHandle());
                });
                body.appendChild(item);
            });

            overlay.show();
        },
        close: () => overlay.hide(),
        destroy() {
            overlay.hide();
            root.remove();
        },
    };
}
