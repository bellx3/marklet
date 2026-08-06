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

/**
 * 각 오버레이가 '닫히면 돌려줄 자리'.
 *
 * ★★ 다이얼로그가 연달아 뜰 때(확인 → 실패 알림) 두 번째가 여는 순간의 초점은
 *   **닫히는 중인 첫 번째 안**이다. 그걸 그대로 기억하면 곧 DOM 에서 사라지고,
 *   닫을 때 돌아갈 곳이 없어 초점이 body 로 떨어진다 —
 *   토크백에서는 다음 스와이프가 화면 맨 위에서 다시 시작한다.
 *   그래서 앞 오버레이가 돌려주려던 자리를 **물려받는다.**
 */
const returnTo = new WeakMap<HTMLElement, HTMLElement | null>();

const BACKDROP = '.dialog-backdrop, .sheet-backdrop';

/** 지금 초점 자리를 보고, 닫힐 오버레이 안이면 그 오버레이가 돌려주려던 곳을 쓴다. */
function resolveReturnTarget(): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const owner = active.closest<HTMLElement>(BACKDROP);
    if (owner && returnTo.has(owner)) return returnTo.get(owner) ?? null;
    return active;
}

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
        this.lastFocus = resolveReturnTarget();
        returnTo.set(this.el, this.lastFocus);

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

        /*
         * 첫 포커스 대상으로 옮긴다(10-3절).
         *
         * ★ 대상이 없어도 **바깥에 초점을 남겨 두지 않는다.** 모달인데 초점이 밖에 있으면
         *   탭 한 번으로 뒤에 가려진 버튼을 눌러 버린다. 그럴 때는 상자 자체를 잡는다 —
         *   스크린 리더도 제목부터 읽는다.
         *   (다이얼로그의 모든 갈래가 '되돌릴 수 없음'이면 실제로 대상이 없다.)
         */
        const first = this.el.querySelector<HTMLElement>('[data-autofocus]');
        if (first) {
            first.focus();
        } else {
            this.el.tabIndex = -1;
            this.el.focus();
        }

        // 탭이 상자 밖으로 나가지 않게 가둔다(아래 trapTab 주석).
        this.el.addEventListener('keydown', this.trapTab);
    }

    hide(): void {
        if (!this.opened) return;
        this.cancelTimer();
        this.opened = false;

        // ★ 애니메이션을 기다리지 않고 지금 뗀다. 기다리면 뒤로가기를 한 번 먹는다.
        removeLayer(this.name);

        this.el.classList.remove('is-open');
        this.el.setAttribute('aria-hidden', 'true');
        this.el.removeEventListener('keydown', this.trapTab);

        const finish = () => {
            this.el.hidden = true;
            this.timer = null;

            /*
             * ★★ 초점을 되돌리기 **전에 지금 초점이 어디 있는지 본다.**
             *
             *   이 함수는 닫기 애니메이션 뒤(200ms)에 늦게 돈다. 그 사이에 **다음
             *   다이얼로그가 이미 열려 있을 수 있다** — "확인 → 실패 알림" 처럼
             *   연달아 뜨는 건 이 앱에서 흔한 모양이다. 그때 무턱대고 되돌리면
             *   **새 다이얼로그에서 초점을 빼앗는다**(2026-08-06 실측):
             *       둘째 연 직후(60ms)  대화상자 안
             *       300ms 뒤            배경 버튼   ← 첫째의 타이머가 훔쳐 갔다
             *   토크백 사용자는 읽던 중에 초점이 배경으로 튀어 나가고,
             *   다이얼로그가 떠 있다는 사실 자체를 잃는다.
             *
             *   초점이 아직 우리 것(또는 body)일 때만 되돌린다.
             */
            const active = document.activeElement;
            const 우리것 = !active || active === document.body || this.el.contains(active);
            // ★ 이미 DOM 에서 빠진 자리로는 돌려보내지 않는다 — 그러면 body 로 떨어진다.
            if (우리것 && this.lastFocus?.isConnected) this.lastFocus.focus();

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

    /**
     * 탭이 상자 밖으로 나가지 않게 가둔다.
     *
     * ★★ `aria-modal="true"` 는 **스크린 리더에게만** 하는 말이다. 하드웨어 키보드
     *   (덱스·크롬북·블루투스)에서는 탭이 그대로 뒤로 넘어가서, 스크림에 가려
     *   보이지도 않는 배경 버튼을 눌러 버릴 수 있다(2026-08-06 실측: 배경에
     *   초점 받을 수 있는 것이 6개 남아 있었다).
     *
     * ★ 리스너를 document 가 아니라 **상자에** 건다. 시트 위에 다이얼로그가 겹치면
     *   document 리스너는 둘 다 반응해서 아래쪽 시트가 초점을 도로 끌어간다.
     */
    private readonly trapTab = (e: KeyboardEvent): void => {
        if (e.key !== 'Tab') return;
        const items = this.focusables();
        if (items.length === 0) {
            e.preventDefault();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;

        if (e.shiftKey && (active === first || active === this.el)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    };

    private focusables(): HTMLElement[] {
        const sel =
            'a[href], button:not([disabled]), input:not([disabled]), ' +
            'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        /*
         * ★ 크기로 거르지 마라. offsetParent 는 position:fixed 인 상자에서 null 이고,
         *   getClientRects() 는 **jsdom 에서 언제나 비어 있다** — 그러면 테스트에서는
         *   가둘 것이 하나도 없어 늘 통과한다. 실제로는 안 도는데 초록인 상태다.
         *   상자 안에 보이지 않는 초점 대상을 두지 않는 것이 우리 규칙이므로 hidden 만 본다.
         */
        return Array.from(this.el.querySelectorAll<HTMLElement>(sel)).filter(
            (el) => !el.hidden && !el.closest('[hidden]'),
        );
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
