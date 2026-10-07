import { icon } from '../app/icons';
import { t } from '../i18n';

/**
 * 떠오르는 컨트롤 — 읽는 동안에는 보이지 않고, 필요할 때만 나타난다.
 *
 * 사진 뷰어의 방식이다. 두 가지로 열린다.
 *   1) 마우스를 움직이면 나타났다가 잠시 뒤 스스로 사라진다.
 *   2) 본문을 한 번 탭(클릭)하면 **고정되어** 열린다. 다시 탭하면 닫힌다.
 *
 * ★ 상시 표시하지 않는 이유: 이 앱의 목표는 '문서만 보이는 화면'이다. 컨트롤은 그 화면을
 *   발견 가능하게 하되 해치지 않는 선까지만 둔다. 메뉴(Alt)와 우클릭 메뉴가 전체 목록의 기준이고,
 *   여기는 거기로 닿는 길과 단축키를 알려 주는 자리다.
 */

export interface ControlsOptions {
    onEdit(): void;
    onToc(): void;
    onFind(): void;
    onTheme(): void;
    onMore(): void;
    /** 지금은 띄우면 안 되는가(검색 바 · 목차 시트가 열려 있을 때). 그 위를 덮으면 안 된다. */
    suppressed(): boolean;
}

export interface Controls {
    root: HTMLElement;
    /** 문서가 있어야 의미가 있다. 없으면 어떤 입력에도 나타나지 않는다. */
    setActive(on: boolean): void;
    /** 편집 중에는 목차·찾기가 가리킬 문서 화면이 없다. 끄고, 편집 버튼은 눌린 모양으로 둔다. */
    setEditing(on: boolean): void;
    hide(): void;
    readonly visible: boolean;
}

/** 마우스가 멈춘 뒤 사라지기까지. 너무 짧으면 누르기 전에 사라지고, 길면 본문을 가린다. */
export const IDLE_MS = 2500;
/** 더블클릭(낱말 선택)의 첫 클릭이 탭으로 오인되지 않게 기다리는 시간 */
const DOUBLE_CLICK_MS = 250;
/** 이만큼 움직여야 '움직였다'고 본다. 스크롤·레이아웃 때문에 오는 가짜 mousemove 를 거른다. */
const MOVE_PX = 3;

/** 탭해도 토글하지 않는 자리. 이미 자기 일이 있는 것들이다. */
const INTERACTIVE = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    '.desktop-controls',
    '.search-bar',
    '.sheet-backdrop',
    '.dialog-backdrop',
    '.mermaid-block',
    '.md-image-placeholder',
].join(',');

