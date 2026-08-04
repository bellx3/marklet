import { pushLayer, removeLayer } from './router';
import { prefersReducedMotion } from './screens/viewer';
import { icon } from './icons';
import { t } from '../i18n';

/**
 * 시트/모달 공통 (9-4절).
 *
 * ★ 픽셀오아시스에서 실제로 겪은 사고를 처음부터 막는 구조다. 열기는 10ms 뒤 클래스를
 *   붙이고 닫기는 300ms 뒤 display:none 을 걸었는데, 그 사이에 반대 동작이 들어오면
 *   뒤늦게 터진 타이머가 새 상태를 덮어썼다. 그때 화면에는 아무것도 없는데 isOpen 이
 *   true 라 안드로이드 뒤로가기 한 번을 잡아먹었다.
 *
 * ★ hidden 속성을 상태의 단일 소스로 쓴다. 컴포넌트 CSS 가 display 를 지정하면
 *   UA 의 [hidden]{display:none} 을 이기므로 utilities.css 에 강제 규칙을 두고
 *   **가장 마지막에 import 한다**(11-3절).
 */

const OPEN_DELAY_MS = 10;
const CLOSE_DELAY_MS = 200;

export class Overlay {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private opened = false;
    private lastFocus: HTMLElement | null = null;

    constructor(
        private readonly el: HTMLElement,
        private readonly name: string,
        private readonly onClosed?: () => void,
    ) {}

    get isOpen(): boolean {
        return this.opened;
    }

    show(): void {
        if (this.opened) return;
        this.cancelTimer(); // ★ 반대 동작의 타이머를 반드시 취소한다
        this.opened = true;
        this.lastFocus = document.activeElement as HTMLElement | null;

        this.el.hidden = false;
        this.el.setAttribute('aria-hidden', 'false');

        // ★ 여는 함수 안에서 동기적으로 등록한다.
        pushLayer(this.name, () => {
            this.hide();
            return true;
        });

        if (prefersReducedMotion()) {
            this.el.classList.add('is-open');
        } else {
            this.timer = setTimeout(() => {
                this.el.classList.add('is-open');
                this.timer = null;
            }, OPEN_DELAY_MS);
        }

        // 첫 포커스 대상으로 옮긴다(10-3절)
        this.el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }

    hide(): void {
        if (!this.opened) return;
        this.cancelTimer();
        this.opened = false;

        // ★ 애니메이션을 기다리지 않고 지금 뗀다. 기다리면 뒤로가기를 한 번 먹는다.
        removeLayer(this.name);

        this.el.classList.remove('is-open');
        this.el.setAttribute('aria-hidden', 'true');

        const finish = () => {
            this.el.hidden = true;
            this.timer = null;
            this.lastFocus?.focus();
            this.onClosed?.();
        };

        if (prefersReducedMotion()) finish();
        else this.timer = setTimeout(finish, CLOSE_DELAY_MS);
    }

    private cancelTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

/**
 * 바닥 시트를 만든다. 제목 + 내용 + (선택) 닫기 버튼.
 * 돌려주는 el 은 아직 DOM 에 없다 — 부르는 쪽이 #overlay-root 에 붙인다.
 */
export function createSheet(opts: {
    title: string;
    /** aria 용 고유 접두사 */
    id: string;
}): { root: HTMLElement; body: HTMLElement; titleEl: HTMLElement } {
    const root = document.createElement('div');
    root.className = 'sheet-backdrop';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', `${opts.id}-title`);

    const sheet = document.createElement('div');
    sheet.className = 'sheet';

    const head = document.createElement('div');
    head.className = 'sheet-head';

    const titleEl = document.createElement('h2');
    titleEl.className = 'sheet-title';
    titleEl.id = `${opts.id}-title`;
    titleEl.textContent = opts.title;

    // ★ 닫는 일은 시트마다 다르므로 여기서 핸들러를 달지 않는다.
    //   부르는 쪽이 [data-act="close"] 를 위임으로 받는다(toc-sheet · view-sheet).
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.setAttribute('aria-label', t.common.close);
    close.appendChild(icon('close'));
    close.dataset.act = 'close';

    head.append(titleEl, close);

    const body = document.createElement('div');
    body.className = 'sheet-body';

    sheet.append(head, body);
    root.appendChild(sheet);

    return { root, body, titleEl };
}
