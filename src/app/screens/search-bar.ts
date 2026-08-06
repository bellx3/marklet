import { pushLayer, removeLayer } from '../router';
import { debounce } from '../../utils/debounce';
import {
    runSearch,
    clearSearch,
    step,
    counterLabel,
    type SearchState,
} from '../../services/doc-search';
import type { RenderHandle } from '../../markdown/render-pipeline';
import { iconButton } from '../icons';
import { t } from '../../i18n';

/**
 * T2 검색 바 — 상단 바를 덮는 인라인 바 (8-6절).
 *
 * ★ 닫히는 경로는 셋뿐이다. ① 닫기 버튼 ② 안드로이드 뒤로가기 ③ 다른 문서를 여는 것.
 *   **어느 경로로 닫혀도 clearSearch() 가 불려야 한다.** 남기면 다음 검색이 어긋난다.
 */

export interface SearchBar {
    /** 바를 연다. ★ 내부에서 renderRest() 를 기다린다 — 안 하면 문서 뒷부분이 안 잡힌다. */
    open(): Promise<void>;
    /** 열려 있으면 닫는다. 문서를 갈아탈 때 반드시 부를 것. */
    close(): void;
    get isOpen(): boolean;
    readonly root: HTMLElement;
}

export function createSearchBar(
    container: HTMLElement,
    getHandle: () => RenderHandle | null,
    /**
     * 열림/닫힘을 알린다. 부르는 쪽이 **상단 바를 감춰야 한다** —
     * ★ 검색 바는 상단 바 '아래 한 줄'이 아니라 상단 바를 **덮는** 것이다(9-1절 T2).
     *   아래에 덧붙이면 검색 중에도 편집·목차 버튼이 눌려서 오작동한다(2026-08-03 실측).
     */
    onToggle?: (open: boolean) => void,
): SearchBar {
    const root = document.createElement('div');
    root.className = 'search-bar app-topbar';
    root.hidden = true;
    root.setAttribute('role', 'search');

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-input';
    /*
     * ★ 여기는 초성 안내를 넣지 않는다. 이 바는 세는 칸과 버튼 3개를 함께 이고 있어서
     *   입력칸에 남는 폭이 120px 뿐이다(384px 화면 실측) — 넣어 봐야 잘려서 안 읽힌다.
     *   초성 검색은 시작 화면 검색창이 가르친다. 여기서도 그대로 동작한다(8-5절).
     */
    input.placeholder = t.search.placeholder;
    input.setAttribute('aria-label', t.search.label);
    // ★ maxlength 를 쓰지 마라 — 한글 IME 조합 중 글자가 씹힌다(9-5절).
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;

    const counter = document.createElement('span');
    counter.className = 'search-counter';
    counter.setAttribute('aria-live', 'polite');
    counter.textContent = '0/0';

    const prev = iconButton('up', t.search.previous, () => {
        state = step(state, -1);
        updateCounter();
    });
    const next = iconButton('down', t.search.next, () => {
        state = step(state, 1);
        updateCounter();
    });
    const close = iconButton('close', t.search.close, () => bar.close());

    root.append(input, counter, prev, next, close);

    let state: SearchState = { marks: [], current: -1, truncated: false };
    let opened = false;

    /**
     * 열기 전에 초점이 있던 자리 — 보통 상단 바의 [문서에서 찾기] 버튼이다.
     *
     * ★★ 안 돌려주면 닫는 순간 초점이 **숨겨진 검색칸에 남거나 body 로 떨어진다**
     *   (2026-08-06 실측: 닫은 뒤에도 activeElement 가 `[hidden]` 안의 입력칸이었다).
     *   토크백 사용자는 다음 스와이프가 화면 맨 위에서 다시 시작해 읽던 자리를 잃는다.
     *   시트·다이얼로그는 Overlay 가 이걸 해 주는데, 검색 바는 상단 바를 **덮는**
     *   인라인 바라 Overlay 를 쓰지 않는다 — 그래서 그 그물 밖에 있었다.
     */
    let lastFocus: HTMLElement | null = null;

    const updateCounter = () => {
        counter.textContent = counterLabel(state);
        const none = state.marks.length === 0;
        prev.disabled = none;
        next.disabled = none;
    };

    // 6번 규칙 — 매 글자마다 돌리지 않는다. 120ms 디바운스가 그 몫을 한다.
    const rerun = debounce(() => {
        state = runSearch(container, input.value);
        updateCounter();
    }, 120);

    /*
     * ★★ `if (e.isComposing) return;` 을 되돌리지 마라. 한글 검색이 **아예 안 돈다.**
     *
     *   검색창에서는 사용자가 마지막 글자를 치고 **멈춘다.** 뒤에 스페이스도 엔터도
     *   치지 않는다. 그런데 한글 IME 는 마지막 음절을 조합 상태로 열어 둔 채 기다린다 —
     *   compositionend 가 영영 안 온다. 그래서 "조합" 을 쳐도 3초가 지나도 0/0 이었다
     *   (2026-08-06 실기기, 실제 Gboard 한국어 자판으로 확인).
     *
     *   6번 규칙의 뜻은 "중간 자모마다 문서를 훑지 마라" 지 "조합 중에는 아무것도 하지
     *   마라" 가 아니다. 앞의 것은 **디바운스가 이미 한다** — 치는 동안에는 안 돌고,
     *   120ms 쉬었을 때만 돈다. 그때 칸에 있는 글자가 곧 사용자가 찾는 것이다.
     */
    input.addEventListener('input', () => rerun());
    // 조합이 끝나는 순간에도 한 번 — 확정된 글자로 즉시 반응한다.
    input.addEventListener('compositionend', () => rerun());
    input.addEventListener('keydown', (e) => {
        // ★ 조합 중인 Enter 는 가로채면 안 된다 — 한글 확정용까지 먹으면 글자가 씹힌다.
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        rerun.flush();
        state = step(state, e.shiftKey ? -1 : 1);
        updateCounter();
    });

    const bar: SearchBar = {
        root,
        get isOpen() {
            return opened;
        },
        async open() {
            if (opened) return;
            opened = true;
            lastFocus = document.activeElement as HTMLElement | null;
            root.hidden = false;
            onToggle?.(true);
            // ★ 여는 함수 안에서 동기적으로 등록한다(9-3절).
            pushLayer('search', () => {
                bar.close();
                return true;
            });
            input.value = '';
            state = { marks: [], current: -1, truncated: false };
            updateCounter();
            input.focus();

            // ★ 1번 규칙. 이걸 빼면 문서 뒷부분이 검색되지 않는다.
            await getHandle()?.renderRest();

            /*
             * ★★ 기다리는 동안 사용자는 이미 치고 있다 — 바가 뜨자마자 친다.
             *   그때 돌아간 검색은 **아직 앞부분만 붙은 DOM** 을 훑은 것이라
             *   뒷부분의 결과가 통째로 빠진 채 굳는다. 큰 문서일수록 오래 걸리므로
             *   (실기기 3.6MB 에서 renderRest 8초) 정확히 그런 문서에서만 어긋난다.
             *   사용자에게는 "검색이 안 된다" 로만 보이고 왜인지는 알 길이 없다.
             *
             *   ★ opened 를 다시 본다 — 기다리는 동안 뒤로가기로 닫혔을 수 있다.
             *     그때 훑으면 이미 걷어낸 <mark> 가 되살아난다.
             */
            if (opened && input.value) {
                rerun.cancel();
                state = runSearch(container, input.value);
                updateCounter();
            }
        },
        close() {
            if (!opened) return;
            opened = false;
            rerun.cancel();
            clearSearch(container); // ★ <mark> 를 반드시 걷어낸다
            removeLayer('search');
            root.hidden = true;
            // ★ 상단 바를 먼저 되살린다 — 그래야 [찾기] 버튼이 다시 초점을 받을 수 있다.
            onToggle?.(false);
            state = { marks: [], current: -1, truncated: false };

            /*
             * ★ 초점이 아직 검색 바 안(또는 body)일 때만 되돌린다.
             *   닫는 사이에 앱이 다른 곳으로 옮겨 놨으면 빼앗지 않는다
             *   (Overlay 에서 다이얼로그가 겹칠 때 겪은 것과 같은 함정이다).
             */
            const active = document.activeElement;
            const 우리것 = !active || active === document.body || root.contains(active);
            if (우리것 && lastFocus?.isConnected) lastFocus.focus();
            lastFocus = null;
        },
    };

    return bar;
}