export function createControls(opts: ControlsOptions): Controls {
    const root = document.createElement('div');
    root.className = 'desktop-controls';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', t.viewer.more);

    // 이름 + 단축키. title 이 마우스를 올렸을 때의 툴팁이고, aria-label 은 같은 글을 읽어 준다.
    /**
     * @param closeAfter 누른 뒤 컨트롤을 거둔다. 목차·찾기는 **그 자리를 덮는 것**(시트·검색 바)을 열기
     *   때문에 컨트롤이 남아 있으면 검색 바의 닫기 버튼 위에 겹친다. 테마는 결과를 바로 보며 계속
     *   누를 수 있게 남겨 둔다.
     */
    const make = (
        name: 'pencil' | 'list' | 'search' | 'moon' | 'more',
        tip: string,
        fn: () => void,
        closeAfter: boolean,
    ) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn desktop-ctl';
        // Tab 순회에 끼지 않는다. 읽는 화면에서 Tab 이 보이지 않는 버튼을 돌며 컨트롤을 띄우면 안 된다.
        b.tabIndex = -1;
        b.title = tip;
        b.setAttribute('aria-label', tip);
        b.appendChild(icon(name, 18));
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
            if (closeAfter) hide();
        });
        return b;
    };

    const edit = make('pencil', `${t.viewer.edit} (Ctrl+E)`, opts.onEdit, true);
    edit.setAttribute('aria-pressed', 'false');
    const toc = make('list', `${t.viewer.toc} (Ctrl+T)`, opts.onToc, true);
    const find = make('search', `${t.viewer.find} (Ctrl+F)`, opts.onFind, true);
    root.append(
        edit,
        toc,
        find,
        make('moon', t.view.theme, opts.onTheme, false),
        make('more', t.viewer.more, opts.onMore, true),
    );

    let active = false;
    let shown = false;
    let pinned = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    let lastX = -1;
    let lastY = -1;

    function render(): void {
        root.classList.toggle('is-shown', shown);
    }
    function clearIdle(): void {
        if (idle !== null) clearTimeout(idle);
        idle = null;
    }
    function show(autoHide: boolean): void {
        if (!active || opts.suppressed()) return;
        shown = true;
        render();
        clearIdle();
        if (autoHide && !pinned) idle = setTimeout(hide, IDLE_MS);
    }
    function hide(): void {
        clearIdle();
        shown = false;
        pinned = false;
        render();
    }

    /*
     * 마우스 이동. ★ 위치가 실제로 바뀐 것만 센다. Chromium 은 스크롤이나 레이아웃이 바뀔 때
     * 포인터가 가만히 있어도 mousemove 를 쏜다 — 그걸 받으면 문서를 스크롤할 때마다 컨트롤이
     * 떠올라 읽기를 방해한다.
     */
    window.addEventListener('mousemove', (e) => {
        const moved = Math.abs(e.screenX - lastX) + Math.abs(e.screenY - lastY) >= MOVE_PX;
        lastX = e.screenX;
        lastY = e.screenY;
        if (!moved) return;
        // 고정돼 있으면 그대로 둔다(탭이 연 것은 탭이 닫는다).
        if (pinned) return;
        show(true);
    });

    // 컨트롤 위에 마우스가 있는 동안은 사라지지 않는다. 누르려는 순간에 사라지면 안 된다.
    root.addEventListener('mouseenter', clearIdle);
    root.addEventListener('mouseleave', () => {
        if (shown && !pinned) idle = setTimeout(hide, IDLE_MS);
    });
    // 키보드로 Tab 해서 들어온 경우도 보여야 한다. 안 보이는 버튼에 초점이 가면 안 된다.
    root.addEventListener('focusin', () => show(false));

    /*
     * 탭 = 열고 닫기. 이미지 뷰어와 같다.
     * ★ 링크·버튼·검색 바 같은 자기 일이 있는 것, 그리고 **글자를 드래그해 고른 직후**는 탭이 아니다.
     * ★ 더블클릭은 낱말 선택이다. 첫 클릭에서 바로 토글하면 컨트롤이 깜빡이므로 잠시 기다렸다가
     *   두 번째 클릭이 오면 취소한다.
     */
    document.addEventListener('click', (e) => {
        if (!active) return;
        if (e.detail > 1) {
            if (tapTimer !== null) clearTimeout(tapTimer);
            tapTimer = null;
            return;
        }
        const el = e.target as Element | null;
        if (!el || el.closest(INTERACTIVE)) return;
        if (!document.getSelection()?.isCollapsed) return;

        if (tapTimer !== null) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
            tapTimer = null;
            if (opts.suppressed()) return;
            if (shown) {
                hide();
            } else {
                pinned = true;
                show(false);
            }
        }, DOUBLE_CLICK_MS);
    });

    // Esc 는 닫는다. (목차·찾기를 닫는 Esc 와 같은 키라 한 번에 정리된다.)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && shown) hide();
    });

    return {
        root,
        setActive(on) {
            active = on;
            if (!on) hide();
        },
        setEditing(on) {
            edit.setAttribute('aria-pressed', String(on));
            edit.classList.toggle('is-on', on);
            toc.disabled = on;
            find.disabled = on;
        },
        hide,
        get visible() {
            return shown;
        },
    };
}
